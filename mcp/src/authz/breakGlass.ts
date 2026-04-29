import {
  buildOsodAuditEventRow,
  buildPlaceholderAuditEvent,
  type OsodAuditEventRow,
} from "./osodAudit.js";
import { buildProjectMembershipAccess, type PracticeRoleId } from "./roles.js";

export const BREAK_GLASS_POLICY_URL = "https://osod.dev/fhir/AccessPolicy/break-glass";
export const DEFAULT_BREAK_GLASS_DURATION_MINUTES = 60;

export interface BreakGlassRequest {
  actorReference?: string;
  actorDisplay?: string;
  actorRole: PracticeRoleId;
  patientReference: string;
  reason: string;
  requestedAt?: string;
  durationMinutes?: number;
  source: "human-ui" | "agent";
}

export interface BreakGlassGrant {
  policyUrl: string;
  patientReference: string;
  actorReference?: string;
  actorRole: PracticeRoleId;
  reason: string;
  grantedAt: string;
  expiresAt: string;
  adminReviewRequired: true;
  membershipAccess: ReturnType<typeof buildProjectMembershipAccess>;
}

export interface BreakGlassResult {
  grant: BreakGlassGrant;
  auditRow: OsodAuditEventRow;
  auditEvent: ReturnType<typeof buildPlaceholderAuditEvent>;
}

export function invokeBreakGlass(input: BreakGlassRequest): BreakGlassResult {
  assertHumanBreakGlassRequest(input);
  const grantedAt = input.requestedAt ?? new Date().toISOString();
  const durationMinutes = input.durationMinutes ?? DEFAULT_BREAK_GLASS_DURATION_MINUTES;
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error("Break-glass duration must be a positive number of minutes.");
  }

  const expiresAt = new Date(Date.parse(grantedAt) + durationMinutes * 60_000).toISOString();
  const grant: BreakGlassGrant = {
    policyUrl: BREAK_GLASS_POLICY_URL,
    patientReference: input.patientReference,
    actorReference: input.actorReference,
    actorRole: input.actorRole,
    reason: input.reason.trim(),
    grantedAt,
    expiresAt,
    adminReviewRequired: true,
    membershipAccess: buildProjectMembershipAccess({
      policyReference: "AccessPolicy/break-glass",
      parameters: { patientCompartmentReference: input.patientReference },
    }),
  };
  const auditRow = buildOsodAuditEventRow({
    eventType: "break-glass.granted",
    occurredAt: grantedAt,
    actorReference: input.actorReference,
    actorDisplay: input.actorDisplay,
    actorRole: input.actorRole,
    patientReference: input.patientReference,
    outcome: "success",
    outcomeDescription: `Break-glass access granted until ${expiresAt}.`,
    policyUrl: BREAK_GLASS_POLICY_URL,
    reason: grant.reason,
    adminReviewRequired: true,
  });

  return {
    grant,
    auditRow,
    auditEvent: buildPlaceholderAuditEvent(auditRow),
  };
}

export function assertBreakGlassGrantActive(
  grant: Pick<BreakGlassGrant, "expiresAt" | "patientReference">,
  now: string | Date = new Date(),
): void {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (nowMs > Date.parse(grant.expiresAt)) {
    throw new Error(
      `Break-glass access for ${grant.patientReference} expired at ${grant.expiresAt}.`,
    );
  }
}

export function assertHumanBreakGlassRequest(input: BreakGlassRequest): void {
  if (input.source !== "human-ui") {
    throw new Error(
      "Mandate 8 boundary: an MCP agent cannot initiate break-glass on its own behalf; human-attested reason is required.",
    );
  }

  if (!input.reason.trim()) {
    throw new Error("Break-glass reason is mandatory free text.");
  }

  if (!input.patientReference.startsWith("Patient/")) {
    throw new Error("Break-glass patientReference must be Patient/<id>.");
  }
}
