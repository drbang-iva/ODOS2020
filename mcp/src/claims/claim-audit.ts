import {
  buildOsodAuditEventRow,
  type OsodActorRole,
  type OsodAuditEventRecord,
  type OsodAuditEventType,
} from "../authz/osodAudit.js";

export const CLAIM_AUDIT_EVENT_TYPES = [
  "claim.submit.completed",
  "claim.submit.failed",
  "eligibility.check.completed",
  "eligibility.check.failed",
  "era.import.completed",
  "era.import.failed",
  "claim.status.checked",
] as const satisfies readonly OsodAuditEventType[];

export type ClaimAuditEventType = (typeof CLAIM_AUDIT_EVENT_TYPES)[number];

export function buildClaimAuditRecord(input: {
  eventType: ClaimAuditEventType;
  staffReference: string;
  actorRole: OsodActorRole;
  patientReference?: string;
  targetReference: string;
  adapterName: "claimmd";
  outcome: "success" | "failure";
  reason?: string;
  timestamp?: string;
}): OsodAuditEventRecord {
  return buildOsodAuditEventRow({
    eventType: input.eventType,
    actorReference: input.staffReference,
    actorRole: input.actorRole,
    patientReference: input.patientReference,
    targetReference: input.targetReference,
    actionOutcome: input.outcome === "success" ? "granted" : "denied",
    actionReason: ["CLAIM_CLEARINGHOUSE", `adapter=${input.adapterName}`, input.reason]
      .filter(Boolean)
      .join(" "),
    eventTime: input.timestamp,
  });
}
