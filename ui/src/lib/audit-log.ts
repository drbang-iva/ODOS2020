export const AUDIT_EVENT_TYPES = [
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
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditOutcome = "granted" | "denied";
export type AuditReviewRole =
  | "auditor"
  | "practice-admin"
  | "clinician"
  | "front-desk"
  | "aesthetics-provider"
  | "system"
  | "unknown";

export interface AuditLogRow {
  id: string;
  eventTime: string;
  eventType: AuditEventType;
  actorId?: string | null;
  actorRole?: string | null;
  patientId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  actionOutcome: AuditOutcome;
  actionReason?: string | null;
  policyUrl?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  breakGlass: boolean;
  breakGlassReason?: string | null;
  ibActorClassification: "health-care-provider";
  ibException?: string | null;
  provenanceId?: string | null;
  auditEventId?: string | null;
  createdAt: string;
}

export interface AuditLogFilters {
  patientId?: string;
  actorId?: string;
  from: string;
  to: string;
  eventTypes: AuditEventType[];
  outcome?: AuditOutcome;
  breakGlassOnly: boolean;
}

export const AUDIT_REVIEW_ALLOWED_ROLES: AuditReviewRole[] = ["auditor", "practice-admin"];

export const AUDIT_LOG_SCHEMA_COLUMNS = [
  "id",
  "eventTime",
  "eventType",
  "actorId",
  "actorRole",
  "patientId",
  "resourceType",
  "resourceId",
  "actionOutcome",
  "actionReason",
  "policyUrl",
  "sessionId",
  "ipAddress",
  "userAgent",
  "breakGlass",
  "breakGlassReason",
  "ibActorClassification",
  "ibException",
  "provenanceId",
  "auditEventId",
  "createdAt",
] as const;

export function canReviewAuditLog(role: AuditReviewRole): boolean {
  return AUDIT_REVIEW_ALLOWED_ROLES.includes(role);
}

export function filterAuditLogRows(
  rows: readonly AuditLogRow[],
  filters: AuditLogFilters,
): AuditLogRow[] {
  const fromMs = Date.parse(filters.from);
  const toMs = Date.parse(filters.to);
  return rows
    .filter((row) => {
      const eventMs = Date.parse(row.eventTime);
      if (eventMs < fromMs || eventMs > toMs) return false;
      if (filters.patientId && row.patientId !== filters.patientId) return false;
      if (filters.actorId && row.actorId !== filters.actorId) return false;
      if (filters.eventTypes.length && !filters.eventTypes.includes(row.eventType)) return false;
      if (filters.outcome && row.actionOutcome !== filters.outcome) return false;
      if (filters.breakGlassOnly && !row.breakGlass) return false;
      return true;
    })
    .sort((a, b) => b.eventTime.localeCompare(a.eventTime));
}

export function exportAuditRowsAsJson(rows: readonly AuditLogRow[]): string {
  return JSON.stringify(rows.map(normalizeAuditLogRow), null, 2);
}

export function exportAuditRowsAsCsv(rows: readonly AuditLogRow[]): string {
  const lines = [
    AUDIT_LOG_SCHEMA_COLUMNS.join(","),
    ...rows.map((row) =>
      AUDIT_LOG_SCHEMA_COLUMNS.map((header) => csvEscape(String(normalizeAuditLogRow(row)[header] ?? ""))).join(","),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export async function fetchAuditLogRows(
  filters: AuditLogFilters,
  role: AuditReviewRole,
  actorId = "audit-ui",
): Promise<AuditLogRow[]> {
  const params = new URLSearchParams();
  if (filters.patientId) params.set("patient_id", filters.patientId);
  if (filters.actorId) params.set("actor_id", filters.actorId);
  params.set("from", filters.from);
  params.set("to", filters.to);
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.breakGlassOnly) params.set("break_glass_only", "true");
  for (const eventType of filters.eventTypes) {
    params.append("event_type", eventType);
  }

  const response = await fetch(`${auditApiBase()}/audit/events?${params.toString()}`, {
    headers: {
      "X-OSOD-Role": role,
      "X-OSOD-Actor-Id": actorId,
    },
  });
  if (!response.ok) {
    throw new Error(`Audit log request failed: ${response.status}`);
  }
  const body = (await response.json()) as { rows?: AuditLogRow[] };
  return (body.rows ?? []).map(normalizeAuditLogRow);
}

export function normalizeAuditLogRow(row: AuditLogRow): AuditLogRow {
  return {
    id: row.id,
    eventTime: row.eventTime,
    eventType: row.eventType,
    actorId: row.actorId ?? null,
    actorRole: row.actorRole ?? null,
    patientId: row.patientId ?? null,
    resourceType: row.resourceType ?? null,
    resourceId: row.resourceId ?? null,
    actionOutcome: row.actionOutcome,
    actionReason: row.actionReason ?? null,
    policyUrl: row.policyUrl ?? null,
    sessionId: row.sessionId ?? null,
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
    breakGlass: row.breakGlass,
    breakGlassReason: row.breakGlassReason ?? null,
    ibActorClassification: row.ibActorClassification,
    ibException: row.ibException ?? null,
    provenanceId: row.provenanceId ?? null,
    auditEventId: row.auditEventId ?? null,
    createdAt: row.createdAt,
  };
}

export function defaultAuditDateRange(now = new Date()): {
  from: string;
  to: string;
} {
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now);
  fromDate.setUTCDate(fromDate.getUTCDate() - 90);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

export function sampleAuditRows(now = new Date("2026-04-29T12:00:00.000Z")): AuditLogRow[] {
  const patientId = "patient-x";
  return [
    {
      id: "audit-1",
      eventTime: isoDaysAgo(now, 1),
      eventType: "read",
      actorId: "clinician-1",
      actorRole: "clinician",
      patientId,
      resourceType: "Patient",
      resourceId: patientId,
      actionOutcome: "granted",
      policyUrl: "AccessPolicy/osod-clinician",
      sessionId: "session-own",
      breakGlass: false,
      ibActorClassification: "health-care-provider",
      createdAt: isoDaysAgo(now, 1),
    },
    {
      id: "audit-2",
      eventTime: isoDaysAgo(now, 7),
      eventType: "denied",
      actorId: "clinician-2",
      actorRole: "clinician",
      patientId,
      resourceType: "Patient",
      resourceId: patientId,
      actionOutcome: "denied",
      actionReason: "access-policy-compartment-isolation",
      policyUrl: "AccessPolicy/osod-clinician",
      sessionId: "session-denied",
      breakGlass: false,
      ibActorClassification: "health-care-provider",
      ibException: "privacy",
      createdAt: isoDaysAgo(now, 7),
    },
    {
      id: "audit-3",
      eventTime: isoDaysAgo(now, 15),
      eventType: "break-glass-invoked",
      actorId: "clinician-3",
      actorRole: "clinician",
      patientId,
      resourceType: "Encounter",
      resourceId: "emergency-encounter",
      actionOutcome: "granted",
      actionReason: "Emergency on-call care.",
      policyUrl: "https://osod.dev/fhir/AccessPolicy/break-glass",
      sessionId: "session-break-glass",
      breakGlass: true,
      breakGlassReason: "Emergency on-call care.",
      ibActorClassification: "health-care-provider",
      createdAt: isoDaysAgo(now, 15),
    },
  ];
}

function auditApiBase(): string {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
  return meta.env?.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function isoDaysAgo(now: Date, days: number): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}
