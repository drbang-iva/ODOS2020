import {
  buildOdosAuditEventRow,
  type OdosActorRole,
  type OdosAuditEventRecord,
  type OdosAuditEventType,
} from "../authz/odosAudit.js";

export const CLAIM_AUDIT_EVENT_TYPES = [
  "claim.submit.completed",
  "claim.submit.failed",
  "eligibility.check.completed",
  "eligibility.check.failed",
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
] as const satisfies readonly OdosAuditEventType[];

export type ClaimAuditEventType = (typeof CLAIM_AUDIT_EVENT_TYPES)[number];

export function buildClaimAuditRecord(input: {
  eventType: ClaimAuditEventType;
  staffReference: string;
  actorRole: OdosActorRole;
  patientReference?: string;
  targetReference: string;
  adapterName: "claimmd" | "stedi" | "manual-eob";
  outcome: "success" | "failure";
  reason?: string;
  timestamp?: string;
}): OdosAuditEventRecord {
  return buildOdosAuditEventRow({
    eventType: input.eventType,
    actorReference: input.staffReference,
    actorRole: input.actorRole,
    patientReference: input.patientReference,
    targetReference: input.targetReference,
    actionOutcome: input.outcome === "success" ? "granted" : "denied",
    actionReason: [
      input.adapterName === "manual-eob" ? "CLAIM_MANUAL_EOB" : "CLAIM_CLEARINGHOUSE",
      `adapter=${input.adapterName}`,
      input.reason,
    ]
      .filter(Boolean)
      .join(" "),
    eventTime: input.timestamp,
  });
}
