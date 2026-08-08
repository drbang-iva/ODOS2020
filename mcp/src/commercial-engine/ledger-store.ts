import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const SCHEMA_LEDGER_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
);
const COMMERCIAL_SCHEMA_FILES = [
  "2026-07-18-commercial-engine-schema.sql",
  "2026-07-18-commercial-engine-redemption-recovery.sql",
  "2026-07-18-commercial-engine-credit-bank.sql",
].map((filename) => fileURLToPath(new URL(`../../../data/migrations/${filename}`, import.meta.url)));

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
  externalReference?: string;
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
  consumedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export type CreditBankEntryType = "deposit" | "bonus" | "spend" | "refund_in" | "adjustment" | "expiry";

export interface CreditBankLedgerEntry {
  id: string;
  entryType: CreditBankEntryType;
  amountCents: number;
  actorUserId: string;
  reason?: string;
  linkedFhirInvoiceId?: string;
  createdAt: string;
}

export interface PatientCreditBank {
  patientFhirId: string;
  balanceCents: number;
  ledger: CreditBankLedgerEntry[];
}

export interface CreditBankSpendOperation {
  chargeItemFhirId: string;
  patientFhirId: string;
  amountCents: number;
  invoiceFhirId?: string;
  paymentFhirId?: string;
  consumedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface PackageLifecycleResult {
  package: PatientPackageInstance;
  amountCents: number;
  creditBank?: PatientCreditBank;
}

export interface PackageExpirySweepResult {
  expiredPackages: number;
  expiredSessions: number;
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
  completeRedemption(procedureFhirId: string, completedAt: string): Promise<PackageRedemptionOperation>;
  consume(input: {
    packageInstanceId: string;
    patientFhirId: string;
    procedureTypeCodes: readonly string[];
    linkedFhirInvoiceId: string;
    linkedFhirProcedureId: string;
    actorUserId: string;
    consumedAt: string;
  }): Promise<PatientPackageInstance>;
  getCreditBank(patientFhirId: string): Promise<PatientCreditBank>;
  finalizeCreditBankDeposit(input: {
    patientFhirId: string;
    sourceInvoiceId: string;
    depositCents: number;
    bonusCents: number;
    bonusReason?: string;
    actorUserId: string;
    depositedAt: string;
  }): Promise<PatientCreditBank>;
  getCreditBankSpend(chargeItemFhirId: string): Promise<CreditBankSpendOperation | undefined>;
  beginCreditBankSpend(input: {
    chargeItemFhirId: string;
    patientFhirId: string;
    amountCents: number;
    createdAt: string;
  }): Promise<CreditBankSpendOperation>;
  recordCreditBankSpendInvoice(chargeItemFhirId: string, invoiceFhirId: string): Promise<CreditBankSpendOperation>;
  recordCreditBankSpendPayment(chargeItemFhirId: string, paymentFhirId: string): Promise<CreditBankSpendOperation>;
  spendCreditBank(input: {
    chargeItemFhirId: string;
    patientFhirId: string;
    linkedFhirInvoiceId: string;
    amountCents: number;
    actorUserId: string;
    spentAt: string;
  }): Promise<PatientCreditBank>;
  completeCreditBankSpend(chargeItemFhirId: string, completedAt: string): Promise<CreditBankSpendOperation>;
  convertPackageToCreditBank(input: {
    packageInstanceId: string;
    patientFhirId: string;
    actorUserId: string;
    reason: string;
    convertedAt: string;
  }): Promise<PackageLifecycleResult>;
  attestPackageCashRefund(input: {
    packageInstanceId: string;
    patientFhirId: string;
    actorUserId: string;
    reason: string;
    externalReference: string;
    refundedAt: string;
  }): Promise<PackageLifecycleResult>;
  expirePackages(input: { asOfDate: string; actorUserId: string; expiredAt: string }): Promise<PackageExpirySweepResult>;
}

export class PgCommercialEngineStore implements CommercialEngineStore {
  private readonly pool: Pick<Pool, "connect" | "query" | "end">;
  private readonly ownsPool: boolean;
  private schemaReady?: Promise<void>;

  constructor(options: { postgresUrl?: string; pool?: Pick<Pool, "connect" | "query" | "end"> } = {}) {
    this.ownsPool = !options.pool;
    this.pool = options.pool ?? new Pool({
      connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
      max: 4,
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockChargeSettlement(client, input.chargeItemFhirId);
      const bankSpend = await client.query(
        "SELECT 1 FROM odos_credit_bank_spends WHERE charge_item_fhir_id = $1",
        [input.chargeItemFhirId],
      );
      if (bankSpend.rowCount) {
        throw new CommercialEngineConflictError("This charge already has a Credit Bank settlement operation.");
      }
      await client.query(`
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
      const existing = await client.query<PackageRedemptionRow>(
        "SELECT * FROM odos_package_redemptions WHERE procedure_fhir_id = $1",
        [input.procedureFhirId],
      );
      const operation = existing.rows[0] ? redemptionFromRow(existing.rows[0]) : undefined;
      if (!operation
        || operation.patientFhirId !== input.patientFhirId
        || operation.packageInstanceId !== input.packageInstanceId
        || operation.chargeItemFhirId !== input.chargeItemFhirId
        || operation.amountCents !== input.amountCents) {
        throw new CommercialEngineConflictError("This procedure already has a different package redemption operation.");
      }
      await client.query("COMMIT");
      return operation;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
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

  async completeRedemption(procedureFhirId: string, completedAt: string): Promise<PackageRedemptionOperation> {
    assertFhirId(procedureFhirId, "Procedure id");
    assertInstant(completedAt, "Redemption completion timestamp");
    await this.ensureSchema();
    const result = await this.pool.query<PackageRedemptionRow>(`
      UPDATE odos_package_redemptions
      SET completed_at = coalesce(completed_at, $2)
      WHERE procedure_fhir_id = $1
        AND consumed_at IS NOT NULL
        AND invoice_fhir_id IS NOT NULL
        AND payment_fhir_id IS NOT NULL
      RETURNING *
    `, [procedureFhirId, completedAt]);
    if (!result.rows[0]) {
      throw new CommercialEngineConflictError("The redemption cannot complete before consumption and settlement are recorded.");
    }
    return redemptionFromRow(result.rows[0]);
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
    const snapshotName = input.snapshotName.trim();
    const snapshotEligibleProcedureTypeCodes = input.snapshotEligibleProcedureTypeCodes.map((code) => code.trim());
    if (!snapshotName
      || snapshotEligibleProcedureTypeCodes.length === 0
      || snapshotEligibleProcedureTypeCodes.some((code) => !code)) {
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
          snapshotName,
          snapshotEligibleProcedureTypeCodes,
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
          "UPDATE odos_package_redemptions SET consumed_at = coalesce(consumed_at, $2) WHERE procedure_fhir_id = $1",
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
        "UPDATE odos_package_redemptions SET consumed_at = coalesce(consumed_at, $2) WHERE procedure_fhir_id = $1",
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

  async getCreditBank(patientFhirId: string): Promise<PatientCreditBank> {
    assertFhirId(patientFhirId, "Patient id");
    await this.ensureSchema();
    return this.getCreditBankWith(this.pool, patientFhirId);
  }

  async finalizeCreditBankDeposit(input: {
    patientFhirId: string;
    sourceInvoiceId: string;
    depositCents: number;
    bonusCents: number;
    bonusReason?: string;
    actorUserId: string;
    depositedAt: string;
  }): Promise<PatientCreditBank> {
    assertFhirId(input.patientFhirId, "Patient id");
    assertFhirId(input.sourceInvoiceId, "Invoice id");
    assertPositiveInteger(input.depositCents, "Deposit amount");
    assertNonnegativeInteger(input.bonusCents, "Bonus amount");
    assertActor(input.actorUserId);
    assertInstant(input.depositedAt, "Deposit timestamp");
    const bonusReason = input.bonusReason?.trim();
    if (input.bonusCents > 0 && !bonusReason) {
      throw new CommercialEngineInputError("Bonus reason is required.");
    }
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCreditBankAccount(client, input.patientFhirId);
      await client.query(`
        INSERT INTO odos_credit_bank_ledger (
          id, patient_fhir_id, entry_type, amount_cents, actor_user_id,
          linked_fhir_invoice_id, created_at
        ) VALUES ($1, $2, 'deposit', $3, $4, $5, $6)
        ON CONFLICT (linked_fhir_invoice_id) WHERE entry_type = 'deposit' DO NOTHING
      `, [
        stableUuid("credit-bank-deposit", input.sourceInvoiceId),
        input.patientFhirId,
        input.depositCents,
        input.actorUserId,
        input.sourceInvoiceId,
        input.depositedAt,
      ]);
      const deposit = await client.query<CreditBankLedgerRow>(`
        SELECT * FROM odos_credit_bank_ledger
        WHERE entry_type = 'deposit' AND linked_fhir_invoice_id = $1
      `, [input.sourceInvoiceId]);
      const depositRow = deposit.rows[0];
      if (!depositRow
        || depositRow.patient_fhir_id !== input.patientFhirId
        || safeInteger(depositRow.amount_cents, "Credit Bank deposit") !== input.depositCents) {
        throw new CommercialEngineConflictError("The funding Invoice is already linked to a different Credit Bank deposit.");
      }
      if (input.bonusCents > 0) {
        const bonusId = stableUuid("credit-bank-bonus", input.sourceInvoiceId);
        await client.query(`
          INSERT INTO odos_credit_bank_ledger (
            id, patient_fhir_id, entry_type, amount_cents, actor_user_id, reason, created_at
          ) VALUES ($1, $2, 'bonus', $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `, [bonusId, input.patientFhirId, input.bonusCents, input.actorUserId, bonusReason, input.depositedAt]);
        const bonus = await client.query<CreditBankLedgerRow>(
          "SELECT * FROM odos_credit_bank_ledger WHERE id = $1",
          [bonusId],
        );
        const bonusRow = bonus.rows[0];
        if (!bonusRow
          || bonusRow.patient_fhir_id !== input.patientFhirId
          || safeInteger(bonusRow.amount_cents, "Credit Bank bonus") !== input.bonusCents
          || bonusRow.reason !== bonusReason
          || bonusRow.linked_fhir_invoice_id !== null) {
          throw new CommercialEngineConflictError("The funding Invoice already has different Credit Bank bonus terms.");
        }
      } else {
        const unexpectedBonus = await client.query(
          "SELECT 1 FROM odos_credit_bank_ledger WHERE id = $1",
          [stableUuid("credit-bank-bonus", input.sourceInvoiceId)],
        );
        if (unexpectedBonus.rowCount) {
          throw new CommercialEngineConflictError("The funding Invoice already has Credit Bank bonus terms.");
        }
      }
      await client.query("COMMIT");
      return this.getCreditBankWith(client, input.patientFhirId);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCreditBankSpend(chargeItemFhirId: string): Promise<CreditBankSpendOperation | undefined> {
    assertFhirId(chargeItemFhirId, "ChargeItem id");
    await this.ensureSchema();
    const result = await this.pool.query<CreditBankSpendRow>(
      "SELECT * FROM odos_credit_bank_spends WHERE charge_item_fhir_id = $1",
      [chargeItemFhirId],
    );
    return result.rows[0] ? creditBankSpendFromRow(result.rows[0]) : undefined;
  }

  async beginCreditBankSpend(input: {
    chargeItemFhirId: string;
    patientFhirId: string;
    amountCents: number;
    createdAt: string;
  }): Promise<CreditBankSpendOperation> {
    assertFhirId(input.chargeItemFhirId, "ChargeItem id");
    assertFhirId(input.patientFhirId, "Patient id");
    assertPositiveInteger(input.amountCents, "Credit Bank spend amount");
    assertInstant(input.createdAt, "Credit Bank spend timestamp");
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockChargeSettlement(client, input.chargeItemFhirId);
      await client.query(
        "INSERT INTO odos_credit_bank_accounts (patient_fhir_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [input.patientFhirId],
      );
      const packageRedemption = await client.query(
        "SELECT 1 FROM odos_package_redemptions WHERE charge_item_fhir_id = $1",
        [input.chargeItemFhirId],
      );
      if (packageRedemption.rowCount) {
        throw new CommercialEngineConflictError("This charge already has a package-credit settlement operation.");
      }
      await client.query(`
        INSERT INTO odos_credit_bank_spends (
          charge_item_fhir_id, patient_fhir_id, amount_cents, created_at
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (charge_item_fhir_id) DO NOTHING
      `, [input.chargeItemFhirId, input.patientFhirId, input.amountCents, input.createdAt]);
      const existing = await client.query<CreditBankSpendRow>(
        "SELECT * FROM odos_credit_bank_spends WHERE charge_item_fhir_id = $1",
        [input.chargeItemFhirId],
      );
      const operation = existing.rows[0] ? creditBankSpendFromRow(existing.rows[0]) : undefined;
      if (!operation
        || operation.patientFhirId !== input.patientFhirId
        || operation.amountCents !== input.amountCents) {
        throw new CommercialEngineConflictError("This charge already has a different Credit Bank spend operation.");
      }
      await client.query("COMMIT");
      return operation;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordCreditBankSpendInvoice(
    chargeItemFhirId: string,
    invoiceFhirId: string,
  ): Promise<CreditBankSpendOperation> {
    return this.recordCreditBankSpendReference(chargeItemFhirId, "invoice_fhir_id", invoiceFhirId);
  }

  async recordCreditBankSpendPayment(
    chargeItemFhirId: string,
    paymentFhirId: string,
  ): Promise<CreditBankSpendOperation> {
    return this.recordCreditBankSpendReference(chargeItemFhirId, "payment_fhir_id", paymentFhirId);
  }

  async spendCreditBank(input: {
    chargeItemFhirId: string;
    patientFhirId: string;
    linkedFhirInvoiceId: string;
    amountCents: number;
    actorUserId: string;
    spentAt: string;
  }): Promise<PatientCreditBank> {
    assertFhirId(input.chargeItemFhirId, "ChargeItem id");
    assertFhirId(input.patientFhirId, "Patient id");
    assertFhirId(input.linkedFhirInvoiceId, "Invoice id");
    assertPositiveInteger(input.amountCents, "Credit Bank spend amount");
    assertActor(input.actorUserId);
    assertInstant(input.spentAt, "Credit Bank spend timestamp");
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCreditBankAccount(client, input.patientFhirId);
      const operation = await client.query<CreditBankSpendRow>(`
        SELECT * FROM odos_credit_bank_spends
        WHERE charge_item_fhir_id = $1
        FOR UPDATE
      `, [input.chargeItemFhirId]);
      const operationRow = operation.rows[0];
      if (!operationRow
        || operationRow.patient_fhir_id !== input.patientFhirId
        || safeInteger(operationRow.amount_cents, "Credit Bank spend amount") !== input.amountCents
        || operationRow.invoice_fhir_id !== input.linkedFhirInvoiceId) {
        throw new CommercialEngineConflictError("The Credit Bank spend operation does not match this charge and Invoice.");
      }
      const existing = await client.query<CreditBankLedgerRow>(`
        SELECT * FROM odos_credit_bank_ledger
        WHERE entry_type = 'spend' AND linked_fhir_invoice_id = $1
      `, [input.linkedFhirInvoiceId]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.patient_fhir_id !== input.patientFhirId
          || safeInteger(row.amount_cents, "Credit Bank spend") !== -input.amountCents) {
          throw new CommercialEngineConflictError("The Invoice is already linked to a different Credit Bank spend.");
        }
      } else {
        const balance = await client.query<{ balance_cents: string }>(`
          SELECT coalesce(sum(amount_cents), 0)::text AS balance_cents
          FROM odos_credit_bank_ledger
          WHERE patient_fhir_id = $1
        `, [input.patientFhirId]);
        if (safeInteger(balance.rows[0].balance_cents, "Credit Bank balance") < input.amountCents) {
          throw new CommercialEngineConflictError("Credit Bank balance is insufficient for this charge.");
        }
        await client.query(`
          INSERT INTO odos_credit_bank_ledger (
            id, patient_fhir_id, entry_type, amount_cents, actor_user_id,
            linked_fhir_invoice_id, created_at
          ) VALUES ($1, $2, 'spend', $3, $4, $5, $6)
        `, [
          stableUuid("credit-bank-spend", input.linkedFhirInvoiceId),
          input.patientFhirId,
          -input.amountCents,
          input.actorUserId,
          input.linkedFhirInvoiceId,
          input.spentAt,
        ]);
      }
      await client.query(`
        UPDATE odos_credit_bank_spends
        SET consumed_at = coalesce(consumed_at, $2)
        WHERE charge_item_fhir_id = $1
      `, [input.chargeItemFhirId, input.spentAt]);
      await client.query("COMMIT");
      return this.getCreditBankWith(client, input.patientFhirId);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeCreditBankSpend(chargeItemFhirId: string, completedAt: string): Promise<CreditBankSpendOperation> {
    assertFhirId(chargeItemFhirId, "ChargeItem id");
    assertInstant(completedAt, "Credit Bank spend completion timestamp");
    await this.ensureSchema();
    const result = await this.pool.query<CreditBankSpendRow>(`
      UPDATE odos_credit_bank_spends
      SET completed_at = coalesce(completed_at, $2)
      WHERE charge_item_fhir_id = $1
        AND consumed_at IS NOT NULL
        AND invoice_fhir_id IS NOT NULL
        AND payment_fhir_id IS NOT NULL
      RETURNING *
    `, [chargeItemFhirId, completedAt]);
    if (!result.rows[0]) {
      throw new CommercialEngineConflictError("The Credit Bank spend cannot complete before consumption and settlement are recorded.");
    }
    return creditBankSpendFromRow(result.rows[0]);
  }

  async convertPackageToCreditBank(input: {
    packageInstanceId: string;
    patientFhirId: string;
    actorUserId: string;
    reason: string;
    convertedAt: string;
  }): Promise<PackageLifecycleResult> {
    return this.adjustPackageRemainder(input, "store_credit_only");
  }

  async attestPackageCashRefund(input: {
    packageInstanceId: string;
    patientFhirId: string;
    actorUserId: string;
    reason: string;
    externalReference: string;
    refundedAt: string;
  }): Promise<PackageLifecycleResult> {
    return this.adjustPackageRemainder({
      packageInstanceId: input.packageInstanceId,
      patientFhirId: input.patientFhirId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      externalReference: input.externalReference,
      convertedAt: input.refundedAt,
    }, "prorated_cash");
  }

  async expirePackages(input: {
    asOfDate: string;
    actorUserId: string;
    expiredAt: string;
  }): Promise<PackageExpirySweepResult> {
    assertDate(input.asOfDate, "Expiry sweep date");
    assertActor(input.actorUserId);
    assertInstant(input.expiredAt, "Expiry sweep timestamp");
    await this.ensureSchema();
    const candidates = await this.pool.query<{ id: string; patient_fhir_id: string }>(`
      SELECT i.id::text, i.patient_fhir_id
      FROM odos_package_instances i
      LEFT JOIN odos_package_ledger l ON l.package_instance_id = i.id
      WHERE i.snapshot_expiry_date < $1::date
      GROUP BY i.id
      HAVING coalesce(sum(l.sessions_delta), 0) > 0
      ORDER BY i.id
    `, [input.asOfDate]);
    let expiredPackages = 0;
    let expiredSessions = 0;
    for (const candidate of candidates.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const instance = await client.query<{ patient_fhir_id: string; snapshot_expiry_date: string }>(`
          SELECT patient_fhir_id, snapshot_expiry_date::text
          FROM odos_package_instances
          WHERE id = $1
          FOR UPDATE
        `, [candidate.id]);
        const row = instance.rows[0];
        if (!row || row.patient_fhir_id !== candidate.patient_fhir_id || row.snapshot_expiry_date >= input.asOfDate) {
          await client.query("COMMIT");
          continue;
        }
        const existing = await client.query(
          "SELECT 1 FROM odos_package_ledger WHERE package_instance_id = $1 AND entry_type = 'expiry'",
          [candidate.id],
        );
        if (existing.rowCount) {
          await client.query("COMMIT");
          continue;
        }
        const balance = await client.query<{ remaining_sessions: string }>(`
          SELECT coalesce(sum(sessions_delta), 0)::text AS remaining_sessions
          FROM odos_package_ledger WHERE package_instance_id = $1
        `, [candidate.id]);
        const remaining = safeInteger(balance.rows[0].remaining_sessions, "Package remaining sessions");
        if (remaining <= 0) {
          await client.query("COMMIT");
          continue;
        }
        await client.query(`
          INSERT INTO odos_package_ledger (
            id, patient_fhir_id, package_instance_id, entry_type, sessions_delta,
            actor_user_id, created_at
          ) VALUES ($1, $2, $3, 'expiry', $4, $5, $6)
          ON CONFLICT (package_instance_id) WHERE entry_type = 'expiry' DO NOTHING
        `, [stableUuid("package-expiry", candidate.id), candidate.patient_fhir_id, candidate.id, -remaining, input.actorUserId, input.expiredAt]);
        await client.query("COMMIT");
        expiredPackages += 1;
        expiredSessions += remaining;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    }
    return { expiredPackages, expiredSessions };
  }

  private async adjustPackageRemainder(
    input: {
      packageInstanceId: string;
      patientFhirId: string;
      actorUserId: string;
      reason: string;
      externalReference?: string;
      convertedAt: string;
    },
    policy: "store_credit_only" | "prorated_cash",
  ): Promise<PackageLifecycleResult> {
    assertFhirId(input.patientFhirId, "Patient id");
    assertActor(input.actorUserId);
    const reason = input.reason.trim();
    if (!reason) throw new CommercialEngineInputError("Package adjustment reason is required.");
    const externalReference = input.externalReference?.trim();
    if (policy === "prorated_cash" && !externalReference) {
      throw new CommercialEngineInputError("External refund reference is required.");
    }
    assertInstant(input.convertedAt, "Package adjustment timestamp");
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (policy === "store_credit_only") await lockCreditBankAccount(client, input.patientFhirId);
      const instance = await client.query<LifecyclePackageRow>(`
        SELECT id::text, patient_fhir_id, snapshot_session_count, snapshot_price_cents,
               snapshot_refund_policy, source_sale_invoice_id
        FROM odos_package_instances
        WHERE id = $1
        FOR UPDATE
      `, [input.packageInstanceId]);
      const row = instance.rows[0];
      if (!row || row.patient_fhir_id !== input.patientFhirId) {
        throw new CommercialEngineConflictError("The selected package does not belong to this patient.");
      }
      if (row.snapshot_refund_policy !== policy) {
        throw new CommercialEngineConflictError(`The package's frozen refund policy is ${row.snapshot_refund_policy}.`);
      }
      const adjustmentKind = policy === "store_credit_only" ? "package-store-credit" : "package-cash-refund";
      const adjustmentId = stableUuid(adjustmentKind, input.packageInstanceId);
      const existingAdjustment = await client.query<PackageLedgerRow>(
        "SELECT * FROM odos_package_ledger WHERE id = $1",
        [adjustmentId],
      );
      if (existingAdjustment.rows[0]) {
        const existing = existingAdjustment.rows[0];
        if (existing.patient_fhir_id !== input.patientFhirId
          || existing.reason !== reason
          || (existing.external_reference ?? undefined) !== externalReference) {
          throw new CommercialEngineConflictError("This package remainder already has different adjustment terms.");
        }
        const adjustedSessions = -existing.sessions_delta;
        const amountCents = refundableRemainderCents(
          safeInteger(row.snapshot_price_cents, "Package snapshot price"),
          row.snapshot_session_count,
          adjustedSessions,
        );
        await client.query("COMMIT");
        return {
          package: await this.packageById(client, input.patientFhirId, input.packageInstanceId),
          amountCents,
          ...(policy === "store_credit_only" ? { creditBank: await this.getCreditBankWith(client, input.patientFhirId) } : {}),
        };
      }
      const balance = await client.query<{ remaining_sessions: string }>(`
        SELECT coalesce(sum(sessions_delta), 0)::text AS remaining_sessions
        FROM odos_package_ledger WHERE package_instance_id = $1
      `, [input.packageInstanceId]);
      const remainingSessions = safeInteger(balance.rows[0].remaining_sessions, "Package remaining sessions");
      if (remainingSessions <= 0) {
        throw new CommercialEngineConflictError("The selected package has no sessions remaining.");
      }
      const amountCents = refundableRemainderCents(
        safeInteger(row.snapshot_price_cents, "Package snapshot price"),
        row.snapshot_session_count,
        remainingSessions,
      );
      if (policy === "store_credit_only") {
        await client.query(`
          INSERT INTO odos_credit_bank_ledger (
            id, patient_fhir_id, entry_type, amount_cents, actor_user_id, reason,
            linked_fhir_invoice_id, created_at
          ) VALUES ($1, $2, 'refund_in', $3, $4, $5, $6, $7)
        `, [
          stableUuid("credit-bank-package-conversion", input.packageInstanceId),
          input.patientFhirId,
          amountCents,
          input.actorUserId,
          reason,
          row.source_sale_invoice_id,
          input.convertedAt,
        ]);
      }
      await client.query(`
        INSERT INTO odos_package_ledger (
          id, patient_fhir_id, package_instance_id, entry_type, sessions_delta,
          actor_user_id, reason, linked_fhir_invoice_id, external_reference, created_at
        ) VALUES ($1, $2, $3, 'adjustment', $4, $5, $6, $7, $8, $9)
      `, [
        adjustmentId,
        input.patientFhirId,
        input.packageInstanceId,
        -remainingSessions,
        input.actorUserId,
        reason,
        row.source_sale_invoice_id,
        externalReference ?? null,
        input.convertedAt,
      ]);
      await client.query("COMMIT");
      return {
        package: await this.packageById(client, input.patientFhirId, input.packageInstanceId),
        amountCents,
        ...(policy === "store_credit_only" ? { creditBank: await this.getCreditBankWith(client, input.patientFhirId) } : {}),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async getCreditBankWith(
    client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
    patientFhirId: string,
  ): Promise<PatientCreditBank> {
    const result = await client.query<CreditBankLedgerRow>(`
      SELECT * FROM odos_credit_bank_ledger
      WHERE patient_fhir_id = $1
      ORDER BY created_at, id
    `, [patientFhirId]);
    const ledger = result.rows.map(creditBankLedgerFromRow);
    return {
      patientFhirId,
      balanceCents: ledger.reduce((sum, entry) => sum + entry.amountCents, 0),
      ledger,
    };
  }

  private async recordCreditBankSpendReference(
    chargeItemFhirId: string,
    column: "invoice_fhir_id" | "payment_fhir_id",
    fhirId: string,
  ): Promise<CreditBankSpendOperation> {
    assertFhirId(chargeItemFhirId, "ChargeItem id");
    assertFhirId(fhirId, "Credit Bank spend FHIR id");
    await this.ensureSchema();
    const result = await this.pool.query<CreditBankSpendRow>(`
      UPDATE odos_credit_bank_spends
      SET ${column} = $2
      WHERE charge_item_fhir_id = $1 AND (${column} IS NULL OR ${column} = $2)
      RETURNING *
    `, [chargeItemFhirId, fhirId]);
    if (!result.rows[0]) {
      throw new CommercialEngineConflictError("The Credit Bank spend already references a different FHIR record.");
    }
    return creditBankSpendFromRow(result.rows[0]);
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
      for (const schemaFile of COMMERCIAL_SCHEMA_FILES) {
        const filename = basename(schemaFile);
        const applied = await client.query("SELECT 1 FROM odos_schema_migrations WHERE filename = $1", [filename]);
        if (!applied.rowCount) {
          await client.query(await readFile(schemaFile, "utf8"));
          await client.query("INSERT INTO odos_schema_migrations (filename) VALUES ($1)", [filename]);
        }
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
  consumed_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
}

interface PackageLedgerRow {
  id: string;
  patient_fhir_id: string;
  package_instance_id: string;
  entry_type: PackageLedgerEntryType;
  sessions_delta: number;
  actor_user_id: string;
  reason: string | null;
  linked_fhir_invoice_id: string | null;
  linked_fhir_procedure_id: string | null;
  external_reference: string | null;
  created_at: Date | string;
}

interface LifecyclePackageRow {
  id: string;
  patient_fhir_id: string;
  snapshot_session_count: number;
  snapshot_price_cents: string;
  snapshot_refund_policy: PackageRefundPolicy;
  source_sale_invoice_id: string;
}

interface CreditBankLedgerRow {
  id: string;
  patient_fhir_id: string;
  entry_type: CreditBankEntryType;
  amount_cents: string;
  actor_user_id: string;
  reason: string | null;
  linked_fhir_invoice_id: string | null;
  created_at: Date | string;
}

interface CreditBankSpendRow {
  charge_item_fhir_id: string;
  patient_fhir_id: string;
  amount_cents: string;
  invoice_fhir_id: string | null;
  payment_fhir_id: string | null;
  consumed_at: Date | string | null;
  completed_at: Date | string | null;
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
    ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
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
    ...(row.external_reference ? { externalReference: row.external_reference } : {}),
    createdAt: iso(row.created_at),
  };
}

function creditBankLedgerFromRow(row: CreditBankLedgerRow): CreditBankLedgerEntry {
  return {
    id: row.id,
    entryType: row.entry_type,
    amountCents: safeInteger(row.amount_cents, "Credit Bank ledger amount"),
    actorUserId: row.actor_user_id,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.linked_fhir_invoice_id ? { linkedFhirInvoiceId: row.linked_fhir_invoice_id } : {}),
    createdAt: iso(row.created_at),
  };
}

function creditBankSpendFromRow(row: CreditBankSpendRow): CreditBankSpendOperation {
  return {
    chargeItemFhirId: row.charge_item_fhir_id,
    patientFhirId: row.patient_fhir_id,
    amountCents: safeInteger(row.amount_cents, "Credit Bank spend amount"),
    ...(row.invoice_fhir_id ? { invoiceFhirId: row.invoice_fhir_id } : {}),
    ...(row.payment_fhir_id ? { paymentFhirId: row.payment_fhir_id } : {}),
    ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
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

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CommercialEngineInputError(`${label} must be a nonnegative whole number.`);
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

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new CommercialEngineInputError(`${label} is invalid.`);
  }
}

export function largestRemainderAllocation(totalCents: number, units: number): number[] {
  assertPositiveInteger(totalCents, "Allocation total");
  assertPositiveInteger(units, "Allocation units");
  const base = Math.floor(totalCents / units);
  const remainder = totalCents % units;
  return Array.from({ length: units }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function refundableRemainderCents(
  totalCents: number,
  totalSessions: number,
  remainingSessions: number,
): number {
  assertPositiveInteger(totalCents, "Package price");
  assertPositiveInteger(totalSessions, "Package session count");
  assertPositiveInteger(remainingSessions, "Remaining session count");
  if (remainingSessions > totalSessions) {
    throw new CommercialEngineInputError("Remaining sessions cannot exceed the package session count.");
  }
  return largestRemainderAllocation(totalCents, totalSessions)
    .slice(totalSessions - remainingSessions)
    .reduce((sum, cents) => sum + cents, 0);
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

async function lockCreditBankAccount(client: Pick<PoolClient, "query">, patientFhirId: string): Promise<void> {
  await client.query(
    "INSERT INTO odos_credit_bank_accounts (patient_fhir_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [patientFhirId],
  );
  await client.query(
    "SELECT patient_fhir_id FROM odos_credit_bank_accounts WHERE patient_fhir_id = $1 FOR UPDATE",
    [patientFhirId],
  );
}

async function lockChargeSettlement(client: Pick<PoolClient, "query">, chargeItemFhirId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [chargeItemFhirId],
  );
}

function stableUuid(namespace: string, key: string): string {
  const hex = createHash("sha256").update(`${namespace}:${key}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
