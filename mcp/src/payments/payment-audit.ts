import {
  buildOdosAuditEventRow,
  type OdosActorRole,
  type OdosAuditEventRecord,
  type OdosAuditEventType,
} from "../authz/odosAudit.js";

/**
 * Payment audit substrate (v0.6c) — every adapter call lands an odos_audit_events row (and its
 * FHIR AuditEvent projection) alongside the financial record. The 10 payment.* event types are the
 * processor architecture enumeration plus Phase 6a credit application; count and list must stay
 * in lockstep with the registry (v0.55c Lesson 10). The staff member's practice role passes as the actor
 * role — the PAYMENT_INITIATOR notion is carried by the payment.* event family itself.
 */
export const PAYMENT_AUDIT_EVENT_TYPES = [
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
] as const satisfies readonly OdosAuditEventType[];

export type PaymentAuditEventType = (typeof PAYMENT_AUDIT_EVENT_TYPES)[number];

export type PaymentAuditPurpose =
  | "PATIENT_PAYMENT"
  | "INSURANCE_PAYMENT"
  | "REFUND"
  | "FINANCING_AUTHORIZATION";

export interface BuildPaymentAuditRecordInput {
  eventType: PaymentAuditEventType;
  /** The staff member who initiated the transaction (Practitioner / PractitionerRole reference). */
  staffReference: string;
  actorRole: OdosActorRole;
  patientReference?: string;
  /**
   * The payment record the event is about: the PaymentReconciliation for a processor payment, or
   * the Invoice for the manual path and for failed attempts (where no PR exists — seam spec §5).
   */
  paymentRecordReference: string;
  purpose: PaymentAuditPurpose;
  /** Which adapter handled the call (e.g. "manual-cash", "stripe", "clover"). */
  adapterName: string;
  outcome: "success" | "failure";
  declineReason?: string;
  timestamp?: string;
}

export function buildPaymentAuditRecord(input: BuildPaymentAuditRecordInput): OdosAuditEventRecord {
  return buildOdosAuditEventRow({
    eventType: input.eventType,
    actorReference: input.staffReference,
    actorRole: input.actorRole,
    patientReference: input.patientReference,
    targetReference: input.paymentRecordReference,
    actionOutcome: input.outcome === "success" ? "granted" : "denied",
    actionReason: [input.purpose, `adapter=${input.adapterName}`, input.declineReason]
      .filter(Boolean)
      .join(" "),
    eventTime: input.timestamp,
  });
}
