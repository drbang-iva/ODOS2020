import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const SCHEMA_LEDGER_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
);
const COMMERCIAL_SCHEMA_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-18-commercial-engine-schema.sql", import.meta.url),
);

export const PACKAGE_REFUND_POLICIES = [
  "non_refundable",
  "store_credit_only",
  "prorated_cash",
] as const;

export type PackageRefundPolicy = (typeof PACKAGE_REFUND_POLICIES)[number];
export type PackageLedgerEntryType = "deposit" | "consumption" | "adjustment" | "expiry";

export interface PackageDefinition {
  id: string;
  name: string;
  eligibleProcedureTypeCodes: string[];
  sessionCount: number;
  priceCents: number;
  expiryDays: number;
  refundPolicy: PackageRefundPolicy;
  active: boolean;
  soldCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PackageDefinitionDraft {
  id?: string;
  name: string;
  eligibleProcedureTypeCodes: string[];
  sessionCount: number;
  priceCents: number;
  expiryDays?: number;
  refundPolicy?: PackageRefundPolicy;
}

export interface PackageLedgerEntry {
  id: string;
  entryType: PackageLedgerEntryType;
  sessionsDelta: number;
  actorUserId: string;
  reason?: string;
  linkedFhirInvoiceId?: string;
  linkedFhirProcedureId?: string;
  createdAt: string;
}

export interface PatientPackageInstance {
  id: string;
  patientFhirId: string;
  definitionId: string;
  name: string;
  eligibleProcedureTypeCodes: string[];
  sessionCount: number;
  priceCents: number;
  expiryDate: string;
  refundPolicy: PackageRefundPolicy;
  sourceSaleInvoiceId: string;
  remainingSessions: number;
  createdAt: string;
  ledger: PackageLedgerEntry[];
}

export interface PackageRedemptionOperation {
  procedureFhirId: string;
  patientFhirId: string;
  packageInstanceId: string;
  chargeItemFhirId: string;
  amountCents: number;
  invoiceFhirId?: string;
  paymentFhirId?: string;
  completedAt?: string;
  createdAt: string;
}

export interface CommercialEngineStore {
  listDefinitions(options?: { includeArchived?: boolean }): Promise<PackageDefinition[]>;
  getDefinition(id: string): Promise<PackageDefinition | undefined>;
  saveDefinition(draft: PackageDefinitionDraft): Promise<PackageDefinition>;
  archiveDefinition(id: string): Promise<PackageDefinition | undefined>;
  listPatientPackages(patientFhirId: string): Promise<PatientPackageInstance[]>;
  finalizeSale(input: {
    definitionId: string;
    patientFhirId: string;
    sourceSaleInvoiceId: string;
    actorUserId: string;
    soldAt: string;
    snapshotName: string;
    snapshotEligibleProcedureTypeCodes: readonly string[];
    snapshotSessionCount: number;
    snapshotPriceCents: number;
    snapshotExpiryDays: number;
    snapshotRefundPolicy: PackageRefundPolicy;
  }): Promise<PatientPackageInstance>;
  getRedemption(procedureFhirId: string): Promise<PackageRedemptionOperation | undefined>;
  beginRedemption(input: {
    procedureFhirId: string;
    patientFhirId: string;
    packageInstanceId: string;
    chargeItemFhirId: string;
    amountCents: number;
    createdAt: string;
  }): Promise<PackageRedemptionOperation>;
  recordRedemptionInvoice(procedureFhirId: string, invoiceFhirId: string): Promise<PackageRedemptionOperation>;
  recordRedemptionPayment(procedureFhirId: string, paymentFhirId: string): Promise<PackageRedemptionOperation>;
  consume(input: {
    packageInstanceId: string;
    patientFhirId: string;
    procedureTypeCodes: readonly string[];
    linkedFhirInvoiceId: string;
    linkedFhirProcedureId: string;
    actorUserId: string;
    consumedAt: string;
  }): Promise<PatientPackageInstance>;
}

export class PgCommercialEngineStore implements CommercialEngineStore {
  private readonly pool: Pick<Pool, "connect" | "query" | "end">;
  private schemaReady?: Promise<void>;

  constructor(options: { postgresUrl?: string; pool?: Pick<Pool, "connect" | "query" | "end"> } = {}) {
    this.pool = options.pool ?? new Pool({
      connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
      max: 4,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listDefinitions(options: { includeArchived?: boolean } = {}): Promise<PackageDefinition[]> {
    await this.ensureSchema();
    const result = await this.pool.query<PackageDefinitionRow>(`
      SELECT d.*, count(i.id)::text AS sold_count
      FROM odos_package_definitions d
      LEFT JOIN odos_package_instances i ON i.definition_id = d.id
      ${options.includeArchived ? "" : "WHERE d.active = true"}
      GROUP BY d.id
      ORDER BY d.active DESC, lower(d.name), d.created_at
    `);
    return result.rows.map(definitionFromRow);
  }

  async getDefinition(id: string): Promise<PackageDefinition | undefined> {
    await this.ensureSchema();
    const result = await this.pool.query<PackageDefinitionRow>(`
      SELECT d.*, count(i.id)::text AS sold_count
      FROM odos_package_definitions d
      LEFT JOIN odos_package_instances i ON i.definition_id = d.id
      WHERE d.id = $1
      GROUP BY d.id
    `, [id]);
    return result.rows[0] ? definitionFromRow(result.rows[0]) : undefined;
  }

  async saveDefinition(draft: PackageDefinitionDraft): Promise<PackageDefinition> {
    validateDefinitionDraft(draft);
    await this.ensureSchema();
    const id = draft.id ?? randomUUID();
    if (draft.id) {
      const result = await this.pool.query<PackageDefinitionRow>(`
        UPDATE odos_package_definitions
        SET name = $2,
            eligible_procedure_type_codes = $3,
            session_count = $4,
            price_cents = $5,
            expiry_days = $6,
            refund_policy = $7,
            updated_at = now()
        WHERE id = $1 AND active = true
        RETURNING *, '0'::text AS sold_count
      `, definitionValues(id, draft));
      if (!result.rows[0]) throw new CommercialEngineConflictError("Archived package definitions cannot be edited.");
    } else {
      await this.pool.query(`
        INSERT INTO odos_package_definitions (
          id, name, eligible_procedure_type_codes, session_count, price_cents, expiry_days, refund_policy
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, definitionValues(id, draft));
    }
    return (await this.getDefinition(id))!;
  }

  async archiveDefinition(id: string): Promise<PackageDefinition | undefined> {
    await this.ensureSchema();
    const result = await this.pool.query(`
      UPDATE odos_package_definitions
      SET active = false, updated_at = now()
      WHERE id = $1
      RETURNING id
    `, [id]);
    return result.rowCount ? this.getDefinition(id) : undefined;
  }

  async listPatientPackages(patientFhirId: string): Promise<PatientPackageInstance[]> {
    assertFhirId(patientFhirId, "Patient id");
    await this.ensureSchema();
    return this.listPatientPackagesWith(this.pool, patientFhirId);
  }

  async getRedemption(procedureFhirId: string): Promise<PackageRedemptionOperation | undefined> {
    assertFhirId(procedureFhirId, "Procedure id");
    await this.ensureSchema();
    const result = await this.pool.query<PackageRedemptionRow>(
      "SELECT * FROM odos_package_redemptions WHERE procedure_fhir_id = $1",
      [procedureFhirId],
    );
    return result.rows[0] ? redemptionFromRow(result.rows[0]) : undefined;
  }

  async beginRedemption(input: {
    procedureFhirId: string;
    patientFhirId: string;
    packageInstanceId: string;
    chargeItemFhirId: string;
    amountCents: number;
    createdAt: string;
  }): Promise<PackageRedemptionOperation> {
    assertFhirId(input.procedureFhirId, "Procedure id");
    assertFhirId(input.patientFhirId, "Patient id");
    assertFhirId(input.chargeItemFhirId, "ChargeItem id");
    assertPositiveInteger(input.amountCents, "Redemption amount");
    assertInstant(input.createdAt, "Redemption timestamp");
    await this.ensureSchema();
    await this.pool.query(`
      INSERT INTO odos_package_redemptions (
        procedure_fhir_id, patient_fhir_id, package_instance_id, charge_item_fhir_id,
        amount_cents, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (procedure_fhir_id) DO NOTHING
    `, [
      input.procedureFhirId,
      input.patientFhirId,
      input.packageInstanceId,
      input.chargeItemFhirId,
      input.amountCents,
      input.createdAt,
    ]);
    const operation = await this.getRedemption(input.procedureFhirId);
    if (!operation
      || operation.patientFhirId !== input.patientFhirId
      || operation.packageInstanceId !== input.packageInstanceId
      || operation.chargeItemFhirId !== input.chargeItemFhirId
      || operation.amountCents !== input.amountCents) {
      throw new CommercialEngineConflictError("This procedure already has a different package redemption operation.");
    }
    return operation;
  }

  async recordRedemptionInvoice(
    procedureFhirId: string,
    invoiceFhirId: string,
  ): Promise<PackageRedemptionOperation> {
    return this.recordRedemptionReference(procedureFhirId, "invoice_fhir_id", invoiceFhirId);
  }

  async recordRedemptionPayment(
    procedureFhirId: string,
    paymentFhirId: string,
  ): Promise<PackageRedemptionOperation> {
    return this.recordRedemptionReference(procedureFhirId, "payment_fhir_id", paymentFhirId);
  }

  async finalizeSale(input: {
    definitionId: string;
    patientFhirId: string;
    sourceSaleInvoiceId: string;
    actorUserId: string;
    soldAt: string;
    snapshotName: string;
    snapshotEligibleProcedureTypeCodes: readonly string[];
    snapshotSessionCount: number;
    snapshotPriceCents: number;
    snapshotExpiryDays: number;
    snapshotRefundPolicy: PackageRefundPolicy;
  }): Promise<PatientPackageInstance> {
    assertFhirId(input.patientFhirId, "Patient id");
    assertFhirId(input.sourceSaleInvoiceId, "Invoice id");
    assertActor(input.actorUserId);
    assertInstant(input.soldAt, "Sale timestamp");
    if (!input.snapshotName.trim() || input.snapshotEligibleProcedureTypeCodes.length === 0) {
      throw new CommercialEngineInputError("Package sale snapshot is incomplete.");
    }
    assertPositiveInteger(input.snapshotSessionCount, "Snapshot session count");
    assertPositiveInteger(input.snapshotPriceCents, "Snapshot package price");
    assertPositiveInteger(input.snapshotExpiryDays, "Snapshot expiry days");
    if (!PACKAGE_REFUND_POLICIES.includes(input.snapshotRefundPolicy)) {
      throw new CommercialEngineInputError("Snapshot refund policy is invalid.");
    }
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidateId = randomUUID();
      const inserted = await client.query<{ id: string }>(`
          INSERT INTO odos_package_instances (
            id, patient_fhir_id, definition_id, snapshot_name,
            snapshot_eligible_procedure_type_codes, snapshot_session_count, snapshot_price_cents,
            snapshot_expiry_date, snapshot_refund_policy, source_sale_invoice_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, ($8::timestamptz + ($9 || ' days')::interval)::date, $10, $11, $8)
          ON CONFLICT (source_sale_invoice_id) DO NOTHING
          RETURNING id::text
        `, [
          candidateId,
          input.patientFhirId,
          input.definitionId,
          input.snapshotName,
          input.snapshotEligibleProcedureTypeCodes,
          input.snapshotSessionCount,
          input.snapshotPriceCents,
          input.soldAt,
          input.snapshotExpiryDays,
          input.snapshotRefundPolicy,
          input.sourceSaleInvoiceId,
        ]);
      const existing = await client.query<{ id: string; patient_fhir_id: string; definition_id: string }>(
        "SELECT id::text, patient_fhir_id, definition_id::text FROM odos_package_instances WHERE source_sale_invoice_id = $1",
        [input.sourceSaleInvoiceId],
      );
      const row = existing.rows[0];
      if (!row || row.patient_fhir_id !== input.patientFhirId || row.definition_id !== input.definitionId) {
        throw new CommercialEngineConflictError("The sale Invoice is already linked to a different package instance.");
      }
      const instanceId = row.id;
      if (inserted.rowCount) {
        await client.query(`
          INSERT INTO odos_package_ledger (
            id, patient_fhir_id, package_instance_id, entry_type, sessions_delta,
            actor_user_id, linked_fhir_invoice_id, created_at
          ) VALUES ($1, $2, $3, 'deposit', $4, $5, $6, $7)
        `, [randomUUID(), input.patientFhirId, instanceId, input.snapshotSessionCount, input.actorUserId, input.sourceSaleInvoiceId, input.soldAt]);
      }
      await client.query("COMMIT");
      return await this.packageById(client, input.patientFhirId, instanceId);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async consume(input: {
    packageInstanceId: string;
    patientFhirId: string;
    procedureTypeCodes: readonly string[];
    linkedFhirInvoiceId: string;
    linkedFhirProcedureId: string;
    actorUserId: string;
    consumedAt: string;
  }): Promise<PatientPackageInstance> {
    assertFhirId(input.patientFhirId, "Patient id");
    assertFhirId(input.linkedFhirInvoiceId, "Invoice id");
    assertFhirId(input.linkedFhirProcedureId, "Procedure id");
    assertActor(input.actorUserId);
    assertInstant(input.consumedAt, "Consumption timestamp");
    if (input.procedureTypeCodes.length === 0) throw new CommercialEngineInputError("Procedure code is required.");
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const instance = await client.query<Omit<ConsumableInstanceRow, "remaining_sessions">>(`
        SELECT i.patient_fhir_id, i.snapshot_expiry_date::text,
               i.snapshot_eligible_procedure_type_codes
        FROM odos_package_instances i
        WHERE i.id = $1
        FOR UPDATE OF i
      `, [input.packageInstanceId]);
      const row = instance.rows[0];
      if (!row || row.patient_fhir_id !== input.patientFhirId) {
        throw new CommercialEngineConflictError("The selected package does not belong to this patient.");
      }
      const existingConsumption = await client.query<{
        patient_fhir_id: string;
        package_instance_id: string;
        linked_fhir_invoice_id: string;
      }>(`
        SELECT patient_fhir_id, package_instance_id::text, linked_fhir_invoice_id
        FROM odos_package_ledger
        WHERE entry_type = 'consumption' AND linked_fhir_procedure_id = $1
      `, [input.linkedFhirProcedureId]);
      if (existingConsumption.rows[0]) {
        const existing = existingConsumption.rows[0];
        if (existing.patient_fhir_id !== input.patientFhirId
          || existing.package_instance_id !== input.packageInstanceId
          || existing.linked_fhir_invoice_id !== input.linkedFhirInvoiceId) {
          throw new CommercialEngineConflictError("This procedure already consumed a different package session.");
        }
        await client.query(
          "UPDATE odos_package_redemptions SET completed_at = coalesce(completed_at, $2) WHERE procedure_fhir_id = $1",
          [input.linkedFhirProcedureId, input.consumedAt],
        );
        await client.query("COMMIT");
        return await this.packageById(client, input.patientFhirId, input.packageInstanceId);
      }
      if (row.snapshot_expiry_date < input.consumedAt.slice(0, 10)) {
        throw new CommercialEngineConflictError("The selected package is expired.");
      }
      const balance = await client.query<{ remaining_sessions: string }>(
        "SELECT coalesce(sum(sessions_delta), 0)::text AS remaining_sessions FROM odos_package_ledger WHERE package_instance_id = $1",
        [input.packageInstanceId],
      );
      if (Number(balance.rows[0].remaining_sessions) <= 0) {
        throw new CommercialEngineConflictError("The selected package has no sessions remaining.");
      }
      if (!input.procedureTypeCodes.some((code) => row.snapshot_eligible_procedure_type_codes.includes(code))) {
        throw new CommercialEngineConflictError("The procedure is not eligible for the selected package.");
      }
      const inserted = await client.query(`
        INSERT INTO odos_package_ledger (
          id, patient_fhir_id, package_instance_id, entry_type, sessions_delta, actor_user_id,
          linked_fhir_invoice_id, linked_fhir_procedure_id, created_at
        ) VALUES ($1, $2, $3, 'consumption', -1, $4, $5, $6, $7)
        ON CONFLICT (linked_fhir_procedure_id)
          WHERE entry_type = 'consumption' DO NOTHING
      `, [
        randomUUID(),
        input.patientFhirId,
        input.packageInstanceId,
        input.actorUserId,
        input.linkedFhirInvoiceId,
        input.linkedFhirProcedureId,
        input.consumedAt,
      ]);
      if (!inserted.rowCount) {
        throw new CommercialEngineConflictError("This procedure has already consumed a package session.");
      }
      await client.query(
        "UPDATE odos_package_redemptions SET completed_at = coalesce(completed_at, $2) WHERE procedure_fhir_id = $1",
        [input.linkedFhirProcedureId, input.consumedAt],
      );
      await client.query("COMMIT");
      return await this.packageById(client, input.patientFhirId, input.packageInstanceId);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async packageById(
    client: Pick<PoolClient, "query">,
    patientFhirId: string,
    instanceId: string,
  ): Promise<PatientPackageInstance> {
    const packages = await this.listPatientPackagesWith(client, patientFhirId, instanceId);
    if (!packages[0]) throw new Error("Package instance could not be reloaded after persistence.");
    return packages[0];
  }

  private async listPatientPackagesWith(
    client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
    patientFhirId: string,
    instanceId?: string,
  ): Promise<PatientPackageInstance[]> {
    const instances = await client.query<PackageInstanceRow>(`
      SELECT i.*, coalesce(sum(l.sessions_delta), 0)::text AS remaining_sessions
      FROM odos_package_instances i
      LEFT JOIN odos_package_ledger l ON l.package_instance_id = i.id
      WHERE i.patient_fhir_id = $1 ${instanceId ? "AND i.id = $2" : ""}
      GROUP BY i.id
      ORDER BY i.snapshot_expiry_date, lower(i.snapshot_name), i.created_at
    `, instanceId ? [patientFhirId, instanceId] : [patientFhirId]);
    if (instances.rows.length === 0) return [];
    const ids = instances.rows.map((row) => row.id);
    const ledger = await client.query<PackageLedgerRow>(`
      SELECT * FROM odos_package_ledger
      WHERE package_instance_id = ANY($1::uuid[])
      ORDER BY created_at, id
    `, [ids]);
    const ledgerByInstance = new Map<string, PackageLedgerEntry[]>();
    for (const row of ledger.rows) {
      const entries = ledgerByInstance.get(row.package_instance_id) ?? [];
      entries.push(ledgerFromRow(row));
      ledgerByInstance.set(row.package_instance_id, entries);
    }
    return instances.rows.map((row) => instanceFromRow(row, ledgerByInstance.get(row.id) ?? []));
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.initializeSchema();
    await this.schemaReady;
  }

  private async recordRedemptionReference(
    procedureFhirId: string,
    column: "invoice_fhir_id" | "payment_fhir_id",
    fhirId: string,
  ): Promise<PackageRedemptionOperation> {
    assertFhirId(procedureFhirId, "Procedure id");
    assertFhirId(fhirId, "Redemption FHIR id");
    await this.ensureSchema();
    const result = await this.pool.query<PackageRedemptionRow>(`
      UPDATE odos_package_redemptions
      SET ${column} = $2
      WHERE procedure_fhir_id = $1 AND (${column} IS NULL OR ${column} = $2)
      RETURNING *
    `, [procedureFhirId, fhirId]);
    if (!result.rows[0]) {
      throw new CommercialEngineConflictError("The redemption already references a different FHIR record.");
    }
    return redemptionFromRow(result.rows[0]);
  }

  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(await readFile(SCHEMA_LEDGER_FILE, "utf8"));
      await client.query("BEGIN");
      await client.query("LOCK TABLE odos_schema_migrations IN SHARE ROW EXCLUSIVE MODE");
      const filename = basename(COMMERCIAL_SCHEMA_FILE);
      const applied = await client.query("SELECT 1 FROM odos_schema_migrations WHERE filename = $1", [filename]);
      if (!applied.rowCount) {
        await client.query(await readFile(COMMERCIAL_SCHEMA_FILE, "utf8"));
        await client.query("INSERT INTO odos_schema_migrations (filename) VALUES ($1)", [filename]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      this.schemaReady = undefined;
      throw error;
    } finally {
      client.release();
    }
  }
}

export class CommercialEngineInputError extends Error {}
export class CommercialEngineConflictError extends Error {}

interface PackageDefinitionRow {
  id: string;
  name: string;
  eligible_procedure_type_codes: string[];
  session_count: number;
  price_cents: string;
  expiry_days: number;
  refund_policy: PackageRefundPolicy;
  active: boolean;
  sold_count: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PackageInstanceRow {
  id: string;
  patient_fhir_id: string;
  definition_id: string;
  snapshot_name: string;
  snapshot_eligible_procedure_type_codes: string[];
  snapshot_session_count: number;
  snapshot_price_cents: string;
  snapshot_expiry_date: Date | string;
  snapshot_refund_policy: PackageRefundPolicy;
  source_sale_invoice_id: string;
  created_at: Date | string;
  remaining_sessions: string;
}

interface ConsumableInstanceRow {
  patient_fhir_id: string;
  snapshot_expiry_date: string;
  snapshot_eligible_procedure_type_codes: string[];
  remaining_sessions: string;
}

interface PackageRedemptionRow {
  procedure_fhir_id: string;
  patient_fhir_id: string;
  package_instance_id: string;
  charge_item_fhir_id: string;
  amount_cents: string;
  invoice_fhir_id: string | null;
  payment_fhir_id: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
}

interface PackageLedgerRow {
  id: string;
  package_instance_id: string;
  entry_type: PackageLedgerEntryType;
  sessions_delta: number;
  actor_user_id: string;
  reason: string | null;
  linked_fhir_invoice_id: string | null;
  linked_fhir_procedure_id: string | null;
  created_at: Date | string;
}

function definitionFromRow(row: PackageDefinitionRow): PackageDefinition {
  return {
    id: row.id,
    name: row.name,
    eligibleProcedureTypeCodes: row.eligible_procedure_type_codes,
    sessionCount: row.session_count,
    priceCents: safeInteger(row.price_cents, "Package price"),
    expiryDays: row.expiry_days,
    refundPolicy: row.refund_policy,
    active: row.active,
    soldCount: safeInteger(row.sold_count, "Package sold count"),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function redemptionFromRow(row: PackageRedemptionRow): PackageRedemptionOperation {
  return {
    procedureFhirId: row.procedure_fhir_id,
    patientFhirId: row.patient_fhir_id,
    packageInstanceId: row.package_instance_id,
    chargeItemFhirId: row.charge_item_fhir_id,
    amountCents: safeInteger(row.amount_cents, "Redemption amount"),
    ...(row.invoice_fhir_id ? { invoiceFhirId: row.invoice_fhir_id } : {}),
    ...(row.payment_fhir_id ? { paymentFhirId: row.payment_fhir_id } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    createdAt: iso(row.created_at),
  };
}

function instanceFromRow(row: PackageInstanceRow, ledger: PackageLedgerEntry[]): PatientPackageInstance {
  return {
    id: row.id,
    patientFhirId: row.patient_fhir_id,
    definitionId: row.definition_id,
    name: row.snapshot_name,
    eligibleProcedureTypeCodes: row.snapshot_eligible_procedure_type_codes,
    sessionCount: row.snapshot_session_count,
    priceCents: safeInteger(row.snapshot_price_cents, "Package snapshot price"),
    expiryDate: dateOnly(row.snapshot_expiry_date),
    refundPolicy: row.snapshot_refund_policy,
    sourceSaleInvoiceId: row.source_sale_invoice_id,
    remainingSessions: safeInteger(row.remaining_sessions, "Package remaining sessions"),
    createdAt: iso(row.created_at),
    ledger,
  };
}

function ledgerFromRow(row: PackageLedgerRow): PackageLedgerEntry {
  return {
    id: row.id,
    entryType: row.entry_type,
    sessionsDelta: row.sessions_delta,
    actorUserId: row.actor_user_id,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.linked_fhir_invoice_id ? { linkedFhirInvoiceId: row.linked_fhir_invoice_id } : {}),
    ...(row.linked_fhir_procedure_id ? { linkedFhirProcedureId: row.linked_fhir_procedure_id } : {}),
    createdAt: iso(row.created_at),
  };
}

function definitionValues(id: string, draft: PackageDefinitionDraft): unknown[] {
  return [
    id,
    draft.name.trim(),
    [...new Set(draft.eligibleProcedureTypeCodes.map((code) => code.trim()).filter(Boolean))],
    draft.sessionCount,
    draft.priceCents,
    draft.expiryDays ?? 365,
    draft.refundPolicy ?? "non_refundable",
  ];
}

function validateDefinitionDraft(draft: PackageDefinitionDraft): void {
  if (!draft.name.trim()) throw new CommercialEngineInputError("Package name is required.");
  if (draft.eligibleProcedureTypeCodes.length === 0 || draft.eligibleProcedureTypeCodes.some((code) => !code.trim())) {
    throw new CommercialEngineInputError("At least one eligible procedure type is required.");
  }
  assertPositiveInteger(draft.sessionCount, "Session count");
  assertPositiveInteger(draft.priceCents, "Package price");
  assertPositiveInteger(draft.expiryDays ?? 365, "Expiry days");
  if (!PACKAGE_REFUND_POLICIES.includes(draft.refundPolicy ?? "non_refundable")) {
    throw new CommercialEngineInputError("Refund policy is invalid.");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CommercialEngineInputError(`${label} must be a positive whole number.`);
}

function assertFhirId(value: string, label: string): void {
  if (!/^[A-Za-z0-9.-]+$/.test(value)) throw new CommercialEngineInputError(`${label} is invalid.`);
}

function assertActor(value: string): void {
  if (!value.trim()) throw new CommercialEngineInputError("Actor user id is required.");
}

function assertInstant(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new CommercialEngineInputError(`${label} is invalid.`);
}

function safeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds JavaScript safe-integer range.`);
  return parsed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateOnly(value: Date | string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

async function rollbackQuietly(client: Pick<PoolClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the originating database failure.
  }
}
