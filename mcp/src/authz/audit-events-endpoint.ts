import type { Request, RequestHandler } from "express";
import { resolveBusinessActionRole, type PracticeRoleId } from "./roles.js";
import type { LiveAuditQueryFilters, LiveOdosAuditRuntime } from "./liveAudit.js";
import {
  buildOdosAuditEventRow,
  ODOS_AUDIT_EVENT_TYPES,
  type OdosActionOutcome,
  type OdosAuditEventRecord,
  type OdosAuditEventType,
} from "./odosAudit.js";

// Staff patient History is an explicit change-only surface. Access events such as
// chart.opened and all future event types remain admin-only unless deliberately added here.
export const PATIENT_CHART_CHANGE_EVENT_TYPES = [
  "create",
  "update",
  "patch",
  "transaction",
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
  "era.import.completed",
  "era.import.failed",
  "era.denial.flagged",
  "era.integrity.flagged",
  "era.line-linkage.flagged",
  "era.underpayment.flagged",
  "era.unmatched.flagged",
  "claim.rejected.flagged",
  "claim.status.checked",
  "claim.manual-eob.posted",
  "coverage.write",
  "benefits.manual-entry",
  "document.generate.completed",
  "document.generate.failed",
  "document.print.requested",
  "document.print.completed",
] as const satisfies readonly OdosAuditEventType[];

export interface AuthenticatedAuditStaff {
  staffReference: string;
  roles: PracticeRoleId[];
}

export interface AuditEventsGetDependencies {
  authenticate(authorization: string | undefined): Promise<AuthenticatedAuditStaff | null>;
  audit: Pick<LiveOdosAuditRuntime, "queryRows" | "record" | "recordDenied">;
}

export function createAuditEventsGetHandler(dependencies: AuditEventsGetDependencies): RequestHandler {
  return async (req, res) => {
    try {
      const staff = await dependencies.authenticate(req.header("authorization"));
      if (!staff) {
        res.status(401).json({ error: "staff authentication required" });
        return;
      }

      const requestedFilters = auditRouteFilters(req);
      const patientHistory = auditRouteString(req, "scope") === "patient-history";
      const chartRole = patientHistory && requestedFilters.patientId
        ? resolveBusinessActionRole(staff.roles, "chart.read")
        : undefined;
      const auditRole = resolveBusinessActionRole(staff.roles, "audit.read");
      const actorRole = chartRole ?? auditRole;
      if (!actorRole || (patientHistory && (!chartRole || !requestedFilters.patientId))) {
        await recordDenial(dependencies, req, staff, requestedFilters);
        res.status(403).json({
          error: "audit.read role required",
          actorRole: staff.roles[0] ?? "unknown",
        });
        return;
      }

      const filters: LiveAuditQueryFilters = patientHistory
        ? {
            ...requestedFilters,
            eventTypes: PATIENT_CHART_CHANGE_EVENT_TYPES,
            breakGlassOnly: false,
            excludeBreakGlass: true,
          }
        : requestedFilters;
      const rows = await dependencies.audit.record(
        buildOdosAuditEventRow({
          eventType: "read",
          actorId: staff.staffReference,
          actorRole,
          patientId: filters.patientId,
          resourceType: "odos_audit_events",
          actionOutcome: "granted",
          actionReason: patientHistory ? "patient-chart-history" : "audit-log-review",
          policyUrl: `AccessPolicy/odos-${actorRole}`,
          ipAddress: requestIp(req),
          userAgent: req.header("user-agent"),
        }),
        () => dependencies.audit.queryRows(filters),
      );
      res.json({ actorRole, rows: rows.map(auditRouteJsonRow) });
    } catch (error) {
      console.error("odos-mcp: GET /audit/events failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "audit route failed" });
    }
  };
}

async function recordDenial(
  dependencies: AuditEventsGetDependencies,
  req: Request,
  staff: AuthenticatedAuditStaff,
  filters: LiveAuditQueryFilters,
): Promise<void> {
  const actorRole = staff.roles[0];
  await dependencies.audit.recordDenied(buildOdosAuditEventRow({
    eventType: "denied",
    actorId: staff.staffReference,
    actorRole,
    patientId: filters.patientId,
    resourceType: "odos_audit_events",
    actionOutcome: "denied",
    actionReason: "access-policy-compartment-isolation: audit.read role required",
    policyUrl: actorRole ? `AccessPolicy/odos-${actorRole}` : undefined,
    ipAddress: requestIp(req),
    userAgent: req.header("user-agent"),
  }));
}

function auditRouteFilters(req: Request): LiveAuditQueryFilters {
  const eventTypeValues = auditRouteStringList(req, "event_type", "eventTypes");
  return {
    patientId: auditRouteString(req, "patient_id", "patientId"),
    actorId: auditRouteString(req, "actor_id", "actorId"),
    from: auditRouteString(req, "from"),
    to: auditRouteString(req, "to"),
    eventTypes: eventTypeValues.filter(isOdosAuditEventType),
    outcome: auditRouteOutcome(req),
    breakGlassOnly: auditRouteBoolean(req, "break_glass_only", "breakGlassOnly"),
    limit: auditRouteNumber(req, "limit"),
  };
}

function auditRouteString(req: Request, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = req.query[name];
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return undefined;
}

function auditRouteStringList(req: Request, ...names: string[]): string[] {
  return names.flatMap((name) => {
    const value = req.query[name];
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) => typeof item === "string"
      ? item.split(",").map((part) => part.trim()).filter(Boolean)
      : []);
  });
}

function auditRouteBoolean(req: Request, ...names: string[]): boolean {
  const value = auditRouteString(req, ...names);
  return value === "1" || value === "true";
}

function auditRouteNumber(req: Request, name: string): number | undefined {
  const value = auditRouteString(req, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function auditRouteOutcome(req: Request): OdosActionOutcome | undefined {
  const value = auditRouteString(req, "outcome", "actionOutcome");
  return value === "granted" || value === "denied" ? value : undefined;
}

function isOdosAuditEventType(value: string): value is OdosAuditEventType {
  return ODOS_AUDIT_EVENT_TYPES.includes(value as OdosAuditEventType);
}

function auditRouteJsonRow(row: OdosAuditEventRecord): Record<string, string | boolean | null> {
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

function requestIp(req: Request): string | undefined {
  return req.ip?.replace(/^::ffff:/, "");
}
