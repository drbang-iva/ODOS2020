import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import { OSOD_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/osodPaymentTender.js";
import { createManualCashAdapter } from "../src/payments/adapters/manual-cash-adapter.js";
import type { ChargeRequest } from "../src/payments/payment-processor-adapter.js";

/** In-memory FHIR client double covering the Pick<MedplumClient, "read" | "update"> the adapter takes. */
function fakeFhir(invoice: Invoice) {
  const store = { invoice: structuredClone(invoice), updates: 0, created: [] as PaymentReconciliation[] };
  return {
    store,
    read: async <T>(resourceType: string, id: string): Promise<T> => {
      assert.equal(resourceType, "Invoice");
      assert.equal(id, "inv1");
      return structuredClone(store.invoice) as T;
    },
    update: async <T>(resourceType: string, _id: string, next: T): Promise<T> => {
      assert.equal(resourceType, "Invoice");
      store.invoice = structuredClone(next) as Invoice;
      store.updates += 1;
      return structuredClone(next);
    },
    create: async <T>(resource: T): Promise<T> => {
      store.created.push(structuredClone(resource) as PaymentReconciliation);
      return { ...(resource as object), id: "prepay-pr-1" } as T;
    },
  };
}

function untenderedInvoice(): Invoice {
  return {
    ...buildOpticalInvoice({
      patientReference: "Patient/p1",
      lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 24400 }],
    }),
    id: "inv1",
  };
}

function chargeRequest(overrides?: Partial<ChargeRequest>): ChargeRequest {
  return {
    amountCents: 24400,
    currency: "USD",
    patientReference: "Patient/p1",
    invoiceReference: "Invoice/inv1",
    staffReference: "Practitioner/staff1",
    description: "Optical order cash payment",
    surface: "manual",
    tender: { code: "CASH" },
    ...overrides,
  };
}

test("manual-cash charge records the tender on the Invoice, balances it, and returns the Invoice as the payment record (no PaymentReconciliation — seam spec §4)", async () => {
  const fhir = fakeFhir(untenderedInvoice());
  const adapter = createManualCashAdapter(fhir, { now: () => "2026-07-05T15:00:00.000Z" });

  const result = await adapter.charge(chargeRequest());

  assert.equal(result.outcome, "success");
  assert.equal(result.amountChargedCents, 24400);
  assert.equal(result.feesCents, 0);
  assert.equal(result.settlementDate, "2026-07-05");
  assert.deepEqual(result.paymentRecord, { resourceType: "Invoice", id: "inv1" });
  assert.match(result.transactionId, /^manual-/);

  // the tender now rides on the Invoice (the shipped cash model), and full payment balances the bill
  const tenderExt = fhir.store.invoice.extension?.find(
    (e) => e.url === OSOD_PAYMENT_TENDER_EXTENSION_URL,
  );
  assert.equal(tenderExt?.valueCodeableConcept?.coding?.[0]?.code, "CASH");
  assert.equal(fhir.store.invoice.date, "2026-07-05T15:00:00.000Z");
  assert.equal(fhir.store.invoice.participant?.[0]?.actor.reference, "Practitioner/staff1");
  assert.equal(fhir.store.invoice.status, "balanced");
  assert.equal(fhir.store.updates, 1);
});

test("a partial cash payment (deposit) records the tender but leaves the Invoice issued", async () => {
  const fhir = fakeFhir(untenderedInvoice());
  const adapter = createManualCashAdapter(fhir, { now: () => "2026-07-05T15:00:00.000Z" });

  const result = await adapter.charge(chargeRequest({ amountCents: 10000 }));

  assert.equal(result.amountChargedCents, 10000);
  assert.equal(fhir.store.invoice.status, "issued");
  const tenderExt = fhir.store.invoice.extension?.find(
    (e) => e.url === OSOD_PAYMENT_TENDER_EXTENSION_URL,
  );
  assert.equal(tenderExt?.valueCodeableConcept?.coding?.[0]?.code, "CASH");
});

test("cash collected before an Invoice exists emits an unallocated PaymentReconciliation", async () => {
  const fhir = fakeFhir(untenderedInvoice());
  const adapter = createManualCashAdapter(fhir, { now: () => "2026-07-10T13:00:00.000Z" });

  const result = await adapter.charge(chargeRequest({ invoiceReference: undefined, amountCents: 7500 }));

  assert.deepEqual(result.paymentRecord, { resourceType: "PaymentReconciliation", id: "prepay-pr-1" });
  assert.equal(fhir.store.updates, 0);
  assert.equal(fhir.store.created.length, 1);
  assert.deepEqual(fhir.store.created[0].detail, []);
  assert.equal(fhir.store.created[0].paymentAmount?.value, 75);
  assert.equal(fhir.store.created[0].extension?.find((extension) =>
    extension.url.endsWith("/osod-payment-subject"))?.valueReference?.reference, "Patient/p1");
  assert.equal(fhir.store.created[0].extension?.find((extension) =>
    extension.url === OSOD_PAYMENT_TENDER_EXTENSION_URL)?.valueCodeableConcept?.coding?.[0]?.code, "CASH");
});

test("manual-cash charge refuses an Invoice that already carries a tender (exactly-one-source anti-drift guard)", async () => {
  const alreadyTendered: Invoice = {
    ...buildOpticalInvoice({
      patientReference: "Patient/p1",
      tender: "CASH",
      lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 24400 }],
    }),
    id: "inv1",
  };
  const fhir = fakeFhir(alreadyTendered);
  const adapter = createManualCashAdapter(fhir);

  await assert.rejects(() => adapter.charge(chargeRequest()), /already .*tender|tender .*already/i);
  assert.equal(fhir.store.updates, 0);
});

test("manual-cash charge accepts only the manual tenders (CASH/CHECK) — card belongs to a processor adapter", async () => {
  const fhir = fakeFhir(untenderedInvoice());
  const adapter = createManualCashAdapter(fhir);

  await assert.rejects(() => adapter.charge(chargeRequest({ tender: { code: "CARD" } })), /payment tender/i);
  await assert.rejects(() => adapter.charge(chargeRequest({ tender: undefined })), /tender/i);
  assert.equal(fhir.store.updates, 0);
});

test("manual-cash charge validates the amount and the invoice reference", async () => {
  const fhir = fakeFhir(untenderedInvoice());
  const adapter = createManualCashAdapter(fhir);

  await assert.rejects(() => adapter.charge(chargeRequest({ amountCents: 0 })), /amountCents/);
  await assert.rejects(() => adapter.charge(chargeRequest({ invoiceReference: "inv1" })), /Invoice\//);
  assert.equal(fhir.store.updates, 0);
});

test("same-day void is available while refund / settle / status remain v0.7 deferrals", async () => {
  const adapter = createManualCashAdapter(fakeFhir(untenderedInvoice()));
  await assert.rejects(
    () => adapter.refund({ transactionId: "t", amountCents: 1, reason: "r", staffReference: "s" }),
    /v0\.7/,
  );
  assert.deepEqual(await adapter.void({ transactionId: "t", staffReference: "s" }), { outcome: "success" });
  await assert.rejects(() => adapter.settle({ settlementDate: "2026-07-05" }), /v0\.7/);
  await assert.rejects(() => adapter.status("t"), /v0\.7/);
});

test("adapter metadata: manual surface, no vendor BAA", () => {
  const adapter = createManualCashAdapter(fakeFhir(untenderedInvoice()));
  assert.equal(adapter.name, "manual-cash");
  assert.equal(adapter.surface, "manual");
  assert.equal(adapter.vendorBaaRequired, false);
});
