import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HL7_PAYMENT_TYPE_SYSTEM,
  OSOD_PAYMENT_SURFACE_EXTENSION_URL,
  OSOD_PROCESSOR_FEES_EXTENSION_URL,
  buildPaymentReconciliation,
} from "../src/payments/payment-reconciliation.js";
import { OSOD_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/osodPaymentTender.js";

const chargeInput = {
  outcome: "success" as const,
  createdIso: "2026-07-05T14:30:00.000Z",
  paymentDate: "2026-07-05",
  amountCents: 24400,
  invoiceReference: "Invoice/inv1",
  taskReference: "Task/task1",
  staffReference: "Practitioner/staff1",
  processorTransactionId: "ch_test_abc123",
  processorTransactionSystem: "https://osod.dev/fhir/NamingSystem/stripe-transaction",
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
  assert.equal(pr.paymentIdentifier?.system, "https://osod.dev/fhir/NamingSystem/stripe-transaction");
  assert.equal(pr.paymentIdentifier?.value, "ch_test_abc123");
});

test("buildPaymentReconciliation carries tender, processor fees, and surface as osod extensions", () => {
  const pr = buildPaymentReconciliation(chargeInput);
  const extensions = pr.extension ?? [];

  const tender = extensions.find((e) => e.url === OSOD_PAYMENT_TENDER_EXTENSION_URL);
  assert.equal(tender?.valueCodeableConcept?.coding?.[0]?.code, "CARD");
  assert.equal(tender?.valueCodeableConcept?.coding?.[0]?.display, "VISA ****4242");

  const fees = extensions.find((e) => e.url === OSOD_PROCESSOR_FEES_EXTENSION_URL);
  assert.equal(fees?.valueMoney?.value, 7.38);
  assert.equal(fees?.valueMoney?.currency, "USD");

  const surface = extensions.find((e) => e.url === OSOD_PAYMENT_SURFACE_EXTENSION_URL);
  const surfaceCode = surface?.extension?.find((e) => e.url === "surface");
  assert.equal(surfaceCode?.valueCode, "online");

  // exactly these osod extensions and nothing else — no token-shaped field can ride along (PCI)
  assert.deepEqual(
    extensions.map((e) => e.url).sort(),
    [
      OSOD_PAYMENT_SURFACE_EXTENSION_URL,
      OSOD_PAYMENT_TENDER_EXTENSION_URL,
      OSOD_PROCESSOR_FEES_EXTENSION_URL,
    ].sort(),
  );
});

test("buildPaymentReconciliation maps a pending (authorized, unsettled) charge to outcome queued", () => {
  const pr = buildPaymentReconciliation({ ...chargeInput, outcome: "pending" });
  assert.equal(pr.status, "active");
  assert.equal(pr.outcome, "queued");
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
  const surface = pr.extension?.find((e) => e.url === OSOD_PAYMENT_SURFACE_EXTENSION_URL);
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
    invoiceReference: "Invoice/inv2",
    processorTransactionId: "txn-1",
    processorTransactionSystem: "https://osod.dev/fhir/NamingSystem/manual-transaction",
    surface: "online",
    tender: { code: "CARD" },
  });
  assert.equal(pr.request, undefined);
  assert.equal(pr.requestor, undefined);
  assert.equal(pr.paymentIssuer, undefined);
  assert.equal(pr.disposition, undefined);
  const fees = pr.extension?.find((e) => e.url === OSOD_PROCESSOR_FEES_EXTENSION_URL);
  assert.equal(fees, undefined);
});

test("buildPaymentReconciliation validates the money and the link", () => {
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, amountCents: 0 }), /amountCents/);
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, amountCents: 12.5 }), /amountCents/);
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, invoiceReference: "" }), /invoice/i);
  assert.throws(
    () => buildPaymentReconciliation({ ...chargeInput, processorTransactionId: "" }),
    /transaction/i,
  );
  assert.throws(() => buildPaymentReconciliation({ ...chargeInput, paymentDate: "07/05/2026" }), /paymentDate/);
});
