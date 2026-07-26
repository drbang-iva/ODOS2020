import assert from "node:assert/strict";
import { test } from "node:test";
import { labOrderFrameFromAttachedFrame, type AttachedFrame } from "../../ui/src/lib/optical-order.js";

const FRAME: AttachedFrame = {
  inventoryId: "frame-1",
  canonicalUrl: "https://odos2020.com/fhir/frames/frame-1",
  upc: "00000000000001",
  brand: "Walkthrough",
  model: "Wayfarer",
  color: "Black",
  eye: "52",
  bridge: "18",
  a: "52",
  b: "38",
  ed: "55",
  dbl: "18",
  temple: "140",
  frameType: "Zyl",
};

test("labOrderFrameFromAttachedFrame maps attached frame fields into the lab-order frame", () => {
  assert.deepEqual(labOrderFrameFromAttachedFrame(FRAME, "stock"), {
    inventoryId: "frame-1",
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
    source: "stock",
  });
});

test("labOrderFrameFromAttachedFrame still carries frame source when no frame is attached", () => {
  assert.deepEqual(labOrderFrameFromAttachedFrame(undefined, "patient-own"), { source: "patient-own" });
});
