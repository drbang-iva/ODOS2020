import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpticalChargeItem } from "../src/fhir/opticalCharge.js";

test("buildOpticalChargeItem links the order via supportingInformation (NOT .service) with a priceOverride fee", () => {
  const chargeItem = buildOpticalChargeItem({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    encounterReference: "Encounter/e1",
    code: "V2020",
    codeDisplay: "Frames, purchases",
    feeCents: 18500,
  });

  assert.equal(chargeItem.resourceType, "ChargeItem");
  assert.equal(chargeItem.status, "billable");
  assert.equal(chargeItem.subject.reference, "Patient/p1");
  assert.equal(chargeItem.context?.reference, "Encounter/e1");

  // R4 trap #1: ChargeItem.service CANNOT target DeviceRequest → order link lives in supportingInformation.
  assert.equal(chargeItem.supportingInformation?.[0]?.reference, "DeviceRequest/dr1");
  assert.equal((chargeItem as { service?: unknown }).service, undefined);

  // R4 trap #3: ChargeItem has no unit-price/line-total pair → fee via priceOverride Money.
  assert.equal(chargeItem.priceOverride?.value, 185);
  assert.equal(chargeItem.priceOverride?.currency, "USD");

  const coding = chargeItem.code?.coding?.[0];
  assert.equal(coding?.system, "https://bluebutton.cms.gov/resources/codesystem/hcpcs");
  assert.equal(coding?.code, "V2020");
  assert.equal(coding?.display, "Frames, purchases");
  assert.equal(chargeItem.quantity?.value, 1);
});

test("buildOpticalChargeItem honors a caller-supplied code system (e.g. CPT exam lines, not just HCPCS)", () => {
  const chargeItem = buildOpticalChargeItem({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    code: "92015",
    codeSystem: "http://www.ama-assn.org/go/cpt",
    feeCents: 5000,
  });
  assert.equal(chargeItem.code?.coding?.[0]?.system, "http://www.ama-assn.org/go/cpt");
  assert.equal(chargeItem.code?.coding?.[0]?.code, "92015");
});

test("buildOpticalChargeItem requires a patient subject reference", () => {
  assert.throws(
    () =>
      buildOpticalChargeItem({
        patientReference: "",
        deviceRequestReference: "DeviceRequest/dr1",
        code: "V2020",
        feeCents: 100,
      }),
    /patient|subject/i,
  );
});

test("buildOpticalChargeItem requires the DeviceRequest (glasses order) reference", () => {
  assert.throws(
    () =>
      buildOpticalChargeItem({
        patientReference: "Patient/p1",
        deviceRequestReference: "",
        code: "V2020",
        feeCents: 100,
      }),
    /DeviceRequest|order/i,
  );
});

test("buildOpticalChargeItem requires a procedure code", () => {
  assert.throws(
    () =>
      buildOpticalChargeItem({
        patientReference: "Patient/p1",
        deviceRequestReference: "DeviceRequest/dr1",
        code: "",
        feeCents: 100,
      }),
    /code/i,
  );
});

test("buildOpticalChargeItem rejects a negative or non-integer fee (cents)", () => {
  assert.throws(
    () =>
      buildOpticalChargeItem({
        patientReference: "Patient/p1",
        deviceRequestReference: "DeviceRequest/dr1",
        code: "V2020",
        feeCents: -1,
      }),
    /feeCents|cents/i,
  );
  assert.throws(
    () =>
      buildOpticalChargeItem({
        patientReference: "Patient/p1",
        deviceRequestReference: "DeviceRequest/dr1",
        code: "V2020",
        feeCents: 19.99,
      }),
    /feeCents|cents/i,
  );
});

test("buildOpticalChargeItem records the engine price rule + override reason for the audit-gold diff (Eyefinity best-of-both, spec §5)", () => {
  const chargeItem = buildOpticalChargeItem({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    code: "V2020",
    feeCents: 15000,
    definitionCanonical: "https://odos2020.com/practice/iva/charge-rules/frames/cat-1",
    overrideReason: "Prompt-pay cash discount applied at counter",
  });
  // definitionCanonical points at the ChargeItemDefinition (the engine-suggested base price);
  // priceOverride is the final billed price → the two together are the audit diff.
  assert.deepEqual(chargeItem.definitionCanonical, [
    "https://odos2020.com/practice/iva/charge-rules/frames/cat-1",
  ]);
  assert.equal(chargeItem.priceOverride?.value, 150);
  assert.equal(chargeItem.overrideReason, "Prompt-pay cash discount applied at counter");
});

test("buildOpticalChargeItem omits audit-diff fields when no engine rule/override is supplied", () => {
  const chargeItem = buildOpticalChargeItem({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    code: "V2020",
    feeCents: 15000,
  });
  assert.equal(chargeItem.definitionCanonical, undefined);
  assert.equal(chargeItem.overrideReason, undefined);
});
