import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPTICAL_ORDER_TYPES,
  OSOD_OPTICAL_ORDER_TYPE_SYSTEM,
  assertOpticalOrderType,
  opticalOrderTypeConcept,
} from "../src/fhir/opticalOrderType.js";

test("the optical order type vocabulary is the 5 Foxfire-corpus order types", () => {
  assert.deepEqual(
    OPTICAL_ORDER_TYPES.map((type) => type.code),
    ["rx", "frame-only", "lenses-only", "quote", "gift-card"],
  );
});

test("opticalOrderTypeConcept binds an order type to the local CodeSystem with its display", () => {
  const concept = opticalOrderTypeConcept("frame-only");
  const coding = concept.coding?.[0];
  assert.equal(coding?.system, OSOD_OPTICAL_ORDER_TYPE_SYSTEM);
  assert.equal(coding?.code, "frame-only");
  assert.equal(coding?.display, "Frame Only");
});

test("assertOpticalOrderType rejects a code outside the 5-value vocabulary", () => {
  assert.throws(() => assertOpticalOrderType("contact-lens"), /optical order type/i);
});
