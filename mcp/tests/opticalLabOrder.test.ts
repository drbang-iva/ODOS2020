import assert from "node:assert/strict";
import { test } from "node:test";
import type { VisionPrescription } from "@medplum/fhirtypes";
import { buildLabOrder, labOrderToExport, renderLabOrderSheet } from "../src/fhir/opticalLabOrder.js";

const RX: VisionPrescription = {
  resourceType: "VisionPrescription",
  status: "active",
  created: "2026-07-04T00:00:00Z",
  dateWritten: "2026-07-04T00:00:00Z",
  patient: { reference: "Patient/p1" },
  prescriber: { reference: "Practitioner/dr1" },
  lensSpecification: [
    { product: { text: "lens" }, eye: "right", sphere: -2.25, cylinder: -0.75, axis: 180, add: 2.0 },
    {
      product: { text: "lens" },
      eye: "left",
      sphere: -2.5,
      cylinder: -0.5,
      axis: 175,
      add: 2.0,
      prism: [
        { amount: 1.5, base: "in" },
        { amount: 0.5, base: "up" },
      ],
    },
  ],
};

const BASE = {
  orderId: "ORD-1001",
  orderDate: "2026-07-04",
  lab: "Best Price Digital Lab",
  patientName: "Wanda Walkthrough",
  patientRef: "Patient/p1",
  visionPrescription: RX,
  lensSpec: {
    jobType: "Frame To Come",
    lensDesign: "BP Easy",
    lensMaterial: "Polycarbonate",
    treatments: ["AR", "UV"],
  },
  frameSource: 3,
  frameOwnership: "in-house",
} as const;

test("buildLabOrder assembles header, OD/OS Rx from the VisionPrescription, lens spec, and frame", () => {
  const order = buildLabOrder({
    orderId: "ORD-1001",
    orderDate: "2026-07-04",
    lab: "Best Price Digital Lab",
    patientName: "Wanda Walkthrough",
    patientRef: "Patient/p1",
    visionPrescription: RX,
    lensSpec: {
      jobType: "Frame To Come",
      lensDesign: "BP Easy",
      lensMaterial: "Polycarbonate",
      treatments: ["AR", "UV"],
      specialInstructions: "Rush",
    },
    frameSource: 3,
    frameOwnership: "in-house",
    frame: { brand: "Walkthrough", model: "Wayfarer", color: "Black", frameType: "Zyl", source: "frame-to-come" },
  });

  // header
  assert.equal(order.header.orderId, "ORD-1001");
  assert.equal(order.header.lab, "Best Price Digital Lab");
  assert.equal(order.header.patientName, "Wanda Walkthrough");
  assert.equal(order.header.patientRef, "Patient/p1");

  // OD (right)
  assert.equal(order.rx.od.sphere, -2.25);
  assert.equal(order.rx.od.cylinder, -0.75);
  assert.equal(order.rx.od.axis, 180);
  assert.equal(order.rx.od.add, 2.0);
  assert.equal(order.rx.od.prisms, undefined);

  // OS (left), incl. prism
  assert.equal(order.rx.os.sphere, -2.5);
  assert.equal(order.rx.os.cylinder, -0.5);
  assert.deepEqual(order.rx.os.prisms, [
    { amount: 1.5, base: "in" },
    { amount: 0.5, base: "up" },
  ]);

  // lens spec (caller-supplied, order-level)
  assert.equal(order.lensSpec.jobType, "Frame To Come");
  assert.equal(order.lensSpec.lensDesign, "BP Easy");
  assert.equal(order.lensSpec.lensMaterial, "Polycarbonate");
  assert.deepEqual(order.lensSpec.treatments, ["AR", "UV"]);
  assert.equal(order.lensSpec.specialInstructions, "Rush");

  // frame
  assert.equal(order.frame?.brand, "Walkthrough");
  assert.equal(order.frame?.frameType, "Zyl");
  assert.equal(order.frame?.source, "frame-to-come");
});

test("buildLabOrder carries per-eye fitting measurements (distPd/nearPd/segHeight)", () => {
  const order = buildLabOrder({
    ...BASE,
    fitting: { od: { distPd: 31, segHeight: 18 }, os: { distPd: 30.5, nearPd: 28, segHeight: 18 } },
  });
  assert.equal(order.rx.od.distPd, 31);
  assert.equal(order.rx.od.segHeight, 18);
  assert.equal(order.rx.os.distPd, 30.5);
  assert.equal(order.rx.os.nearPd, 28);
});

test("buildLabOrder passes through lensCpt (data, never asserted) and frameTraceRef", () => {
  const order = buildLabOrder({ ...BASE, lensCpt: "V2781", frameTraceRef: "trace-abc" });
  assert.equal(order.rx.lensCpt, "V2781");
  assert.equal(order.frameTraceRef, "trace-abc");
});

test("buildLabOrder requires orderId, patientName, and lab", () => {
  assert.throws(() => buildLabOrder({ ...BASE, orderId: "" }), /order/i);
  assert.throws(() => buildLabOrder({ ...BASE, patientName: "" }), /patient/i);
  assert.throws(() => buildLabOrder({ ...BASE, lab: "" }), /lab/i);
});

test("DCS FSRC accepts only 0, 1, 3, and 4 with ownership required exactly for 3 and 4", () => {
  assert.equal(buildLabOrder({ ...BASE, frameSource: 0, frameOwnership: undefined }).frameSource, 0);
  assert.equal(buildLabOrder({ ...BASE, frameSource: 1, frameOwnership: undefined }).frameSource, 1);
  assert.equal(buildLabOrder({ ...BASE, frameSource: 3, frameOwnership: "patients-own" }).frameOwnership, "patients-own");
  assert.equal(buildLabOrder({ ...BASE, frameSource: 4, frameOwnership: "in-house" }).frameOwnership, "in-house");
  assert.throws(() => buildLabOrder({ ...BASE, frameSource: 3, frameOwnership: undefined }), /ownership.*required/i);
  assert.throws(() => buildLabOrder({ ...BASE, frameSource: 4, frameOwnership: undefined }), /ownership.*required/i);
  assert.throws(() => buildLabOrder({ ...BASE, frameSource: 0, frameOwnership: "in-house" }), /ownership.*absent/i);
  assert.throws(() => buildLabOrder({ ...BASE, frameSource: 1, frameOwnership: "patients-own" }), /ownership.*absent/i);
  assert.throws(() => buildLabOrder({ ...BASE, frameSource: 2 as 0 }), /0, 1, 3, or 4/);
});

test("frame inventoryId is accepted only for FSRC 4 + in-house", () => {
  const frame = {
    inventoryId: "unit-1",
    brand: "Walkthrough",
    model: "Wayfarer",
    source: "stock" as const,
  };
  assert.equal(buildLabOrder({ ...BASE, frameSource: 4, frameOwnership: "in-house", frame }).frame?.inventoryId, "unit-1");
  assert.throws(
    () => buildLabOrder({ ...BASE, frameSource: 4, frameOwnership: "patients-own", frame }),
    /inventoryId.*FSRC 4 \+ in-house/,
  );
  assert.throws(
    () => buildLabOrder({ ...BASE, frameSource: 3, frameOwnership: "in-house", frame }),
    /inventoryId.*FSRC 4 \+ in-house/,
  );
});

test("buildLabOrder requires at least one eye's Rx in the VisionPrescription", () => {
  assert.throws(
    () => buildLabOrder({ ...BASE, visionPrescription: { ...RX, lensSpecification: [] } }),
    /Rx|eye|prescription/i,
  );
});

test("labOrderToExport wraps the LabOrder in a tagged, versioned, JSON-round-trippable envelope", () => {
  const order = buildLabOrder({
    ...BASE,
    frame: { brand: "Walkthrough", model: "Wayfarer", color: "Black", frameType: "Zyl", source: "frame-to-come" },
  });
  const exported = labOrderToExport(order);
  assert.equal(exported.format, "odos-lab-order");
  assert.equal(exported.version, "0");
  assert.deepEqual(exported.order, order);
  // T1 seam: must be a clean JSON snapshot (no undefined/functions to trip serialization)
  assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported);
});

test("renderLabOrderSheet renders every group with its values", () => {
  const order = buildLabOrder({
    ...BASE,
    providerName: "Dr. Bang",
    trayNumber: "42",
    fitting: { od: { distPd: 31, segHeight: 18 }, os: { distPd: 30.5, segHeight: 18 } },
    frame: { brand: "Walkthrough", model: "Wayfarer", color: "Black", frameType: "Zyl", source: "frame-to-come" },
  });
  const html = renderLabOrderSheet(order);

  assert.match(html, /ORD-1001/); // order id
  assert.match(html, /Best Price Digital Lab/); // lab
  assert.match(html, /Wanda Walkthrough/); // patient
  assert.match(html, /-2\.25/); // OD sphere from the VisionPrescription
  assert.match(html, /180/); // OD axis
  assert.match(html, /1\.5 in \/ 0\.5 up/); // compound OS prism
  assert.match(html, /Frame To Come/); // job type
  assert.match(html, /Polycarbonate/); // material
  assert.match(html, /AR/); // a treatment
  assert.match(html, /Wayfarer/); // frame model
  assert.match(html, /FSRC:<\/b> 3 — Frame-to-come/);
  assert.match(html, /Ownership:<\/b> in-house/);
  assert.match(html, /<table|<section|<div/i); // is HTML
});

test("renderLabOrderSheet shows an em-dash for missing optional fields, never 'undefined'", () => {
  const html = renderLabOrderSheet(buildLabOrder(BASE)); // no frame, fitting, provider, tray
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /—/);
});
