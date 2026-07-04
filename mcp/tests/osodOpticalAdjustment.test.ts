import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OSOD_OPTICAL_ADJUSTMENT_SYSTEM,
  OPTICAL_ADJUSTMENTS,
  opticalAdjustmentDisplay,
} from "../src/fhir/osodOpticalAdjustment.js";

test("the optical adjustment vocabulary holds the Foxfire patient self-pay discount codes (Category DS)", () => {
  const codes = OPTICAL_ADJUSTMENTS.map((a) => a.code);
  for (const expected of ["2PAIR", "CSDIS", "DEYE", "DVSP", "FAMILY", "PPAY"]) {
    assert.ok(codes.includes(expected), `missing adjustment code: ${expected}`);
  }
  assert.ok(OSOD_OPTICAL_ADJUSTMENT_SYSTEM.startsWith("https://osod.dev/"));
});

test("opticalAdjustmentDisplay returns the corpus-verbatim display for a known code", () => {
  assert.equal(opticalAdjustmentDisplay("2PAIR"), "Second Pair Discount");
  assert.equal(opticalAdjustmentDisplay("DVSP"), "VSP Discount");
  assert.equal(opticalAdjustmentDisplay("PPAY"), "Prompt Pay Discount");
});

test("opticalAdjustmentDisplay returns undefined for a practice-custom code (vocabulary is extensible)", () => {
  assert.equal(opticalAdjustmentDisplay("CUSTOMXYZ"), undefined);
});
