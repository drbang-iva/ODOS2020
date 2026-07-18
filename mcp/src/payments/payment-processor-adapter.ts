/**
 * Vendor-neutral payment processor adapter interface (v0.6c payments slice).
 *
 * One concrete adapter per processor lands under ./adapters/; practices configure which adapter(s)
 * they run. Architecture: performance-od decisions/2026-05-05-odos-payment-processor-architecture.md
 * (adapter pattern, three surfaces, PCI scope minimization via processor-side tokenization).
 * Seam refinements: performance-od decisions/2026-07-05-odos-payment-reconciliation-seam-spec.md —
 * the Invoice is the bill, the PaymentReconciliation is the settling payment; a charge therefore
 * normally settles an Invoice, while a pre-payment omits invoiceReference and creates an
 * unallocated PaymentReconciliation. The manual adapter keeps the tendered Invoice as its record
 * except for that no-Invoice-yet cash/check exception.
 */

export type PaymentSurface = "in-clinic-pos" | "online" | "patient-financing" | "manual";

export interface ChargeRequest {
  /** Amount to charge in whole cents. */
  amountCents: number;
  currency: "USD";
  patientReference: string;
  /** The bill this payment settles. Omit only for pay-before-bill collection. */
  invoiceReference?: string;
  encounterReference?: string;
  /** The order's 17-status lifecycle Task (PaymentReconciliation.request). */
  taskReference?: string;
  /** The staff member initiating the transaction (Practitioner / PractitionerRole). */
  staffReference: string;
  /** Human-readable purpose (PaymentReconciliation.disposition). */
  description: string;
  surface: PaymentSurface;
  /** Manual adapter: CASH or CHECK. Processor adapters derive the instrument label themselves. */
  tender?: { code: string; display?: string };
  /** In-clinic POS terminal hardware reference (non-secret). */
  inClinicTerminalId?: string;
  /**
   * Tokenized instrument from the processor's tokenization surface (Stripe Elements / Clover
   * iFrame). Transient — consumed by the processor call and NEVER persisted to any FHIR resource
   * or log (PCI scope minimization; the v0.6c-close lint hard-blocks a persisted token).
   */
  onlinePaymentToken?: string;
  /** Financing platform's application id (patient-financing surface). */
  financingApplicationId?: string;
}

export interface TransactionResult {
  /** The processor's transaction id (locally generated for the manual adapter). */
  transactionId: string;
  /**
   * The canonical FHIR record of this payment: a PaymentReconciliation for processor adapters,
   * the tendered Invoice for the manual adapter (seam spec §4 — cash emits no PR). Present only
   * when outcome is success/pending — money that did not move has no financial record (declined
   * and failed charges are AuditEvent-only, seam spec §5).
   */
  paymentRecord?: { resourceType: "PaymentReconciliation" | "Invoice"; id: string };
  outcome: "success" | "declined" | "pending" | "failed";
  amountChargedCents: number;
  /** Processor fees in whole cents (0 for manual). */
  feesCents: number;
  /** YYYY-MM-DD settlement date when known. */
  settlementDate?: string;
  declineCode?: string;
  declineReason?: string;
}

export interface RefundRequest {
  transactionId: string;
  amountCents: number;
  reason: string;
  staffReference: string;
}

export interface RefundResult {
  refundId: string;
  outcome: "success" | "declined" | "failed";
}

export interface VoidRequest {
  transactionId: string;
  staffReference: string;
}

export interface VoidResult {
  outcome: "success" | "failed";
}

export interface SettleRequest {
  /** YYYY-MM-DD batch settlement date to gather. */
  settlementDate: string;
}

export interface SettlementBatch {
  batchId: string;
  settlementDate: string;
  totalCents: number;
  feesCents: number;
  transactionIds: string[];
}

export type TransactionState =
  | "authorized"
  | "captured"
  | "settled"
  | "refunded"
  | "voided"
  | "declined"
  | "failed"
  | "unknown";

export interface PaymentProcessorAdapter {
  charge(args: ChargeRequest): Promise<TransactionResult>;
  refund(args: RefundRequest): Promise<RefundResult>;
  void(args: VoidRequest): Promise<VoidResult>;
  settle(args: SettleRequest): Promise<SettlementBatch>;
  status(transactionId: string): Promise<TransactionState>;
  readonly name: string;
  readonly surface: PaymentSurface;
  readonly vendorBaaRequired: boolean;
}
