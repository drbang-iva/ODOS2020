import { randomUUID } from "node:crypto";
import type { AuditEvent, CodeableConcept, Coding } from "@medplum/fhirtypes";
import {
  IB_ACTOR_CLASSIFICATION,
  informationBlockingExceptionForDenial,
  isInformationBlockingException,
  type InformationBlockingException,
} from "../policy/ib-exception-map.js";
import type { PracticeRoleId } from "./roles.js";
import {
  AGENTOPS_AUDIT_EVENT_TYPES,
  AGENTOPS_RECORD_EXTENSION_URL,
  type AgentOpsAuditFields,
} from "../agentops/types.js";

export const ODOS_AUDIT_EVENT_TYPE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/audit-event-type";
export const ODOS_ROLE_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/role";
export const FHIR_AUDIT_EVENT_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/audit-event-type";
export const FHIR_RESTFUL_INTERACTION_SYSTEM = "http://hl7.org/fhir/restful-interaction";
export const ODOS_AUDIT_SOURCE_OBSERVER = "Device/odos-instance";

export const ODOS_AUDIT_EVENT_TYPES = [
  "read",
  "search",
  "history",
  "vread",
  "create",
  "update",
  "patch",
  "transaction",
  "nullify-attempt",
  "delete-attempt",
  "denied",
  "break-glass-invoked",
  "break-glass-expired",
  "login",
  "logout",
  "login-failed",
  "role-change",
  "policy-change",
  "projectmembership-lifecycle",
  "backup-started",
  "backup-completed",
  "restore-started",
  "restore-completed",
  "external-api-call",
  "preflight-block",
  "noop",
  "smart-token-issue",
  "smart-token-refresh",
  "smart-token-revoke",
  "smart-introspection",
  "smart-discovery-fetch",
  "smart-scope-staged-review",
  "smart-scope-approved",
  "smart-scope-rejected",
  "smart-sandbox-register",
  "smart-app-registered",
  "smart-app-jurisdiction-blocked",
  "smart-app-installed",
  "smart-app-install-rejected",
  "smart-app-removed",
  "smart-app-review-pending",
  "smart-app-metadata-updated",
  "cds.discovery.served",
  "cds.service.registered",
  "cds.service.deactivated",
  "cds.hook.fired",
  "cds.card.rendered",
  "cds.card.rejected_validation",
  "cds.card.suppressed_stale",
  "cds.feedback.accepted",
  "cds.feedback.overridden",
  "bulk_export.kickoff.group",
  "bulk_export.kickoff.patient",
  "bulk_export.kickoff.system",
  "bulk_export.complete",
  "bulk_export.cancelled",
  "bulk_export.rejected",
  "patient_access.token.issued",
  "patient_access.token.revoked",
  "capability_statement.served",
  "catalog_sync.frames.bulk.upserted",
  "catalog_sync.frames.bulk.retired",
  "catalog_sync.frames.run.success",
  "catalog_sync.frames.run.failure",
  "catalog_sync.frames.run.partial",
  "catalog_sync.hcpcs.delta.upserted",
  "catalog_sync.hcpcs.delta.retired",
  "catalog_sync.hcpcs.run.success",
  "catalog_sync.hcpcs.run.failure",
  "catalog.frames.export.csv",
  "practice.frames-data-subscription.toggled",
  "payment.charge.attempted",
  "payment.charge.completed",
  "payment.charge.failed",
  "payment.refund.attempted",
  "payment.refund.completed",
  "payment.void.attempted",
  "payment.credit.applied",
  "payment.settle.batch",
  "payment.financing.preauthorized",
  "payment.financing.declined",
  "claim.submit.completed",
  "claim.submit.failed",
  "eligibility.check.completed",
  "eligibility.check.failed",
  "era.import.completed",
  "era.import.failed",
  "era.denial.flagged",
  "era.line-linkage.flagged",
  "era.underpayment.flagged",
  "era.unmatched.flagged",
  "claim.rejected.flagged",
  "claim.status.checked",
  "claim.manual-eob.posted",
  "coverage.write",
  "benefits.manual-entry",
  "staff.invite",
  ...AGENTOPS_AUDIT_EVENT_TYPES,
] as const;

export type OdosAuditEventType = (typeof ODOS_AUDIT_EVENT_TYPES)[number];
export type OdosActionOutcome = "granted" | "denied";
export type OdosAuditOutcome = "success" | "denied" | "error";
export type OdosActorRole = PracticeRoleId | "scribe" | "system" | "autonomous-agent";

export interface OdosAuditEventRecord {
  id: string;
  eventTime: string;
  eventType: OdosAuditEventType;
  actorId?: string;
  actorRole?: OdosActorRole;
  patientId?: string;
  resourceType?: string;
  resourceId?: string;
  actionOutcome: OdosActionOutcome;
  actionReason?: string;
  policyUrl?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  breakGlass: boolean;
  breakGlassReason?: string;
  ibActorClassification: typeof IB_ACTOR_CLASSIFICATION;
  ibException?: InformationBlockingException;
  agentOps?: AgentOpsAuditFields;
  provenanceId?: string;
  auditEventId?: string;
  createdAt: string;
}

export type OdosAuditEventRow = OdosAuditEventRecord;

export interface BuildOdosAuditEventInput {
  eventType: OdosAuditEventType;
  eventTime?: string;
  occurredAt?: string;
  actorId?: string;
  actorReference?: string;
  actorDisplay?: string;
  actorRole?: OdosActorRole;
  patientId?: string;
  patientReference?: string;
  resourceType?: string;
  resourceId?: string;
  targetReference?: string;
  actionOutcome?: OdosActionOutcome;
  outcome?: OdosAuditOutcome;
  actionReason?: string;
  outcomeDescription?: string;
  policyUrl?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  breakGlass?: boolean;
  breakGlassReason?: string;
  reason?: string;
  ibException?: InformationBlockingException | string;
  agentOps?: AgentOpsAuditFields;
  provenanceId?: string;
  auditEventId?: string;
}

export interface OcrStyleAuditQuery {
  patientId: string;
  from: string;
  to: string;
  eventTypes?: readonly OdosAuditEventType[];
  actionOutcomes?: readonly OdosActionOutcome[];
  actorId?: string;
  breakGlassOnly?: boolean;
}

export interface OcrStyleAuditResult {
  id: string;
  eventTime: string;
  eventType: OdosAuditEventType;
  actorId?: string;
  actorRole?: OdosActorRole;
  patientId: string;
  resourceType?: string;
  resourceId?: string;
  actionOutcome: OdosActionOutcome;
  actionReason?: string;
  policyUrl?: string;
  breakGlass: boolean;
  breakGlassReason?: string;
  ibActorClassification: typeof IB_ACTOR_CLASSIFICATION;
  ibException?: InformationBlockingException;
  provenanceId?: string;
}

export const ODOS_AUDIT_EVENTS_SCHEMA = {
  tableName: "odos_audit_events",
  appendOnly: true,
  columns: [
    "id",
    "event_time",
    "event_type",
    "actor_id",
    "actor_role",
    "patient_id",
    "resource_type",
    "resource_id",
    "action_outcome",
    "action_reason",
    "policy_url",
    "session_id",
    "ip_address",
    "user_agent",
    "break_glass",
    "break_glass_reason",
    "ib_actor_classification",
    "ib_exception",
    "agent_identity",
    "attempted_action",
    "target_fhir_resource",
    "threshold_class",
    "verdict",
    "rationale",
    "source_identity",
    "section_171_exception_code",
    "aiast_tag_confirmation",
    "initiation_mode",
    "retention_until",
    "attempted_payload_full",
    "provenance_id",
    "audit_event_id",
    "created_at",
  ],
  indexes: [
    "(patient_id, event_time DESC)",
    "(actor_id, event_time DESC)",
    "(event_time DESC)",
    "(event_type, event_time DESC)",
  ],
} as const;

export const ODOS_AUDIT_EVENTS_SCHEMA_STUB = ODOS_AUDIT_EVENTS_SCHEMA;

export const AUDIT_EVENT_PROJECTION_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export function buildOdosAuditEventRow(input: BuildOdosAuditEventInput): OdosAuditEventRecord {
  assertAuditEventType(input.eventType);
  const eventTime = input.eventTime ?? input.occurredAt ?? new Date().toISOString();
  const actionOutcome = normalizeActionOutcome(input);
  const actionReason = input.actionReason ?? input.outcomeDescription ?? input.reason;
  const target = parseReference(input.targetReference);
  const ibException = normalizeIbException(input.ibException, actionOutcome, actionReason);

  return {
    id: randomUUID(),
    eventTime,
    eventType: input.eventType,
    actorId: input.actorId ?? idFromReference(input.actorReference, "Practitioner"),
    actorRole: input.actorRole,
    patientId: input.patientId ?? idFromReference(input.patientReference, "Patient"),
    resourceType: input.resourceType ?? target?.resourceType,
    resourceId: input.resourceId ?? target?.id,
    actionOutcome,
    actionReason,
    policyUrl: input.policyUrl,
    sessionId: input.sessionId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    breakGlass: input.breakGlass ?? input.eventType.startsWith("break-glass"),
    breakGlassReason: input.breakGlassReason ?? input.reason,
    ibActorClassification: IB_ACTOR_CLASSIFICATION,
    ibException,
    agentOps: input.agentOps,
    provenanceId: idFromReference(input.provenanceId, "Provenance") ?? input.provenanceId,
    auditEventId: input.auditEventId,
    createdAt: eventTime,
  };
}

export function buildPlaceholderAuditEvent(row: OdosAuditEventRecord): AuditEvent {
  return buildAuditEventProjection(row);
}

export function buildAuditEventProjection(row: OdosAuditEventRecord): AuditEvent {
  const auditEvent: AuditEvent = {
    resourceType: "AuditEvent",
    type: auditEventTypeCoding(row.eventType),
    ...(auditEventSubtype(row.eventType) ? { subtype: [auditEventSubtype(row.eventType)!] } : {}),
    action: auditAction(row.eventType),
    recorded: row.eventTime,
    outcome: auditOutcome(row),
    ...(row.actionReason ? { outcomeDesc: row.actionReason } : {}),
    agent: [
      {
        ...(row.actorRole ? { role: [roleConcept(row.actorRole)] } : {}),
        ...(row.agentOps?.agent_identity
          ? { who: { reference: row.agentOps.agent_identity } }
          : row.actorId
            ? { who: { reference: `Practitioner/${row.actorId}` } }
            : {}),
        requestor: row.actorRole !== "system",
        ...(row.policyUrl ? { policy: [row.policyUrl] } : {}),
      },
    ],
    source: {
      observer: { reference: ODOS_AUDIT_SOURCE_OBSERVER },
    },
    entity: auditEntities(row),
  };
  return auditEvent;
}

export function markAuditEventProjected(
  row: OdosAuditEventRecord,
  auditEventReference: string,
): OdosAuditEventRecord {
  return { ...row, auditEventId: idFromReference(auditEventReference, "AuditEvent") ?? auditEventReference };
}

export function ocrStyleAuditQuery(
  rows: readonly OdosAuditEventRecord[],
  query: OcrStyleAuditQuery,
): OcrStyleAuditResult[] {
  const fromMs = Date.parse(query.from);
  const toMs = Date.parse(query.to);
  return rows
    .filter((row) => {
      if (row.patientId !== query.patientId) return false;
      const time = Date.parse(row.eventTime);
      if (time < fromMs || time > toMs) return false;
      if (query.actorId && row.actorId !== query.actorId) return false;
      if (query.breakGlassOnly && !row.breakGlass) return false;
      if (query.eventTypes && !query.eventTypes.includes(row.eventType)) return false;
      if (query.actionOutcomes && !query.actionOutcomes.includes(row.actionOutcome)) return false;
      return true;
    })
    .sort((a, b) => b.eventTime.localeCompare(a.eventTime))
    .map((row) => ({
      id: row.id,
      eventTime: row.eventTime,
      eventType: row.eventType,
      actorId: row.actorId,
      actorRole: row.actorRole,
      patientId: row.patientId!,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      actionOutcome: row.actionOutcome,
      actionReason: row.actionReason,
      policyUrl: row.policyUrl,
      breakGlass: row.breakGlass,
      breakGlassReason: row.breakGlassReason,
      ibActorClassification: row.ibActorClassification,
      ibException: row.ibException,
      provenanceId: row.provenanceId,
    }));
}

export class InMemoryOdosAuditRepository {
  readonly rows: OdosAuditEventRecord[];

  constructor(rows: readonly OdosAuditEventRecord[] = []) {
    this.rows = [...rows];
  }

  insert(row: OdosAuditEventRecord): OdosAuditEventRecord {
    this.rows.push(row);
    return row;
  }

  queryPatientAccess(query: OcrStyleAuditQuery): OcrStyleAuditResult[] {
    return ocrStyleAuditQuery(this.rows, query);
  }

  countAndLatest(): { count: number; latestEventTime?: string } {
    return {
      count: this.rows.length,
      latestEventTime: [...this.rows].sort((a, b) => b.eventTime.localeCompare(a.eventTime))[0]
        ?.eventTime,
    };
  }

  update(): never {
    throw new Error("odos_audit_events append-only trigger guard: UPDATE is forbidden.");
  }

  delete(): never {
    throw new Error("odos_audit_events append-only trigger guard: DELETE is forbidden.");
  }

  truncate(): never {
    throw new Error("odos_audit_events append-only trigger guard: TRUNCATE is forbidden.");
  }
}

export interface ProjectionQueueItem {
  row: OdosAuditEventRecord;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
}

export class AuditEventProjectionQueue {
  readonly pending: ProjectionQueueItem[] = [];

  enqueue(row: OdosAuditEventRecord, now = row.eventTime): ProjectionQueueItem {
    const item: ProjectionQueueItem = { row, attempts: 0, nextAttemptAt: now };
    this.pending.push(item);
    return item;
  }

  due(now: string): ProjectionQueueItem[] {
    const nowMs = Date.parse(now);
    return this.pending.filter((item) => Date.parse(item.nextAttemptAt) <= nowMs);
  }

  markProjected(rowId: string): void {
    const index = this.pending.findIndex((item) => item.row.id === rowId);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
  }

  markFailed(rowId: string, error: unknown, now = new Date().toISOString()): ProjectionQueueItem {
    const item = this.pending.find((candidate) => candidate.row.id === rowId);
    if (!item) {
      throw new Error(`Projection queue item not found for audit row ${rowId}.`);
    }
    item.attempts += 1;
    item.lastError = error instanceof Error ? error.message : String(error);
    const backoff =
      AUDIT_EVENT_PROJECTION_BACKOFF_MS[
        Math.min(item.attempts - 1, AUDIT_EVENT_PROJECTION_BACKOFF_MS.length - 1)
      ];
    item.nextAttemptAt = new Date(Date.parse(now) + backoff).toISOString();
    return item;
  }
}

export async function executePhiOperationWithAudit<T>(input: {
  auditRow: OdosAuditEventRecord;
  insertAuditRow: (row: OdosAuditEventRecord) => Promise<OdosAuditEventRecord> | OdosAuditEventRecord;
  operation: () => Promise<T> | T;
  projectAuditEvent?: (row: OdosAuditEventRecord, event: AuditEvent) => Promise<string> | string;
  projectionQueue?: AuditEventProjectionQueue;
}): Promise<T> {
  let inserted: OdosAuditEventRecord;
  try {
    inserted = await input.insertAuditRow(input.auditRow);
  } catch (error) {
    throw new Error("audit substrate unavailable: originating PHI operation rolled back", {
      cause: error,
    });
  }

  const result = await input.operation();
  if (input.projectAuditEvent) {
    try {
      const reference = await input.projectAuditEvent(inserted, buildAuditEventProjection(inserted));
      markAuditEventProjected(inserted, reference);
    } catch (error) {
      input.projectionQueue?.enqueue(inserted, inserted.eventTime);
      input.projectionQueue?.markFailed(inserted.id, error, inserted.eventTime);
    }
  }
  return result;
}

export function assertAuditMutationAllowed(input: {
  operation: "UPDATE" | "DELETE" | "TRUNCATE";
  dbRole: "app" | "backup" | "superuser";
}): never {
  if (input.dbRole !== "superuser") {
    throw new Error(
      `permission denied: ${input.dbRole} cannot ${input.operation} odos_audit_events`,
    );
  }
  throw new Error(
    `odos_audit_events append-only trigger guard: ${input.operation} is forbidden even for superuser sessions.`,
  );
}

export function assertAuditSessionVisible(input: {
  callerRole: OdosActorRole;
  callerActorId?: string;
  row: OdosAuditEventRecord;
}): void {
  if (input.callerRole === "auditor" || input.callerRole === "practice-admin") {
    return;
  }
  if (input.row.actorId && input.row.actorId === input.callerActorId) {
    return;
  }
  throw new Error(
    "Mandate 8 boundary: MCP cannot read another user's odos_audit_events.session_id.",
  );
}

function normalizeActionOutcome(input: BuildOdosAuditEventInput): OdosActionOutcome {
  if (input.actionOutcome) {
    return input.actionOutcome;
  }
  if (input.eventType === "denied" || input.outcome === "denied" || input.outcome === "error") {
    return "denied";
  }
  return "granted";
}

function normalizeIbException(
  value: InformationBlockingException | string | undefined,
  outcome: OdosActionOutcome,
  reason: string | undefined,
): InformationBlockingException | undefined {
  if (isInformationBlockingException(value)) {
    return value;
  }
  if (outcome === "denied") {
    return informationBlockingExceptionForDenial(reason);
  }
  return undefined;
}

function auditEventTypeCoding(eventType: OdosAuditEventType): Coding {
  if (auditEventSubtype(eventType)) {
    return {
      system: FHIR_AUDIT_EVENT_TYPE_SYSTEM,
      code: "rest",
      display: "Restful Operation",
    };
  }
  return {
    system: ODOS_AUDIT_EVENT_TYPE_SYSTEM,
    code: eventType,
    display: eventType,
  };
}

function auditEventSubtype(eventType: OdosAuditEventType): Coding | undefined {
  if (
    eventType === "read" ||
    eventType === "search" ||
    eventType === "history" ||
    eventType === "vread" ||
    eventType === "create" ||
    eventType === "update" ||
    eventType === "patch" ||
    eventType === "transaction"
  ) {
    return {
      system: FHIR_RESTFUL_INTERACTION_SYSTEM,
      code: eventType,
      display: eventType,
    };
  }
  return undefined;
}

function auditAction(eventType: OdosAuditEventType): AuditEvent["action"] {
  if (eventType === "read" || eventType === "search" || eventType === "history" || eventType === "vread") {
    return "R";
  }
  if (
    eventType === "create" ||
    eventType === "backup-started" ||
    eventType === "restore-started" ||
    eventType === "smart-token-issue" ||
    eventType === "smart-sandbox-register" ||
    eventType === "smart-app-registered" ||
    eventType === "smart-app-installed"
  ) {
    return "C";
  }
  if (
    eventType === "delete-attempt" ||
    eventType === "nullify-attempt" ||
    eventType === "smart-token-revoke" ||
    eventType === "smart-app-removed"
  ) {
    return "D";
  }
  if (
    eventType === "denied" ||
    eventType === "login-failed" ||
    eventType === "preflight-block" ||
    eventType === "smart-scope-rejected" ||
    eventType === "smart-app-jurisdiction-blocked" ||
    eventType === "smart-app-install-rejected"
  ) {
    return "E";
  }
  if (eventType === "smart-introspection" || eventType === "smart-discovery-fetch") {
    return "R";
  }
  return "U";
}

function auditOutcome(row: OdosAuditEventRecord): AuditEvent["outcome"] {
  if (row.actionOutcome === "granted") {
    return "0";
  }
  if (row.eventType === "delete-attempt" || row.eventType === "nullify-attempt") {
    return "12";
  }
  return "8";
}

function roleConcept(role: OdosActorRole): CodeableConcept {
  return {
    text: role,
    coding: [{ system: ODOS_ROLE_CODE_SYSTEM, code: role, display: role }],
  };
}

function auditEntities(row: OdosAuditEventRecord): NonNullable<AuditEvent["entity"]> {
  const entities: NonNullable<AuditEvent["entity"]> = [];
  if (row.patientId) {
    entities.push({ what: { reference: `Patient/${row.patientId}` }, name: "patient" });
  }
  if (row.resourceType && row.resourceId) {
    const reference = `${row.resourceType}/${row.resourceId}`;
    if (reference !== `Patient/${row.patientId ?? ""}`) {
      entities.push({ what: { reference }, name: "resource" });
    }
  }
  if (row.agentOps?.target_fhir_resource.resourceType && row.agentOps.target_fhir_resource.id) {
    entities.push({
      what: {
        reference: `${row.agentOps.target_fhir_resource.resourceType}/${row.agentOps.target_fhir_resource.id}`,
      },
      name: "agentops-target",
    });
  }
  const detail = [
    ...(row.breakGlassReason
      ? [{ type: "break_glass_reason", valueString: row.breakGlassReason }]
      : []),
    ...(row.ibException
      ? [{ type: "ib_exception", valueString: row.ibException }]
      : []),
    { type: "odos_audit_event_id", valueString: row.id },
    ...(row.sessionId ? [{ type: "session_id", valueString: row.sessionId }] : []),
    ...(row.agentOps
      ? [
          {
            type: "agentops_record",
            valueString: JSON.stringify({
              extension_url: AGENTOPS_RECORD_EXTENSION_URL,
              agent_identity: row.agentOps.agent_identity,
              attempted_action: row.agentOps.attempted_action,
              target_fhir_resource: row.agentOps.target_fhir_resource,
              threshold_class: row.agentOps.threshold_class,
              verdict: row.agentOps.verdict,
              rationale: row.agentOps.rationale,
              source_identity: row.agentOps.source_identity,
              section_171_exception_code: row.agentOps.section_171_exception_code,
              aiast_tag_confirmation: row.agentOps.aiast_tag_confirmation,
              initiation_mode: row.agentOps.initiation_mode,
              retention_until: row.agentOps.retention_until,
            }),
          },
          ...(row.agentOps.attempted_payload_full
            ? [
                {
                  type: "agentops_blocked_payload",
                  valueString: JSON.stringify(row.agentOps.attempted_payload_full),
                },
              ]
            : []),
        ]
      : []),
  ];
  if (detail.length) {
    entities.push({ name: "audit-details", detail });
  }
  return entities;
}

function assertAuditEventType(eventType: string): asserts eventType is OdosAuditEventType {
  if (!ODOS_AUDIT_EVENT_TYPES.includes(eventType as OdosAuditEventType)) {
    throw new Error(`Unsupported ODOS audit event_type: ${eventType}`);
  }
}

function parseReference(reference: string | undefined): { resourceType: string; id: string } | undefined {
  if (!reference) {
    return undefined;
  }
  const [resourceType, id] = reference.split("/");
  if (!resourceType || !id) {
    return undefined;
  }
  return { resourceType, id };
}

function idFromReference(
  value: string | undefined,
  expectedResourceType: string,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseReference(value);
  if (!parsed) {
    return value;
  }
  return parsed.resourceType === expectedResourceType ? parsed.id : value;
}
