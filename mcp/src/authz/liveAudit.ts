import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import type { AuditEvent } from "@medplum/fhirtypes";
import { createMedplumClient, type MedplumClient } from "../fhir-client.js";
import {
  AuditEventProjectionQueue,
  buildAuditEventProjection,
  type OsodActionOutcome,
  type OsodActorRole,
  type OsodAuditEventRecord,
  type OsodAuditEventType,
} from "./osodAudit.js";
import type { AgentOpsAuditFields } from "../agentops/types.js";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const AUDIT_DDL_FILES = [
  new URL("../../../data/migrations/2026-04-29-v05b-osod-audit-events.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-01-v055a-smart-events.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-01-v055a-smart-clients.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-01-v055a-smart-scope-decisions.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-01-v055b-smart-events.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-01-v055b-smart-app-installations.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-02-v055c-cds-events.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-02-v055c-cds-feedback.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-02-v055c-cds-service-keys.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-04-v055d-agentops-records.sql", import.meta.url),
  new URL("../../../data/migrations/2026-05-04-v055d-agentops-events.sql", import.meta.url),
].map((url) => fileURLToPath(url));

export interface LiveAuditRuntimeOptions {
  postgresUrl?: string;
  medplumBaseUrl?: string;
  medplumAccessToken?: string;
  medplumEmail?: string;
  medplumPassword?: string;
  disabled?: boolean;
  projectionWorkerIntervalMs?: number;
}

export interface LiveAuditQueryFilters {
  patientId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  eventTypes?: readonly OsodAuditEventType[];
  outcome?: OsodActionOutcome;
  breakGlassOnly?: boolean;
  limit?: number;
}

export interface FhirAuditRecorder {
  record<T>(row: OsodAuditEventRecord, operation: () => Promise<T> | T): Promise<T>;
  recordDenied(row: OsodAuditEventRecord): Promise<void>;
}

export class LiveOsodAuditRuntime implements FhirAuditRecorder {
  readonly projectionQueue = new AuditEventProjectionQueue();
  private readonly pool: Pool;
  private readonly options: Required<Pick<LiveAuditRuntimeOptions, "disabled">> &
    Omit<LiveAuditRuntimeOptions, "disabled">;
  private schemaReady?: Promise<void>;
  private projectionClient?: Promise<MedplumClient>;
  private projectionWorker?: NodeJS.Timeout;

  constructor(options: LiveAuditRuntimeOptions = {}) {
    this.options = { ...options, disabled: options.disabled ?? false };
    this.pool = new Pool({
      connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
      max: 4,
    });
  }

  async record<T>(row: OsodAuditEventRecord, operation: () => Promise<T> | T): Promise<T> {
    if (this.options.disabled) {
      return operation();
    }

    await this.ensureSchema();
    const client = await this.pool.connect();
    let inserted: OsodAuditEventRecord | undefined;
    try {
      await client.query("BEGIN");
      try {
        inserted = await this.insertRow(row, client);
      } catch (error) {
        await rollbackQuietly(client);
        throw new Error("audit substrate unavailable: originating PHI operation rolled back", {
          cause: error,
        });
      }

      let result: T;
      try {
        result = await operation();
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      }

      await client.query("COMMIT");
      await this.projectOrQueue(inserted);
      return result;
    } catch (error) {
      if (inserted) {
        await rollbackQuietly(client);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordDenied(row: OsodAuditEventRecord): Promise<void> {
    await this.record(row, async () => undefined);
  }

  async queryRows(filters: LiveAuditQueryFilters = {}): Promise<OsodAuditEventRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      values.push(value);
      clauses.push(clause.replace("?", `$${values.length}`));
    };

    if (filters.patientId) add("patient_id = ?", filters.patientId);
    if (filters.actorId) add("actor_id = ?", filters.actorId);
    if (filters.from) add("event_time >= ?::timestamptz", filters.from);
    if (filters.to) add("event_time <= ?::timestamptz", filters.to);
    if (filters.eventTypes?.length) add("event_type = ANY(?::text[])", [...filters.eventTypes]);
    if (filters.outcome) add("action_outcome = ?", filters.outcome);
    if (filters.breakGlassOnly) clauses.push("break_glass = true");

    const limit = Math.min(Math.max(filters.limit ?? 500, 1), 5000);
    values.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.pool.query(
      `
        SELECT
          id::text,
          event_time,
          event_type,
          actor_id,
          actor_role,
          patient_id,
          resource_type,
          resource_id,
          action_outcome,
          action_reason,
          policy_url,
          session_id,
          ip_address::text,
          user_agent,
          break_glass,
          break_glass_reason,
          ib_actor_classification,
          ib_exception,
          agent_identity,
          attempted_action,
          target_fhir_resource,
          threshold_class,
          verdict,
          rationale,
          source_identity,
          section_171_exception_code,
          aiast_tag_confirmation,
          initiation_mode,
          retention_until,
          attempted_payload_full,
          provenance_id,
          audit_event_id,
          created_at
        FROM osod_audit_events
        ${where}
        ORDER BY event_time DESC
        LIMIT $${values.length}
      `,
      values,
    );
    return result.rows.map(pgRowToAuditRecord);
  }

  startProjectionWorker(): void {
    if (this.projectionWorker || this.options.disabled) {
      return;
    }
    const intervalMs = this.options.projectionWorkerIntervalMs ?? 60_000;
    this.projectionWorker = setInterval(() => {
      this.drainProjectionQueue().catch((error) => {
        console.error("osod-audit: projection worker failed:", error);
      });
    }, intervalMs);
    this.projectionWorker.unref();
  }

  async drainProjectionQueue(now = new Date().toISOString()): Promise<void> {
    for (const item of this.projectionQueue.due(now)) {
      try {
        await this.projectAuditEvent(item.row);
        this.projectionQueue.markProjected(item.row.id);
      } catch (error) {
        this.projectionQueue.markFailed(item.row.id, error, now);
      }
    }
  }

  async close(): Promise<void> {
    if (this.projectionWorker) {
      clearInterval(this.projectionWorker);
    }
    await this.pool.end();
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= (async () => {
      for (const path of AUDIT_DDL_FILES) {
        const sql = await readFile(path, "utf8");
        await this.pool.query(sql);
      }
    })();
    await this.schemaReady;
  }

  private async insertRow(
    row: OsodAuditEventRecord,
    client: Pool | PoolClient = this.pool,
  ): Promise<OsodAuditEventRecord> {
    const result = await client.query(
      `
        INSERT INTO osod_audit_events (
          id,
          event_time,
          event_type,
          actor_id,
          actor_role,
          patient_id,
          resource_type,
          resource_id,
          action_outcome,
          action_reason,
          policy_url,
          session_id,
          ip_address,
          user_agent,
          break_glass,
          break_glass_reason,
          ib_actor_classification,
          ib_exception,
          agent_identity,
          attempted_action,
          target_fhir_resource,
          threshold_class,
          verdict,
          rationale,
          source_identity,
          section_171_exception_code,
          aiast_tag_confirmation,
          initiation_mode,
          retention_until,
          attempted_payload_full,
          provenance_id,
          audit_event_id,
          created_at
        )
        VALUES (
          $1::uuid, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, NULLIF($13, '')::inet, $14, $15, $16, $17, $18,
          $19, $20::jsonb, $21::jsonb, $22, $23, $24::jsonb, $25::jsonb, $26,
          $27, $28, $29::timestamptz, $30::jsonb, $31, $32, $33::timestamptz
        )
        RETURNING
          id::text,
          event_time,
          event_type,
          actor_id,
          actor_role,
          patient_id,
          resource_type,
          resource_id,
          action_outcome,
          action_reason,
          policy_url,
          session_id,
          ip_address::text,
          user_agent,
          break_glass,
          break_glass_reason,
          ib_actor_classification,
          ib_exception,
          agent_identity,
          attempted_action,
          target_fhir_resource,
          threshold_class,
          verdict,
          rationale,
          source_identity,
          section_171_exception_code,
          aiast_tag_confirmation,
          initiation_mode,
          retention_until,
          attempted_payload_full,
          provenance_id,
          audit_event_id,
          created_at
      `,
      [
        row.id,
        row.eventTime,
        row.eventType,
        row.actorId,
        row.actorRole,
        row.patientId,
        row.resourceType,
        row.resourceId,
        row.actionOutcome,
        row.actionReason,
        row.policyUrl,
        row.sessionId,
        row.ipAddress,
        row.userAgent,
        row.breakGlass,
        row.breakGlassReason,
        row.ibActorClassification,
        row.ibException,
        row.agentOps?.agent_identity,
        row.agentOps?.attempted_action ? JSON.stringify(row.agentOps.attempted_action) : null,
        row.agentOps?.target_fhir_resource ? JSON.stringify(row.agentOps.target_fhir_resource) : null,
        row.agentOps?.threshold_class,
        row.agentOps?.verdict,
        row.agentOps?.rationale ? JSON.stringify(row.agentOps.rationale) : null,
        row.agentOps?.source_identity ? JSON.stringify(row.agentOps.source_identity) : null,
        row.agentOps?.section_171_exception_code,
        row.agentOps?.aiast_tag_confirmation,
        row.agentOps?.initiation_mode,
        row.agentOps?.retention_until,
        row.agentOps?.attempted_payload_full === undefined ? null : JSON.stringify(row.agentOps.attempted_payload_full),
        row.provenanceId,
        row.auditEventId,
        row.createdAt,
      ],
    );
    return pgRowToAuditRecord(result.rows[0]);
  }

  private async projectOrQueue(row: OsodAuditEventRecord): Promise<void> {
    try {
      await this.projectAuditEvent(row);
    } catch (error) {
      this.projectionQueue.enqueue(row, row.eventTime);
      this.projectionQueue.markFailed(row.id, error, row.eventTime);
    }
  }

  private async projectAuditEvent(row: OsodAuditEventRecord): Promise<void> {
    const client = await this.getProjectionClient();
    const auditEvent = buildAuditEventProjection(row);
    try {
      await client.create<AuditEvent>(auditEvent);
    } catch (error) {
      if (
        this.options.medplumAccessToken &&
        this.options.medplumEmail &&
        this.options.medplumPassword &&
        isAuthzProjectionError(error)
      ) {
        this.projectionClient = this.createPasswordProjectionClient();
        await (await this.projectionClient).create<AuditEvent>(auditEvent);
        return;
      }
      throw error;
    }
  }

  private async getProjectionClient(): Promise<MedplumClient> {
    this.projectionClient ??= this.options.medplumAccessToken
      ? Promise.resolve(
          createMedplumClient({
            baseUrl: this.options.medplumBaseUrl ?? "http://localhost:8103",
            accessToken: this.options.medplumAccessToken,
          }),
        )
      : this.createPasswordProjectionClient();
    return this.projectionClient;
  }

  private async createPasswordProjectionClient(): Promise<MedplumClient> {
    const client = createMedplumClient({
      baseUrl: this.options.medplumBaseUrl ?? "http://localhost:8103",
    });
    if (this.options.medplumEmail && this.options.medplumPassword) {
      await client.login(this.options.medplumEmail, this.options.medplumPassword);
    }
    return client;
  }
}

export function createLiveOsodAuditRuntime(
  options: LiveAuditRuntimeOptions = {},
): LiveOsodAuditRuntime {
  return new LiveOsodAuditRuntime(options);
}

function pgRowToAuditRecord(row: Record<string, unknown>): OsodAuditEventRecord {
  return {
    id: String(row.id),
    eventTime: iso(row.event_time),
    eventType: String(row.event_type) as OsodAuditEventType,
    actorId: optionalString(row.actor_id),
    actorRole: optionalString(row.actor_role) as OsodActorRole | undefined,
    patientId: optionalString(row.patient_id),
    resourceType: optionalString(row.resource_type),
    resourceId: optionalString(row.resource_id),
    actionOutcome: String(row.action_outcome) as OsodActionOutcome,
    actionReason: optionalString(row.action_reason),
    policyUrl: optionalString(row.policy_url),
    sessionId: optionalString(row.session_id),
    ipAddress: optionalString(row.ip_address),
    userAgent: optionalString(row.user_agent),
    breakGlass: Boolean(row.break_glass),
    breakGlassReason: optionalString(row.break_glass_reason),
    ibActorClassification: "health-care-provider",
    ibException: optionalString(row.ib_exception) as OsodAuditEventRecord["ibException"],
    agentOps: agentOpsFieldsFromRow(row),
    provenanceId: optionalString(row.provenance_id),
    auditEventId: optionalString(row.audit_event_id),
    createdAt: iso(row.created_at),
  };
}

function agentOpsFieldsFromRow(row: Record<string, unknown>): AgentOpsAuditFields | undefined {
  if (!row.agent_identity) {
    return undefined;
  }
  return {
    agent_identity: String(row.agent_identity),
    attempted_action: jsonValue(row.attempted_action, { tool_name: "unknown", parameters: {} }),
    target_fhir_resource: jsonValue(row.target_fhir_resource, {
      resourceType: optionalString(row.resource_type) ?? "Resource",
      id: optionalString(row.resource_id) ?? "unknown",
      version: null,
    }),
    threshold_class: String(row.threshold_class ?? "HIGH") as AgentOpsAuditFields["threshold_class"],
    verdict: String(row.verdict ?? "confirmation-required") as AgentOpsAuditFields["verdict"],
    rationale: jsonValue(row.rationale, { rule_id: "unknown", rule_version: "unknown" }),
    source_identity: jsonValue(row.source_identity, {
      token_hash: "",
      source_ip: optionalString(row.ip_address) ?? "",
      agent_identity_uri: String(row.agent_identity),
    }),
    section_171_exception_code: optionalString(row.section_171_exception_code) as AgentOpsAuditFields["section_171_exception_code"],
    aiast_tag_confirmation: Boolean(row.aiast_tag_confirmation),
    initiation_mode: String(row.initiation_mode ?? "user-initiated") as AgentOpsAuditFields["initiation_mode"],
    retention_until: iso(row.retention_until),
    attempted_payload_full: row.attempted_payload_full ?? undefined,
  };
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function iso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

function isAuthzProjectionError(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  return status === 401 || status === 403;
}
