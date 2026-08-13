import type { Bundle, Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../authz/odosAudit.js";
import { resolveBusinessActionRole } from "../authz/roles.js";
import { buildPaymentAuditRecord } from "./payment-audit.js";
import {
  applyPaymentCredit,
  canVoidPaymentCredit,
  paymentAmountCents,
  paymentMethodForReconciliation,
  paymentSubjectReference,
  paymentTenderCode,
  paymentTenderLabel,
  queryUnappliedCredits,
  transferPaymentCredit,
  unappliedPaymentCents,
  voidPaymentCredit,
} from "./payment-credit-service.js";
import type { PaymentCreditFhirClient } from "./payment-credit-service.js";
import {
  type AuthenticatedStaff,
  type ChargeHandlerResult,
} from "./payment-charge-handler.js";
import type { PaymentDispatch } from "./payment-config.js";
import { StaffRoleServiceUnavailableError } from "./payment-endpoint.js";

export interface PaymentCreditHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  lifecycleFhir: PaymentCreditFhirClient;
  dispatch: PaymentDispatch;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
  now?: () => string;
}

export interface PatientPaymentInvoice {
  reference: string;
  label: string;
  status?: Invoice["status"];
}

export interface PatientPaymentRow {
  paymentReconciliationReference: string;
  status: PaymentReconciliation["status"];
  date: string;
  created: string;
  tenderCode: string;
  tender: string;
  amountCents: number;
  allocatedCents: number;
  unappliedCents: number;
  patientReference: string;
  invoices: PatientPaymentInvoice[];
  method?: "manual-cash" | "clover";
  canVoid: boolean;
}

export async function handleApplyCreditRequest(
  deps: PaymentCreditHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ChargeHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader, "payment.charge");
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
  const staff = await authorizedStaff(deps, input.authHeader, "payment.charge");
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
  const staff = await authorizedStaff(deps, input.authHeader, "payment.void");
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
  let staff: AuthenticatedStaff | null;
  try {
    staff = await deps.authenticate(input.authHeader);
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { status: 503, body: { error: "Payment service temporarily unavailable." } };
    }
    throw error;
  }
  if (!staff) return { status: 401, body: { error: "Authentication required to view payments." } };
  const actorRole = resolveBusinessActionRole(staff.roles ?? [], "billing-context.read");
  if (!actorRole) {
    return { status: 403, body: { error: "billing-context.read role required" } };
  }
  staff = { ...staff, actorRole };
  try {
    const credits = await queryUnappliedCredits(staff.fhir, input.patientReference);
    return { status: 200, body: { credits } };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export async function handlePaymentReconciliationsRequest(
  deps: Pick<PaymentCreditHandlerDeps, "authenticate" | "now">,
  input: {
    authHeader: string | undefined;
    query?: Record<string, unknown>;
  },
): Promise<ChargeHandlerResult> {
  const staff = await authorizedStaff(deps, input.authHeader, "billing-context.read");
  if ("result" in staff) return staff.result;
  const patientReference = queryValue(input.query?.patientReference);
  const startDate = queryValue(input.query?.startDate);
  const endDate = queryValue(input.query?.endDate);
  if (!patientReference || !/^Patient\/[A-Za-z0-9.-]+$/.test(patientReference)) {
    return badRequest('A local "Patient/<id>" patientReference is required.');
  }
  if ((startDate && !isR4Date(startDate)) || (endDate && !isR4Date(endDate))) {
    return badRequest("startDate and endDate must be R4 dates (YYYY-MM-DD).");
  }
  if (startDate && endDate && startDate > endDate) {
    return badRequest("startDate must not be after endDate.");
  }

  try {
    const bundle = await staff.staff.fhir.search<PaymentReconciliation>("PaymentReconciliation", {
      _count: "1000",
      _sort: "-_lastUpdated",
    });
    if (bundle.link?.some((link) => link.relation === "next")) {
      return badRequest("Payment query exceeded one FHIR page; no partial ledger was returned.");
    }
    const payments = bundleResources(bundle)
      .filter((payment) => {
        if (paymentSubjectReference(payment) !== patientReference) return false;
        const date = payment.paymentDate;
        return (!startDate || date >= startDate) && (!endDate || date <= endDate);
      })
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.created.localeCompare(a.created));
    const invoiceReferences = unique(payments.flatMap((payment) =>
      (payment.detail ?? []).flatMap((detail) => {
        const reference = detail.request?.reference;
        return reference && /^Invoice\/[A-Za-z0-9.-]+$/.test(reference) ? [reference] : [];
      }),
    ));
    const invoices = invoiceReferences.length === 0
      ? []
      : bundleResources(await staff.staff.fhir.search<Invoice>("Invoice", {
          _id: invoiceReferences.map((reference) => reference.slice("Invoice/".length)).join(","),
          _count: String(invoiceReferences.length),
        }));
    const invoiceByReference = new Map(invoices.flatMap((invoice) => invoice.id
      ? [[`Invoice/${invoice.id}`, invoice] as const]
      : []));
    const nowIso = deps.now?.() ?? new Date().toISOString();
    return {
      status: 200,
      body: {
        items: payments.map((payment) => patientPaymentRow(
          payment,
          invoiceByReference,
          nowIso,
          Boolean(resolveBusinessActionRole(staff.staff.roles ?? [], "payment.void")),
        )),
      },
    };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export function patientPaymentRow(
  payment: PaymentReconciliation,
  invoiceByReference: ReadonlyMap<string, Invoice>,
  nowIso: string,
  canVoidAuthorized = false,
): PatientPaymentRow {
  if (!payment.id) throw new Error("PaymentReconciliation is missing its id.");
  const patientReference = paymentSubjectReference(payment);
  if (!patientReference) throw new Error("PaymentReconciliation is missing its patient subject.");
  const amountCents = paymentAmountCents(payment);
  const unappliedCents = unappliedPaymentCents(payment);
  let method: "manual-cash" | "clover" | undefined;
  try {
    method = paymentMethodForReconciliation(payment);
  } catch {
    method = undefined;
  }
  return {
    paymentReconciliationReference: `PaymentReconciliation/${payment.id}`,
    status: payment.status,
    date: payment.paymentDate,
    created: payment.created,
    tenderCode: paymentTenderCode(payment),
    tender: paymentTenderLabel(payment),
    amountCents,
    allocatedCents: amountCents - unappliedCents,
    unappliedCents,
    patientReference,
    invoices: unique((payment.detail ?? []).flatMap((detail) => {
      const reference = detail.request?.reference;
      return reference && /^Invoice\/[A-Za-z0-9.-]+$/.test(reference) ? [reference] : [];
    })).map((reference) => {
      const invoice = invoiceByReference.get(reference);
      return {
        reference,
        label: invoice?.identifier?.find((identifier) => identifier.value)?.value ?? reference,
        ...(invoice ? { status: invoice.status } : {}),
      };
    }),
    ...(method ? { method } : {}),
    canVoid: canVoidAuthorized && canVoidPaymentCredit(payment, nowIso),
  };
}

async function authorizedStaff(
  deps: Pick<PaymentCreditHandlerDeps, "authenticate">,
  authHeader: string | undefined,
  businessAction: "billing-context.read" | "payment.charge" | "payment.void",
): Promise<{ staff: AuthenticatedStaff } | { result: ChargeHandlerResult }> {
  let staff: AuthenticatedStaff | null;
  try {
    staff = await deps.authenticate(authHeader);
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { result: { status: 503, body: { error: "Payment service temporarily unavailable." } } };
    }
    throw error;
  }
  if (!staff) {
    return { result: { status: 401, body: { error: "Authentication required to manage payments." } } };
  }
  const actorRole = resolveBusinessActionRole(staff.roles ?? [], businessAction);
  if (!actorRole) {
    return { result: { status: 403, body: { error: `${businessAction} role required` } } };
  }
  return { staff: { ...staff, actorRole } };
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

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isR4Date(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function bundleResources<T extends PaymentReconciliation | Invoice>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function badRequest(error: string): ChargeHandlerResult {
  return { status: 400, body: { error } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
