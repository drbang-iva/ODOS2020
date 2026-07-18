import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HL7_PAYMENT_TYPE_SYSTEM,
  ODOS_PAYMENT_SUBJECT_EXTENSION_URL,
  ODOS_PAYMENT_SURFACE_EXTENSION_URL,
  ODOS_PROCESSOR_FEES_EXTENSION_URL,
  buildPaymentReconciliation,
} from "../src/payments/payment-reconciliation.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/odosPaymentTender.js";

const chargeInput = {
  outcome: "success" as const,
  createdIso: "2026-07-05T14:30:00.000Z",
  paymentDate: "2026-07-05",
  amountCents: 24400,
  subjectReference: "Patient/p1",
  invoiceReference: "Invoice/inv1",
  taskReference: "Task/task1",
  staffReference: "Practitioner/staff1",
  processorTransactionId: "ch_test_abc123",
  processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/stripe-transaction",
  feesCents: 738,
  surface: "online" as const,
  tender: { code: "CARD", display: "VISA ****4242" },
  practiceOrgReference: "Organization/practice1",
  description: "Optical order card payment",
};

test("buildPaymentReconciliation settles an Invoice: detail[0].request → Invoice is THE LINK (seam spec §2/§5)", () => {
  const pr = buildPaymentReconciliation(chargeInput);

  assert.equal(pr.resourceType, "PaymentReconciliation");
  assert.equal(pr.status, "active");
  assert.equal(pr.outcome, "complete");
  assert.equal(pr.created, "2026-07-05T14:30:00.000Z");
  assert.equal(pr.paymentDate, "2026-07-05");
  assert.equal(pr.paymentAmount?.value, 244);
  assert.equal(pr.paymentAmount?.currency, "USD");

  // THE LINK: the Invoice is the payable this payment settles
  assert.equal(pr.detail?.length, 1);
  assert.equal(pr.detail?.[0]?.request?.reference, "Invoice/inv1");
  assert.equal(pr.detail?.[0]?.amount?.value, 244);
  const detailType = pr.detail?.[0]?.type?.coding?.[0];
  assert.equal(detailType?.system, HL7_PAYMENT_TYPE_SYSTEM);
  assert.equal(detailType?.code, "payment");

  // the order's lifecycle Task + staff attribution + practice merchant org
  assert.equal(pr.request?.reference, "Task/task1");
  assert.equal(pr.requestor?.reference, "Practitioner/staff1");
  assert.equal(pr.paymentIssuer?.reference, "Organization/practice1");
  assert.equal(pr.disposition, "Optical order card payment");

  // the processor's business id for the payment
  assert.equal(pr.paymentIdentifier?.system, "https://odos2020.com/fhir/NamingSystem/stripe-transaction");
  assert.equal(pr.paymentIdentifier?.value, "ch_test_abc123");
});

test("existing bill-then-pay output is byte-for-byte unchanged apart from odos-payment-subject", () => {
  const pr = buildPaymentReconciliation(chargeInput);
  const withoutSubject = {
    ...pr,
    extension: pr.extension?.filter((extension) => extension.url !== ODOS_PAYMENT_SUBJECT_EXTENSION_URL),
  };
  assert.deepEqual(withoutSubject, {
    resourceType: "PaymentReconciliation",
    status: "active",
    outcome: "complete",
    created: "2026-07-05T14:30:00.000Z",
    paymentDate: "2026-07-05",
    paymentAmount: { value: 244, currency: "USD" },
    paymentIdentifier: {
      system: "https://odos2020.com/fhir/NamingSystem/stripe-transaction",
      value: "ch_test_abc123",
    },
    request: { reference: "Task/task1" },
    requestor: { reference: "Practitioner/staff1" },
    paymentIssuer: { reference: "Organization/practice1" },
    disposition: "Optical order card payment",
    detail: [{
      type: {
        coding: [{ system: HL7_PAYMENT_TYPE_SYSTEM, code: "payment", display: "Payment" }],
      },
      request: { reference: "Invoice/inv1" },
      amount: { value: 244, currency: "USD" },
    }],
    extension: [
      {
        url: ODOS_PAYMENT_TENDER_EXTENSION_URL,
        valueCodeableConcept: {
          coding: [{
            system: "https://odos2020.com/fhir/CodeSystem/payment-tender",
            code: "CARD",
            display: "VISA ****4242",
          }],
          text: "VISA ****4242",
        },
      },
      {
        url: ODOS_PROCESSOR_FEES_EXTENSION_URL,
        valueMoney: { value: 7.38, currency: "USD" },
      },
      {
        url: ODOS_PAYMENT_SURFACE_EXTENSION_URL,
        extension: [{ url: "surface", valueCode: "online" }],
      },
    ],
  });
});

test("buildPaymentReconciliation carries tender, processor fees, and surface as odos extensions", () => {
  const pr = buildPaymentReconciliation(chargeInput);
  const extensions = pr.extension ?? [];

  const subject = extensions.find((e) => e.url === ODOS_PAYMENT_SUBJECT_EXTENSION_URL);
  assert.equal(subject?.valueReference?.reference, "Patient/p1");

  const tender = extensions.find((e) => e.url === ODOS_PAYMENT_TENDER_EXTENSION_URL);
  assert.equal(tender?.valueCodeableConcept?.coding?.[0]?.code, "CARD");
  assert.equal(tender?.valueCodeableConcept?.coding?.[0]?.display, "VISA ****4242");

  const fees = extensions.find((e) => e.url === ODOS_PROCESSOR_FEES_EXTENSION_URL);
  assert.equal(fees?.valueMoney?.value, 7.38);
  assert.equal(fees?.valueMoney?.currency, "USD");

  const surface = extensions.find((e) => e.url === ODOS_PAYMENT_SURFACE_EXTENSION_URL);
  const surfaceCode = surface?.extension?.find((e) => e.url === "surface");
  assert.equal(surfaceCode?.valueCode, "online");

  // exactly these odos extensions and nothing else — no token-shaped field can ride along (PCI)
  assert.deepEqual(
    extensions.map((e) => e.url).sort(),
    [
      ODOS_PAYMENT_SURFACE_EXTENSION_URL,
      ODOS_PAYMENT_SUBJECT_EXTENSION_URL,
      ODOS_PAYMENT_TENDER_EXTENSION_URL,
      ODOS_PROCESSOR_FEES_EXTENSION_URL,
    ].sort(),
  );
});

test("buildPaymentReconciliation maps a pending (authorized, unsettled) charge to outcome queued", () => {
  const pr = buildPaymentReconciliation({ ...chargeInput, outcome: "pending" });
  assert.equal(pr.status, "active");
  assert.equal(pr.outcome, "queued");
});

test("buildPaymentReconciliation emits an empty detail[] for pay-before-bill collection", () => {
  const pr = buildPaymentReconciliation({ ...chargeInput, invoiceReference: undefined });
  assert.deepEqual(pr.detail, []);
  assert.equal(
    pr.extension?.find((extension) => extension.url === ODOS_PAYMENT_SUBJECT_EXTENSION_URL)
      ?.valueReference?.reference,
    "Patient/p1",
  );
});

test("buildPaymentReconciliation accepts plural partial allocations and rejects over-allocation", () => {
  const allocations = [
    { invoiceReference: "Invoice/child-1", amountCents: 7500 },
    { invoiceReference: "Invoice/child-2", amountCents: 12500 },
  ];
  const pr = buildPaymentReconciliation({
    ...chargeInput,
    amountCents: 20000,
    invoiceReference: undefined,
    allocations,
  });
  assert.deepEqual(pr.detail?.map((detail) => ({
    invoiceReference: detail.request?.reference,
    amountCents: Math.round((detail.amount?.value ?? 0) * 100),
  })), allocations);
  assert.throws(
    () => buildPaymentReconciliation({
      ...chargeInput,
      amountCents: 19999,
      invoiceReference: undefined,
      allocations,
    }),
    /allocations total|only 19999/i,
  );
});

test("buildPaymentReconciliation refuses declined/failed outcomes — the ledger records money that moved, not attempts", () => {
  assert.throws(
    () => buildPaymentReconciliation({ ...chargeInput, outcome: "declined" as never }),
    /declined|failed|AuditEvent/i,
  );
});

test("buildPaymentReconciliation carries the in-clinic terminal id inside the surface extension", () => {
  const pr = buildPaymentReconciliation({
    ...chargeInput,
    surface: "in-clinic-pos",
    inClinicTerminalId: "clover-mini-front-desk",
  });
  const surface = pr.extension?.find((e) => e.url === ODOS_PAYMENT_SURFACE_EXTENSION_URL);
  assert.equal(surface?.extension?.find((e) => e.url === "surface")?.valueCode, "in-clinic-pos");
  assert.equal(
    surface?.extension?.find((e) => e.url === "terminal-id")?.valueString,
    "clover-mini-front-desk",
  );
});

test("buildPaymentReconciliation omits optional fields cleanly (minimal processor charge)", () => {
  const pr = buildPaymentReconciliation({
    outcome: "success",
    createdIso: "2026-07-05T14:30:00.000Z",
    paymentDate: "2026-07-05",
    amountCents: 5000,
    subjectReference: "Patient/p2",
    invoiceReference: "Invoice/inv2",
    processorTransactionId: "txn-1",
    processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/manual-transaction",
    surface: "online",
    tender: { code: "CARD" },
  });
  assert.equal(pr.request, undefined);
  assert.equal(pr.requestor, undefined);
  assert.equal(pr.paymentIssuer, undefined);
  assert.equal(pr.disposition, undefined);
  const fees = pr.extension?.find((e) => e.url === ODOS_PROCESSOR_FEES_EXTENSION_URL);
  assert.equal(fees, undefined);
});

test("buildPaymentReconciliation validates the money and the link", () => {
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, amountCents: 0 }), /amountCents/);
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, amountCents: 12.5 }), /amountCents/);
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, invoiceReference: "" }), /invoice/i);
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, subjectReference: "p1" }), /Patient/);
  assert.throws(
    () => buildPaymentReconciliation({ ...chargeInput, processorTransactionId: "" }),
    /transaction/i,
  );
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, paymentDate: "07/05/2026" }), /paymentDate/);
});
