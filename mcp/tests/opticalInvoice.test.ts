import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import { OSOD_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/osodPaymentTender.js";

test("buildOpticalInvoice builds an issued cash Invoice referencing ChargeItems with matching totals + tender extension", () => {
  const invoice = buildOpticalInvoice({
    patientReference: "Patient/p1",
    tender: "CASH",
    lineItems: [
      { chargeItemReference: "ChargeItem/ci-frame", amountCents: 18500 },
      { chargeItemReference: "ChargeItem/ci-lens", amountCents: 12000 },
    ],
  });

  assert.equal(invoice.resourceType, "Invoice");
  assert.equal(invoice.status, "issued");
  assert.equal(invoice.subject?.reference, "Patient/p1");

  // line items reference ChargeItems (chargeItemReference, NOT chargeItemCodeableConcept)
  assert.equal(invoice.lineItem?.length, 2);
  assert.equal(invoice.lineItem?.[0]?.sequence, 1);
  assert.equal(invoice.lineItem?.[0]?.chargeItemReference?.reference, "ChargeItem/ci-frame");
  assert.equal(invoice.lineItem?.[1]?.sequence, 2);
  assert.equal(invoice.lineItem?.[1]?.chargeItemReference?.reference, "ChargeItem/ci-lens");

  const base0 = invoice.lineItem?.[0]?.priceComponent?.find((c) => c.type === "base");
  assert.equal(base0?.amount?.value, 185);
  assert.equal(base0?.amount?.currency, "USD");

  // totals: no adjustments → gross == net == sum of lines (305.00)
  assert.equal(invoice.totalGross?.value, 305);
  assert.equal(invoice.totalNet?.value, 305);
  assert.equal(invoice.totalNet?.currency, "USD");

  // R4 trap #5: the record-only tender lives in the osod-payment-tender extension
  const tenderExt = invoice.extension?.find((e) => e.url === OSOD_PAYMENT_TENDER_EXTENSION_URL);
  assert.equal(tenderExt?.valueCodeableConcept?.coding?.[0]?.code, "CASH");
});

test("buildOpticalInvoice applies a line discount (PPAY) as a discount priceComponent and reduces totalNet", () => {
  const invoice = buildOpticalInvoice({
    patientReference: "Patient/p1",
    tender: "CHECK",
    lineItems: [
      {
        chargeItemReference: "ChargeItem/ci-frame",
        amountCents: 20000,
        discount: { code: "PPAY", amountCents: 2000 },
      },
    ],
  });

  const line = invoice.lineItem?.[0];
  const base = line?.priceComponent?.find((c) => c.type === "base");
  const discount = line?.priceComponent?.find((c) => c.type === "discount");
  assert.equal(base?.amount?.value, 200);
  assert.equal(discount?.amount?.value, 20);
  assert.equal(discount?.code?.coding?.[0]?.code, "PPAY");
  assert.equal(discount?.code?.coding?.[0]?.display, "Prompt Pay Discount");

  // gross = base (200), net = base - discount (180)
  assert.equal(invoice.totalGross?.value, 200);
  assert.equal(invoice.totalNet?.value, 180);
});

test("buildOpticalInvoice carries a CHECK tender", () => {
  const invoice = buildOpticalInvoice({
    patientReference: "Patient/p1",
    tender: "CHECK",
    lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 5000 }],
  });
  const tenderExt = invoice.extension?.find((e) => e.url === OSOD_PAYMENT_TENDER_EXTENSION_URL);
  assert.equal(tenderExt?.valueCodeableConcept?.coding?.[0]?.code, "CHECK");
});

test("buildOpticalInvoice carries native date and standard data-entry participant when supplied", () => {
  const invoice = buildOpticalInvoice({
    patientReference: "Patient/p1",
    tender: "CASH",
    date: "2026-07-15T14:30:00.000Z",
    staffReference: "PractitionerRole/front-1",
    lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 5000 }],
  });
  assert.equal(invoice.date, "2026-07-15T14:30:00.000Z");
  assert.deepEqual(invoice.participant, [{
    role: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
        code: "ENT",
        display: "data entry person",
      }],
    },
    actor: { reference: "PractitionerRole/front-1" },
  }]);
});

test("buildOpticalInvoice with no tender issues the bill untendered (processor path — the tender lives on the PaymentReconciliation)", () => {
  const invoice = buildOpticalInvoice({
    patientReference: "Patient/p1",
    lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 5000 }],
  });
  assert.equal(invoice.status, "issued");
  const tenderExt = invoice.extension?.find((e) => e.url === OSOD_PAYMENT_TENDER_EXTENSION_URL);
  assert.equal(tenderExt, undefined);
  // the bill is otherwise complete — totals still computed
  assert.equal(invoice.totalNet?.value, 50);
});

test("buildOpticalInvoice accepts CARD_MANUAL as record-only and rejects processor tenders", () => {
  const manualCard = buildOpticalInvoice({
    patientReference: "Patient/p1",
    tender: "CARD_MANUAL",
    lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 100 }],
  });
  assert.equal(
    manualCard.extension?.find((extension) => extension.url === OSOD_PAYMENT_TENDER_EXTENSION_URL)
      ?.valueCodeableConcept?.coding?.[0]?.code,
    "CARD_MANUAL",
  );
  assert.throws(
    () =>
      buildOpticalInvoice({
        patientReference: "Patient/p1",
        tender: "CARD",
        lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 100 }],
      }),
    /payment tender/i,
  );
});

test("buildOpticalInvoice requires at least one line item", () => {
  assert.throws(
    () => buildOpticalInvoice({ patientReference: "Patient/p1", tender: "CASH", lineItems: [] }),
    /line item/i,
  );
});

test("buildOpticalInvoice requires a patient (subject) reference", () => {
  assert.throws(
    () =>
      buildOpticalInvoice({
        patientReference: "",
        tender: "CASH",
        lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 100 }],
      }),
    /patient|subject/i,
  );
});
