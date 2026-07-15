import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OSOD_PAYMENT_TENDER_EXTENSION_URL,
  OSOD_PAYMENT_TENDER_SYSTEM,
  PAYMENT_TENDERS,
  PROCESSOR_PAYMENT_TENDERS,
  assertPaymentTender,
  paymentTenderExtension,
  paymentTenderExtensionForReconciliation,
} from "../src/fhir/osodPaymentTender.js";

test("the record-only payment-tender vocabulary includes cash, check, and manual card", () => {
  const codes = PAYMENT_TENDERS.map((t) => t.code);
  assert.deepEqual(codes, ["CASH", "CHECK", "CARD_MANUAL"]);
});

test("paymentTenderExtension builds the osod-payment-tender extension with a coded value", () => {
  const ext = paymentTenderExtension("CASH");
  assert.equal(ext.url, OSOD_PAYMENT_TENDER_EXTENSION_URL);
  const coding = ext.valueCodeableConcept?.coding?.[0];
  assert.equal(coding?.system, OSOD_PAYMENT_TENDER_SYSTEM);
  assert.equal(coding?.code, "CASH");
  assert.equal(coding?.display, "Cash");
});

test("paymentTenderExtension records CARD_MANUAL without processor metadata", () => {
  const ext = paymentTenderExtension("CARD_MANUAL");
  assert.equal(ext.valueCodeableConcept?.coding?.[0]?.code, "CARD_MANUAL");
  assert.equal(ext.valueCodeableConcept?.coding?.[0]?.display, "Card — manual entry");
});

test("assertPaymentTender rejects a tender outside the three record-only tenders", () => {
  assert.throws(() => assertPaymentTender("CARD"), /payment tender/i);
});

test("the processor-tender vocabulary carries the Foxfire non-cash payment codes plus generic CARD", () => {
  const codes = PROCESSOR_PAYMENT_TENDERS.map((t) => t.code);
  assert.deepEqual(codes, ["CARD", "CCP", "CLOVER", "CARE", "SP_CARD", "SP_ACH", "SP_ACF"]);
});

test("paymentTenderExtensionForReconciliation gives a known processor code its corpus-verbatim display", () => {
  const ext = paymentTenderExtensionForReconciliation({ code: "CLOVER" });
  assert.equal(ext.url, OSOD_PAYMENT_TENDER_EXTENSION_URL);
  const coding = ext.valueCodeableConcept?.coding?.[0];
  assert.equal(coding?.system, OSOD_PAYMENT_TENDER_SYSTEM);
  assert.equal(coding?.code, "CLOVER");
  assert.equal(coding?.display, "Clover Processing");
});

test("paymentTenderExtensionForReconciliation lets the adapter override the display (brand + last-4)", () => {
  const ext = paymentTenderExtensionForReconciliation({ code: "CARD", display: "VISA ****4242" });
  const coding = ext.valueCodeableConcept?.coding?.[0];
  assert.equal(coding?.code, "CARD");
  assert.equal(coding?.display, "VISA ****4242");
});

test("paymentTenderExtensionForReconciliation accepts a practice-custom code verbatim (vocab is practice-extensible)", () => {
  const ext = paymentTenderExtensionForReconciliation({ code: "GIFTCERT" });
  const coding = ext.valueCodeableConcept?.coding?.[0];
  assert.equal(coding?.code, "GIFTCERT");
  assert.equal(coding?.display, undefined);
});

test("paymentTenderExtensionForReconciliation also serves the manual tenders (CASH keeps its display)", () => {
  const ext = paymentTenderExtensionForReconciliation({ code: "CASH" });
  assert.equal(ext.valueCodeableConcept?.coding?.[0]?.display, "Cash");
});

test("paymentTenderExtensionForReconciliation rejects an empty tender code", () => {
  assert.throws(() => paymentTenderExtensionForReconciliation({ code: "" }), /tender code/i);
});
