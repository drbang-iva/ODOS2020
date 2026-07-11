import assert from "node:assert/strict";
import { test } from "node:test";
import type { VisionPrescription } from "@medplum/fhirtypes";
import { RX_COLUMNS, visionPrescriptionRows } from "../src/lib/optical-order.js";

function prescription(prism: NonNullable<VisionPrescription["lensSpecification"]>[number]["prism"]): VisionPrescription {
  return {
    resourceType: "VisionPrescription",
    status: "active",
    created: "2026-07-11T00:00:00Z",
    dateWritten: "2026-07-11T00:00:00Z",
    patient: { reference: "Patient/prism-grid" },
    prescriber: { reference: "Practitioner/prism-grid" },
    lensSpecification: [{ product: { text: "lens" }, eye: "right", prism }],
  };
}

test("Rx grid keeps its 19-column dispensary header sequence with distinct identities", () => {
  assert.deepEqual(
    RX_COLUMNS.map((column) => column.label),
    [
      "Sphere", "Cylinder", "Axis", "Dist(PD)", "Near(PD)", "Form", "I/O", "Prism", "U/D", "Prism",
      "BSize", "Base", "Lens CPT", "Remarks", "Add", "Seght", "Eye", "Prism Units", "Prism Pts",
    ],
  );
  assert.equal(new Set(RX_COLUMNS.map((column) => column.key)).size, RX_COLUMNS.length);
});

test("Rx grid projects horizontal and vertical prism entries without overwriting either value", () => {
  const row = visionPrescriptionRows(prescription([
    { amount: 1, base: "up" },
    { amount: 2, base: "in" },
  ]))[0].values;

  assert.equal(row.horizontalPrism, "2");
  assert.equal(row.horizontalBase, "IN");
  assert.equal(row.verticalPrism, "1");
  assert.equal(row.verticalBase, "UP");
  assert.equal(row.base, "in / up");
  assert.equal(row.prismUnits, "3");
  assert.equal(row.prismPoints, "");
});

test("Rx grid leaves the vertical prism fields blank for a base-in-only Rx", () => {
  const row = visionPrescriptionRows(prescription([{ amount: 2, base: "in" }]))[0].values;
  assert.equal(row.horizontalPrism, "2");
  assert.equal(row.horizontalBase, "IN");
  assert.equal(row.verticalPrism, "");
  assert.equal(row.verticalBase, "");
});

test("Rx grid leaves the horizontal prism fields blank for a base-up-only Rx", () => {
  const row = visionPrescriptionRows(prescription([{ amount: 1, base: "up" }]))[0].values;
  assert.equal(row.horizontalPrism, "");
  assert.equal(row.horizontalBase, "");
  assert.equal(row.verticalPrism, "1");
  assert.equal(row.verticalBase, "UP");
});

test("Rx grid keeps every prism-derived field blank when the Rx has no prism", () => {
  const row = visionPrescriptionRows(prescription(undefined))[0].values;
  assert.equal(row.horizontalPrism, "");
  assert.equal(row.horizontalBase, "");
  assert.equal(row.verticalPrism, "");
  assert.equal(row.verticalBase, "");
  assert.equal(row.base, "");
  assert.equal(row.prismUnits, "");
  assert.equal(row.prismPoints, "");
});
