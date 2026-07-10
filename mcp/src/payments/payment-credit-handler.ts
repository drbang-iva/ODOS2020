import type { PaymentReconciliation } from "@medplum/fhirtypes";
import type { OsodAuditEventRecord } from "../authz/osodAudit.js";
import { buildPaymentAuditRecord } from "./payment-audit.js";
import {
  applyPaymentCredit,
  paymentSubjectReference,
  queryUnappliedCredits,
  transferPaymentCredit,
  voidPaymentCredit,
} from "./payment-credit-service.js";
import type { PaymentCreditFhirClient } from "./payment-credit-service.js";
import {
  staffMayCharge,
  type AuthenticatedStaff,
  type ChargeHandlerResult,
} from "./payment-charge-handler.js";
import type { PaymentDispatch } from "./payment-config.js";

export interface PaymentCreditHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  lifecycleFhir: PaymentCreditFhirClient;
  dispatch: PaymentDispatch;
  recordAudit(row: OsodAuditEventRecord): Promise<void>;
  now?: () => string;
}

export async function handleApplyCreditRequest(
  deps: PaymentCreditHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ChargeHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader);
  if ("result" in staff) return staff.result;
  const body = objectBody(input.body);
  if ("error" in body) return badRequest(body.error);
  const paymentReference = localReference(body.value.paymentReconciliationReference, "PaymentReconciliation");
  const invoiceReference = localReference(body.value.invoiceReference, "Invoice");
  if (!paymentReference || !invoiceReference) {
    return badRequest("Valid paymentReconciliationReference and invoiceReference are required.");
  }
  const amountCents = positiveCents(body.value.amountCents);
  if (amountCents === undefined) return badRequest("amountCents must be a positive integer number of cents.");

  try {
    const updated = await applyPaymentCredit(deps.lifecycleFhir, {
      paymentReconciliationReference: paymentReference,
      invoiceReference,
      amountCents,
    });
    await auditCredit(deps, staff.staff, updated, "apply");
    return { status: 200, body: updated };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export async function handleTransferCreditRequest(
  deps: PaymentCreditHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ChargeHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader);
  if ("result" in staff) return staff.result;
  const body = objectBody(input.body);
  if ("error" in body) return badRequest(body.error);
  const paymentReference = localReference(body.value.paymentReconciliationReference, "PaymentReconciliation");
  const fromInvoiceReference = localReference(body.value.fromInvoiceReference, "Invoice");
  const toInvoiceReference = localReference(body.value.toInvoiceReference, "Invoice");
  const reason = typeof body.value.reason === "string" ? body.value.reason.trim() : "";
  if (!paymentReference || !fromInvoiceReference || !toInvoiceReference || !reason) {
    return badRequest(
      "Valid paymentReconciliationReference, fromInvoiceReference, toInvoiceReference, and reason are required.",
    );
  }

  try {
    const updated = await transferPaymentCredit(deps.lifecycleFhir, {
      paymentReconciliationReference: paymentReference,
      fromInvoiceReference,
      toInvoiceReference,
    });
    await auditCredit(deps, staff.staff, updated, `transfer:${reason}`);
    return { status: 200, body: updated };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export async function handleVoidCreditRequest(
  deps: PaymentCreditHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ChargeHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader);
  if ("result" in staff) return staff.result;
  const body = objectBody(input.body);
  if ("error" in body) return badRequest(body.error);
  const paymentReference = localReference(body.value.paymentReconciliationReference, "PaymentReconciliation");
  const method = body.value.method;
  if (!paymentReference || (method !== "manual-cash" && method !== "clover")) {
    return badRequest("A valid paymentReconciliationReference and Phase 6a payment method are required.");
  }

  try {
    const adapter = deps.dispatch.getAdapter(method, staff.staff.fhir);
    const updated = await voidPaymentCredit(deps.lifecycleFhir, {
      paymentReconciliationReference: paymentReference,
      method,
      nowIso: deps.now?.() ?? new Date().toISOString(),
      voidAtProcessor: async (transactionId) =>
        (await adapter.void({ transactionId, staffReference: staff.staff.staffReference })).outcome,
    });
    await deps.recordAudit(buildPaymentAuditRecord({
      eventType: "payment.void.attempted",
      staffReference: staff.staff.staffReference,
      actorRole: staff.staff.actorRole,
      patientReference: paymentSubjectReference(updated),
      paymentRecordReference: `PaymentReconciliation/${updated.id}`,
      purpose: "PATIENT_PAYMENT",
      adapterName: method,
      outcome: "success",
      declineReason: "same-day-unapplied-credit-void",
      timestamp: deps.now?.(),
    }));
    return { status: 200, body: updated };
  } catch (error) {
    await deps.recordAudit(buildPaymentAuditRecord({
      eventType: "payment.void.attempted",
      staffReference: staff.staff.staffReference,
      actorRole: staff.staff.actorRole,
      paymentRecordReference: paymentReference,
      purpose: "PATIENT_PAYMENT",
      adapterName: String(method),
      outcome: "failure",
      declineReason: messageOf(error),
      timestamp: deps.now?.(),
    }));
    return badRequest(messageOf(error));
  }
}

export async function handleUnappliedCreditsRequest(
  deps: Pick<PaymentCreditHandlerDeps, "authenticate">,
  input: { authHeader: string | undefined; patientReference?: string },
): Promise<ChargeHandlerResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to view payments." } };
  if (!staffMayCharge(staff.actorRole)) {
    return { status: 403, body: { error: "payment.charge role required" } };
  }
  try {
    const credits = await queryUnappliedCredits(staff.fhir, input.patientReference);
    return { status: 200, body: { credits } };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

async function authorizedStaff(
  deps: Pick<PaymentCreditHandlerDeps, "authenticate">,
  authHeader: string | undefined,
): Promise<{ staff: AuthenticatedStaff } | { result: ChargeHandlerResult }> {
  const staff = await deps.authenticate(authHeader);
  if (!staff) {
    return { result: { status: 401, body: { error: "Authentication required to manage payments." } } };
  }
  if (!staffMayCharge(staff.actorRole)) {
    return { result: { status: 403, body: { error: "payment.charge role required" } } };
  }
  return { staff };
}

async function auditCredit(
  deps: Pick<PaymentCreditHandlerDeps, "recordAudit" | "now">,
  staff: AuthenticatedStaff,
  payment: PaymentReconciliation,
  reason: string,
): Promise<void> {
  await deps.recordAudit(buildPaymentAuditRecord({
    eventType: "payment.credit.applied",
    staffReference: staff.staffReference,
    actorRole: staff.actorRole,
    patientReference: paymentSubjectReference(payment),
    paymentRecordReference: `PaymentReconciliation/${payment.id}`,
    purpose: "PATIENT_PAYMENT",
    adapterName: "credit-ledger",
    outcome: "success",
    declineReason: reason,
    timestamp: deps.now?.(),
  }));
}

function objectBody(raw: unknown): { value: Record<string, unknown> } | { error: string } {
  return typeof raw === "object" && raw !== null
    ? { value: raw as Record<string, unknown> }
    : { error: "Request body must be a JSON object." };
}

function localReference(value: unknown, resourceType: string): string | undefined {
  return typeof value === "string" && new RegExp(`^${resourceType}/[^/]+$`).test(value)
    ? value
    : undefined;
}

function positiveCents(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function badRequest(error: string): ChargeHandlerResult {
  return { status: 400, body: { error } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
