import type { Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import type { ClaimsApiOptions } from "./claims-worklist";

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

export interface UnappliedCredit {
  paymentReconciliation: PaymentReconciliation;
  unappliedCents: number;
  subjectReference: string;
}

export async function fetchPatientPayments(
  filters: { patientReference: string; startDate?: string; endDate?: string },
  options: ClaimsApiOptions = {},
): Promise<PatientPaymentRow[]> {
  const query = new URLSearchParams({ patientReference: filters.patientReference });
  if (filters.startDate) query.set("startDate", filters.startDate);
  if (filters.endDate) query.set("endDate", filters.endDate);
  const body = await requestJson<{ items?: PatientPaymentRow[] }>(
    `/payments/reconciliations?${query.toString()}`,
    {},
    options,
  );
  return body.items ?? [];
}

export async function fetchUnappliedCredits(
  patientReference: string,
  options: ClaimsApiOptions = {},
): Promise<UnappliedCredit[]> {
  const query = new URLSearchParams({ patientReference });
  const body = await requestJson<{ credits?: UnappliedCredit[] }>(
    `/payments/credit/unapplied?${query.toString()}`,
    {},
    options,
  );
  return body.credits ?? [];
}

export async function applyPatientCredit(
  input: { paymentReconciliationReference: string; invoiceReference: string; amountCents: number },
  options: ClaimsApiOptions = {},
): Promise<PaymentReconciliation> {
  return requestJson<PaymentReconciliation>(
    "/payments/credit/apply",
    { method: "POST", body: JSON.stringify(input) },
    options,
  );
}

export async function transferPatientCredit(
  input: {
    paymentReconciliationReference: string;
    fromInvoiceReference: string;
    toInvoiceReference: string;
    reason: string;
  },
  options: ClaimsApiOptions = {},
): Promise<PaymentReconciliation> {
  return requestJson<PaymentReconciliation>(
    "/payments/credit/transfer",
    { method: "POST", body: JSON.stringify(input) },
    options,
  );
}

export async function voidPatientCredit(
  input: { paymentReconciliationReference: string; method: "manual-cash" | "clover" },
  options: ClaimsApiOptions = {},
): Promise<PaymentReconciliation> {
  return requestJson<PaymentReconciliation>(
    "/payments/credit/void",
    { method: "POST", body: JSON.stringify(input) },
    options,
  );
}

async function requestJson<T>(path: string, init: RequestInit, options: ClaimsApiOptions): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? "").replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as { error?: string } : {};
  if (!response.ok) throw new Error(body.error ?? `Patient payment request failed with HTTP ${response.status}.`);
  return body as T;
}
