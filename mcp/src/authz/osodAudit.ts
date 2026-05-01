import { randomUUID } from "node:crypto";
import type { AuditEvent, CodeableConcept, Coding } from "@medplum/fhirtypes";
import {
  IB_ACTOR_CLASSIFICATION,
  informationBlockingExceptionForDenial,
  isInformationBlockingException,
  type InformationBlockingException,
} from "../policy/ib-exception-map.js";
import type { PracticeRoleId } from "./roles.js";

export const OSOD_AUDIT_EVENT_TYPE_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/audit-event-type";
export const OSOD_ROLE_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/role";
export const FHIR_AUDIT_EVENT_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/audit-event-type";
export const FHIR_RESTFUL_INTERACTION_SYSTEM = "http://hl7.org/fhir/restful-interaction";
export const OSOD_AUDIT_SOURCE_OBSERVER = "Device/osod-instance";

export const OSOD_AUDIT_EVENT_TYPES = [
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
] as const;

export type OsodAuditEventType = (typeof OSOD_AUDIT_EVENT_TYPES)[number];
export type OsodActionOutcome = "granted" | "denied";
export type OsodAuditOutcome = "success" | "denied" | "error";
export type OsodActorRole = PracticeRoleId | "scribe" | "system" | "autonomous-agent";

export interface OsodAuditEventRecord {
  id: string;
  eventTime: string;
  eventType: OsodAuditEventType;
  actorId?: string;
  actorRole?: OsodActorRole;
  patientId?: string;
  resourceType?: string;
  resourceId?: string;
  actionOutcome: OsodActionOutcome;
  actionReason?: string;
  policyUrl?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  breakGlass: boolean;
  breakGlassReason?: string;
  ibActorClassification: typeof IB_ACTOR_CLASSIFICATION;
  ibException?: InformationBlockingException;
  provenanceId?: string;
  auditEventId?: string;
  createdAt: string;
}

export type OsodAuditEventRow = OsodAuditEventRecord;

export interface BuildOsodAuditEventInput {
  eventType: OsodAuditEventType;
  eventTime?: string;
  occurredAt?: string;
  actorId?: string;
  actorReference?: string;
  actorDisplay?: string;
  actorRole?: OsodActorRole;
  patientId?: string;
  patientReference?: string;
  resourceType?: string;
  resourceId?: string;
  targetReference?: string;
  actionOutcome?: OsodActionOutcome;
  outcome?: OsodAuditOutcome;
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
  provenanceId?: string;
  auditEventId?: string;
}

export interface OcrStyleAuditQuery {
  patientId: string;
  from: string;
  to: string;
  eventTypes?: readonly OsodAuditEventType[];
  actionOutcomes?: readonly OsodActionOutcome[];
  actorId?: string;
  breakGlassOnly?: boolean;
}

export interface OcrStyleAuditResult {
  id: string;
  eventTime: string;
  eventType: OsodAuditEventType;
  actorId?: string;
  actorRole?: OsodActorRole;
  patientId: string;
  resourceType?: string;
  resourceId?: string;
  actionOutcome: OsodActionOutcome;
  actionReason?: string;
  policyUrl?: string;
  breakGlass: boolean;
  breakGlassReason?: string;
  ibActorClassification: typeof IB_ACTOR_CLASSIFICATION;
  ibException?: InformationBlockingException;
  provenanceId?: string;
}

export const OSOD_AUDIT_EVENTS_SCHEMA = {
  tableName: "osod_audit_events",
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

export const OSOD_AUDIT_EVENTS_SCHEMA_STUB = OSOD_AUDIT_EVENTS_SCHEMA;

export const AUDIT_EVENT_PROJECTION_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export function buildOsodAuditEventRow(input: BuildOsodAuditEventInput): OsodAuditEventRecord {
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
    provenanceId: idFromReference(input.provenanceId, "Provenance") ?? input.provenanceId,
    auditEventId: input.auditEventId,
    createdAt: eventTime,
  };
}

export function buildPlaceholderAuditEvent(row: OsodAuditEventRecord): AuditEvent {
  return buildAuditEventProjection(row);
}

export function buildAuditEventProjection(row: OsodAuditEventRecord): AuditEvent {
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
        ...(row.actorId ? { who: { reference: `Practitioner/${row.actorId}` } } : {}),
        requestor: row.actorRole !== "system",
        ...(row.policyUrl ? { policy: [row.policyUrl] } : {}),
      },
    ],
    source: {
      observer: { reference: OSOD_AUDIT_SOURCE_OBSERVER },
    },
    entity: auditEntities(row),
  };
  return auditEvent;
}

export function markAuditEventProjected(
  row: OsodAuditEventRecord,
  auditEventReference: string,
): OsodAuditEventRecord {
  return { ...row, auditEventId: idFromReference(auditEventReference, "AuditEvent") ?? auditEventReference };
}

export function ocrStyleAuditQuery(
  rows: readonly OsodAuditEventRecord[],
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

export class InMemoryOsodAuditRepository {
  readonly rows: OsodAuditEventRecord[];

  constructor(rows: readonly OsodAuditEventRecord[] = []) {
    this.rows = [...rows];
  }

  insert(row: OsodAuditEventRecord): OsodAuditEventRecord {
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
    throw new Error("osod_audit_events append-only trigger guard: UPDATE is forbidden.");
  }

  delete(): never {
    throw new Error("osod_audit_events append-only trigger guard: DELETE is forbidden.");
  }

  truncate(): never {
    throw new Error("osod_audit_events append-only trigger guard: TRUNCATE is forbidden.");
  }
}

export interface ProjectionQueueItem {
  row: OsodAuditEventRecord;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
}

export class AuditEventProjectionQueue {
  readonly pending: ProjectionQueueItem[] = [];

  enqueue(row: OsodAuditEventRecord, now = row.eventTime): ProjectionQueueItem {
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
  auditRow: OsodAuditEventRecord;
  insertAuditRow: (row: OsodAuditEventRecord) => Promise<OsodAuditEventRecord> | OsodAuditEventRecord;
  operation: () => Promise<T> | T;
  projectAuditEvent?: (row: OsodAuditEventRecord, event: AuditEvent) => Promise<string> | string;
  projectionQueue?: AuditEventProjectionQueue;
}): Promise<T> {
  let inserted: OsodAuditEventRecord;
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
      `permission denied: ${input.dbRole} cannot ${input.operation} osod_audit_events`,
    );
  }
  throw new Error(
    `osod_audit_events append-only trigger guard: ${input.operation} is forbidden even for superuser sessions.`,
  );
}

export function assertAuditSessionVisible(input: {
  callerRole: OsodActorRole;
  callerActorId?: string;
  row: OsodAuditEventRecord;
}): void {
  if (input.callerRole === "auditor" || input.callerRole === "practice-admin") {
    return;
  }
  if (input.row.actorId && input.row.actorId === input.callerActorId) {
    return;
  }
  throw new Error(
    "Mandate 8 boundary: MCP cannot read another user's osod_audit_events.session_id.",
  );
}

function normalizeActionOutcome(input: BuildOsodAuditEventInput): OsodActionOutcome {
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
  outcome: OsodActionOutcome,
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

function auditEventTypeCoding(eventType: OsodAuditEventType): Coding {
  if (auditEventSubtype(eventType)) {
    return {
      system: FHIR_AUDIT_EVENT_TYPE_SYSTEM,
      code: "rest",
      display: "Restful Operation",
    };
  }
  return {
    system: OSOD_AUDIT_EVENT_TYPE_SYSTEM,
    code: eventType,
    display: eventType,
  };
}

function auditEventSubtype(eventType: OsodAuditEventType): Coding | undefined {
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

function auditAction(eventType: OsodAuditEventType): AuditEvent["action"] {
  if (eventType === "read" || eventType === "search" || eventType === "history" || eventType === "vread") {
    return "R";
  }
  if (
    eventType === "create" ||
    eventType === "backup-started" ||
    eventType === "restore-started" ||
    eventType === "smart-token-issue" ||
    eventType === "smart-sandbox-register"
  ) {
    return "C";
  }
  if (eventType === "delete-attempt" || eventType === "nullify-attempt" || eventType === "smart-token-revoke") {
    return "D";
  }
  if (
    eventType === "denied" ||
    eventType === "login-failed" ||
    eventType === "preflight-block" ||
    eventType === "smart-scope-rejected"
  ) {
    return "E";
  }
  if (eventType === "smart-introspection" || eventType === "smart-discovery-fetch") {
    return "R";
  }
  return "U";
}

function auditOutcome(row: OsodAuditEventRecord): AuditEvent["outcome"] {
  if (row.actionOutcome === "granted") {
    return "0";
  }
  if (row.eventType === "delete-attempt" || row.eventType === "nullify-attempt") {
    return "12";
  }
  return "8";
}

function roleConcept(role: OsodActorRole): CodeableConcept {
  return {
    text: role,
    coding: [{ system: OSOD_ROLE_CODE_SYSTEM, code: role, display: role }],
  };
}

function auditEntities(row: OsodAuditEventRecord): NonNullable<AuditEvent["entity"]> {
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
  const detail = [
    ...(row.breakGlassReason
      ? [{ type: "break_glass_reason", valueString: row.breakGlassReason }]
      : []),
    ...(row.ibException
      ? [{ type: "ib_exception", valueString: row.ibException }]
      : []),
    { type: "osod_audit_event_id", valueString: row.id },
    ...(row.sessionId ? [{ type: "session_id", valueString: row.sessionId }] : []),
  ];
  if (detail.length) {
    entities.push({ name: "audit-details", detail });
  }
  return entities;
}

function assertAuditEventType(eventType: string): asserts eventType is OsodAuditEventType {
  if (!OSOD_AUDIT_EVENT_TYPES.includes(eventType as OsodAuditEventType)) {
    throw new Error(`Unsupported OSOD audit event_type: ${eventType}`);
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
