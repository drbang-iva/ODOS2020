import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRefractionObservation } from "../src/fhir/ophthalmology/refraction.js";
import { buildVisionPrescription } from "../src/fhir/ophthalmology/visionPrescription.js";

test("buildVisionPrescription projects FINAL_RX refraction into lens specification", () => {
  const { resource: refractionObservation } = buildRefractionObservation({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    eye: "OD",
    measuredAt: "2026-04-24T12:00:00.000Z",
    refractionType: "FINAL_RX",
    sphere: -2.5,
    cylinder: -0.75,
    axis: 180,
    add: 2,
    prism: { amount: 1.5, base: "out" },
  });

  const visionPrescription = buildVisionPrescription({
    refractionObservation,
    patientReference: "Patient/p1",
    prescriberReference: "Practitioner/pr1",
    dateWritten: "2026-04-24T12:30:00.000Z",
    lensType: "eyeglasses",
  });

  assert.equal(visionPrescription.resourceType, "VisionPrescription");
  assert.equal(visionPrescription.patient.reference, "Patient/p1");
  assert.equal(visionPrescription.prescriber.reference, "Practitioner/pr1");
  assert.equal(visionPrescription.lensSpecification.length, 1);
  assert.equal(visionPrescription.lensSpecification[0].eye, "right");
  assert.equal(visionPrescription.lensSpecification[0].sphere, -2.5);
  assert.equal(visionPrescription.lensSpecification[0].cylinder, -0.75);
  assert.equal(visionPrescription.lensSpecification[0].axis, 180);
  assert.equal(visionPrescription.lensSpecification[0].add, 2);
  assert.equal(visionPrescription.lensSpecification[0].prism?.[0]?.amount, 1.5);
  assert.equal(visionPrescription.lensSpecification[0].prism?.[0]?.base, "out");
});

test("buildVisionPrescription rejects non-FINAL_RX refractions", () => {
  const { resource: refractionObservation } = buildRefractionObservation({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    eye: "OD",
    measuredAt: "2026-04-24T12:00:00.000Z",
    refractionType: "MANIFEST",
    sphere: -2.5,
  });

  assert.throws(
    () =>
      buildVisionPrescription({
        refractionObservation,
        patientReference: "Patient/p1",
        prescriberReference: "Practitioner/pr1",
      }),
    /FINAL_RX/,
  );
});
