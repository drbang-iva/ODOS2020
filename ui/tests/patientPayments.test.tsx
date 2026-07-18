import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyPatientCredit,
  fetchPatientPayments,
  fetchUnappliedCredits,
  transferPatientCredit,
  voidPatientCredit,
  type PatientPaymentRow,
  type UnappliedCredit,
} from "../src/lib/patient-payments";
import {
  AllPaymentsTable,
  CreditActionPanel,
  UnappliedCreditsView,
} from "../src/scenes/claims/PatientPayments";

test("patient payments table shows allocation split and plural linked Invoices", () => {
  const html = renderToStaticMarkup(<AllPaymentsTable payments={[row()]} />);
  assert.match(html, /Cash/);
  assert.match(html, /\$100\.00/);
  assert.match(html, /\$60\.00/);
  assert.match(html, /\$40\.00/);
  assert.match(html, /INV-A, INV-B/);
});

test("unapplied-credit cards expose apply, transfer, and only eligible void actions", () => {
  const payment = row();
  const props = {
    credits: [credit()],
    openInvoices: [invoice("invoice-c", "INV-C")],
    onAction: () => undefined,
  };
  const eligible = renderToStaticMarkup(
    <UnappliedCreditsView {...props} paymentByReference={new Map([[payment.paymentReconciliationReference, payment]])} />,
  );
  assert.match(eligible, /Unapplied credit/);
  assert.match(eligible, /\$40\.00/);
  assert.match(eligible, /Cash · collected 2026-07-10/);
  assert.match(eligible, />Apply</);
  assert.match(eligible, />Transfer</);
  assert.match(eligible, />Void</);

  const ineligible = renderToStaticMarkup(
    <UnappliedCreditsView {...props} paymentByReference={new Map([[payment.paymentReconciliationReference, { ...payment, canVoid: false }]])} />,
  );
  assert.doesNotMatch(ineligible, />Void</);
});

test("apply panel uses issued Invoice choices and allows partial dollar input", () => {
  const payment = row();
  const html = renderToStaticMarkup(
    <CreditActionPanel
      action={{ kind: "apply", credit: credit() }}
      payment={payment}
      openInvoices={[invoice("invoice-c", "INV-C")]}
      busy={false}
      onClose={() => undefined}
      onSubmit={() => undefined}
    />,
  );
  assert.match(html, /Open issued Invoice/);
  assert.match(html, /INV-C/);
  assert.match(html, /Partial allocation is allowed/);
  assert.match(html, /value="40\.00"/);
});

test("patient-payment client uses the singular route contract and preserves backend errors", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/payments/credit/void")) {
      return response({ error: "Phase 6a permits only same-day voids." }, 400);
    }
    if (String(input).includes("/payments/reconciliations")) return response({ items: [row()] });
    if (String(input).includes("/payments/credit/unapplied")) return response({ credits: [credit()] });
    return response(payment());
  };
  const options = { authorization: "Bearer test", fetchImpl };
  await fetchPatientPayments({ patientReference: "Patient/patient-1" }, options);
  await fetchUnappliedCredits("Patient/patient-1", options);
  await applyPatientCredit({ paymentReconciliationReference: "PaymentReconciliation/payment-1", invoiceReference: "Invoice/invoice-c", amountCents: 2_000 }, options);
  await transferPatientCredit({ paymentReconciliationReference: "PaymentReconciliation/payment-1", fromInvoiceReference: "Invoice/invoice-a", toInvoiceReference: "Invoice/invoice-c", reason: "correction" }, options);
  await assert.rejects(
    () => voidPatientCredit({ paymentReconciliationReference: "PaymentReconciliation/payment-1", method: "manual-cash" }, options),
    /Phase 6a permits only same-day voids\./,
  );

  assert.deepEqual(calls.map((call) => call.url), [
    "/payments/reconciliations?patientReference=Patient%2Fpatient-1",
    "/payments/credit/unapplied?patientReference=Patient%2Fpatient-1",
    "/payments/credit/apply",
    "/payments/credit/transfer",
    "/payments/credit/void",
  ]);
  assert.ok(calls.every((call) => (call.init?.headers as Record<string, string>).Authorization === "Bearer test"));
});

function row(): PatientPaymentRow {
  return {
    paymentReconciliationReference: "PaymentReconciliation/payment-1",
    status: "active",
    date: "2026-07-10",
    created: "2026-07-10T10:00:00.000Z",
    tenderCode: "CASH",
    tender: "Cash",
    amountCents: 10_000,
    allocatedCents: 6_000,
    unappliedCents: 4_000,
    patientReference: "Patient/patient-1",
    invoices: [
      { reference: "Invoice/invoice-a", label: "INV-A", status: "issued" },
      { reference: "Invoice/invoice-b", label: "INV-B", status: "issued" },
    ],
    method: "manual-cash",
    canVoid: true,
  };
}

function credit(): UnappliedCredit {
  return { paymentReconciliation: payment(), unappliedCents: 4_000, subjectReference: "Patient/patient-1" };
}

function payment(): PaymentReconciliation {
  return {
    resourceType: "PaymentReconciliation",
    id: "payment-1",
    status: "active",
    created: "2026-07-10T10:00:00.000Z",
    paymentDate: "2026-07-10",
    paymentAmount: { value: 100, currency: "USD" },
    detail: [
      { request: { reference: "Invoice/invoice-a" }, amount: { value: 40, currency: "USD" } },
      { request: { reference: "Invoice/invoice-b" }, amount: { value: 20, currency: "USD" } },
    ],
  };
}

function invoice(id: string, identifier: string): Invoice {
  return { resourceType: "Invoice", id, status: "issued", identifier: [{ value: identifier }], subject: { reference: "Patient/patient-1" } };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
