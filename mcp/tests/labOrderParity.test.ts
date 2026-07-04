import assert from "node:assert/strict";
import { test } from "node:test";
import type { VisionPrescription } from "@medplum/fhirtypes";
import {
  buildLabOrder as buildMcpLabOrder,
  labOrderToExport as mcpLabOrderToExport,
  renderLabOrderSheet as renderMcpLabOrderSheet,
  type BuildLabOrderInput,
} from "../src/fhir/opticalLabOrder.js";
import {
  buildLabOrder as buildUiLabOrder,
  labOrderToExport as uiLabOrderToExport,
  renderLabOrderSheet as renderUiLabOrderSheet,
} from "../../ui/src/lib/optical-lab-order.js";

const RX: VisionPrescription = {
  resourceType: "VisionPrescription",
  status: "active",
  created: "2026-07-04T00:00:00Z",
  dateWritten: "2026-07-04T00:00:00Z",
  patient: { reference: "Patient/lab-parity" },
  prescriber: { reference: "Practitioner/dr-bang" },
  lensSpecification: [
    { product: { text: "lens" }, eye: "right", sphere: -2.25, cylinder: -0.75, axis: 180, add: 2 },
    {
      product: { text: "lens" },
      eye: "left",
      sphere: -2.5,
      cylinder: -0.5,
      axis: 175,
      add: 2,
      prism: [{ amount: 1.5, base: "in" }],
    },
  ],
};

const INPUT: BuildLabOrderInput = {
  orderId: "ORD-LAB-PARITY",
  orderDate: "2026-07-04",
  lab: "Cherry Optical Lab",
  shipTo: "Independent Vision Associates",
  patientName: "Taylor Test",
  patientRef: "Patient/lab-parity",
  providerName: "Dr. Bang",
  trayNumber: "TR-42",
  visionPrescription: RX,
  lensSpec: {
    jobType: "Frame To Come",
    lensDesign: "PAL",
    lensMaterial: "Polycarbonate",
    treatments: ["AR", "Scratch"],
    specialInstructions: "Edge and mount",
    commentsToLab: "Call before substitutions",
  },
  fitting: { od: { distPd: 31, nearPd: 28, segHeight: 18 }, os: { distPd: 30.5, nearPd: 27.5, segHeight: 18 } },
  frame: {
    brand: "Walkthrough",
    model: "Wayfarer",
    color: "Black",
    eye: "52",
    bridge: "18",
    temple: "140",
    a: "52",
    b: "38",
    ed: "55",
    dbl: "18",
    frameType: "Zyl",
    source: "frame-to-come",
  },
  lensCpt: "CALLER-LENS-CODE",
  frameTraceRef: "trace-lab-parity",
};

test("UI lab-order builder mirrors the MCP builder output", () => {
  assert.deepEqual(buildUiLabOrder(INPUT), buildMcpLabOrder(INPUT));
});

test("UI lab-order sheet renderer mirrors the MCP renderer output", () => {
  const mcpOrder = buildMcpLabOrder(INPUT);
  const uiOrder = buildUiLabOrder(INPUT);
  assert.equal(renderUiLabOrderSheet(uiOrder), renderMcpLabOrderSheet(mcpOrder));
});

test("UI lab-order export envelope mirrors the MCP export envelope", () => {
  const mcpOrder = buildMcpLabOrder(INPUT);
  const uiOrder = buildUiLabOrder(INPUT);
  assert.deepEqual(uiLabOrderToExport(uiOrder), mcpLabOrderToExport(mcpOrder));
});
