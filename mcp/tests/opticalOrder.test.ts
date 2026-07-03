import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSpectacleOrderDeviceRequest, buildOpticalOrderTask } from "../src/fhir/opticalOrder.js";
import { OSOD_OPTICAL_ORDER_STATUS_SYSTEM } from "../src/fhir/opticalOrderStatus.js";

const TASK_STATUS_VOCAB = [
  "draft", "requested", "received", "accepted", "rejected", "ready",
  "cancelled", "in-progress", "on-hold", "failed", "completed", "entered-in-error",
];

test("buildSpectacleOrderDeviceRequest builds an order/active DeviceRequest linking the VisionPrescription and HCPCS frame code", () => {
  const deviceRequest = buildSpectacleOrderDeviceRequest({
    patientReference: "Patient/p1",
    visionPrescriptionReference: "VisionPrescription/vp1",
    hcpcsCode: "V2020",
    hcpcsDisplay: "Frames, purchases",
  });

  assert.equal(deviceRequest.resourceType, "DeviceRequest");
  assert.equal(deviceRequest.status, "active");
  assert.equal(deviceRequest.intent, "order");
  assert.equal(deviceRequest.subject.reference, "Patient/p1");
  assert.equal(deviceRequest.basedOn?.[0]?.reference, "VisionPrescription/vp1");

  const coding = deviceRequest.codeCodeableConcept?.coding?.[0];
  assert.equal(coding?.system, "https://bluebutton.cms.gov/resources/codesystem/hcpcs");
  assert.equal(coding?.code, "V2020");
  assert.equal(coding?.display, "Frames, purchases");
});

test("buildSpectacleOrderDeviceRequest requires a VisionPrescription reference (the spectacle Rx link)", () => {
  assert.throws(
    () =>
      buildSpectacleOrderDeviceRequest({
        patientReference: "Patient/p1",
        visionPrescriptionReference: "",
        hcpcsCode: "V2020",
      }),
    /VisionPrescription/,
  );
});

test("buildOpticalOrderTask wires the order lifecycle: focus→DeviceRequest, for→Patient, businessStatus", () => {
  const task = buildOpticalOrderTask({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    businessStatus: "at-lab",
  });

  assert.equal(task.resourceType, "Task");
  assert.equal(task.intent, "order");
  assert.equal(task.focus?.reference, "DeviceRequest/dr1");
  assert.equal(task.for?.reference, "Patient/p1");
  assert.equal(task.businessStatus?.coding?.[0]?.system, OSOD_OPTICAL_ORDER_STATUS_SYSTEM);
  assert.equal(task.businessStatus?.coding?.[0]?.code, "at-lab");
  // Task.status stays on the FHIR required workflow vocabulary, NOT the optical vocab
  assert.ok(TASK_STATUS_VOCAB.includes(task.status), `Task.status ${task.status} not in FHIR vocab`);
});

test("buildOpticalOrderTask defaults businessStatus to quote", () => {
  const task = buildOpticalOrderTask({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
  });
  assert.equal(task.businessStatus?.coding?.[0]?.code, "quote");
});

test("buildOpticalOrderTask rejects an invalid businessStatus", () => {
  assert.throws(
    () =>
      buildOpticalOrderTask({
        patientReference: "Patient/p1",
        deviceRequestReference: "DeviceRequest/dr1",
        businessStatus: "shipped",
      }),
    /optical order status/i,
  );
});
