import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OSOD_PAYMENT_TENDER_EXTENSION_URL,
  OSOD_PAYMENT_TENDER_SYSTEM,
  PAYMENT_TENDERS,
  assertPaymentTender,
  paymentTenderExtension,
} from "../src/fhir/osodPaymentTender.js";

test("the payment-tender vocabulary is the Foxfire CASH/CHECK transaction codes", () => {
  const codes = PAYMENT_TENDERS.map((t) => t.code);
  assert.deepEqual(codes, ["CASH", "CHECK"]);
});

test("paymentTenderExtension builds the osod-payment-tender extension with a coded value", () => {
  const ext = paymentTenderExtension("CASH");
  assert.equal(ext.url, OSOD_PAYMENT_TENDER_EXTENSION_URL);
  const coding = ext.valueCodeableConcept?.coding?.[0];
  assert.equal(coding?.system, OSOD_PAYMENT_TENDER_SYSTEM);
  assert.equal(coding?.code, "CASH");
  assert.equal(coding?.display, "Cash");
});

test("assertPaymentTender rejects a tender outside CASH/CHECK (no card/processor in the cash tier)", () => {
  assert.throws(() => assertPaymentTender("CARD"), /payment tender/i);
});
