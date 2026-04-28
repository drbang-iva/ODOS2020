import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEVICE_ORTHO_K_LENS_PROFILE_URL,
  OBSERVATION_CONTACT_LENS_FIT_FINDING_PROFILE_URL,
} from "../src/fhir/contactLens.js";
import {
  buildOrthoKFitObservation,
  buildOrthoKFittingEvent,
  buildOrthoKLensDevice,
  buildOrthoKTrialProcedure,
} from "../src/fhir/orthoK.js";
import {
  MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL,
  buildAtropineMedicationStatement,
  buildMyopiaAxialLengthObservation,
  buildMyopiaManagementCarePlan,
  buildUpdateMyopiaCarePlanPatch,
} from "../src/fhir/myopiaManagement.js";

test("Ortho-K lens Device uses v0.4a Device-OrthoKLens profile and Device.property", () => {
  const device = buildOrthoKLensDevice({
    patientReference: "Patient/p1",
    definitionReference: "DeviceDefinition/paragon-crt",
    properties: [
      { code: "base-curve-mm", valueNumber: 7.8, unitCode: "mm" },
      { code: "reverse-curve-depth-um", valueNumber: 550, unitCode: "um" },
      { code: "sphere-power", valueNumber: -2, unitCode: "[diop]" },
    ],
  });

  assert.ok(device.meta?.profile?.includes(DEVICE_ORTHO_K_LENS_PROFILE_URL));
  assert.equal(device.definition?.reference, "DeviceDefinition/paragon-crt");
  assert.equal(device.property?.[0]?.type.coding?.[0]?.code, "base-curve-mm");
});

test("Ortho-K fitting trail uses Procedure.usedReference and Procedure.partOf", () => {
  const parent = buildOrthoKFittingEvent({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    lensDeviceReference: "Device/l1",
    performedDateTime: "2026-04-28T12:00:00.000Z",
  });
  const child = buildOrthoKTrialProcedure({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    lensDeviceReference: "Device/l1",
    seriesProcedureReference: "Procedure/series",
    trialNumber: 2,
    outcomeText: "Rejected due to decentration",
  });

  assert.equal(parent.usedReference?.[0]?.reference, "Device/l1");
  assert.equal(child.partOf?.[0]?.reference, "Procedure/series");
  assert.equal(child.outcome?.text, "Rejected due to decentration");
});

test("Ortho-K fit observation uses Observation.focus and never derivedFrom Device", () => {
  const observation = buildOrthoKFitObservation({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    lensDeviceReference: "Device/l1",
    findingCode: "corneal-molding-response",
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
    valueDisplay: "bullseye",
  });

  assert.ok(observation.meta?.profile?.includes(OBSERVATION_CONTACT_LENS_FIT_FINDING_PROFILE_URL));
  assert.equal(observation.focus?.[0]?.reference, "Device/l1");
  assert.equal(observation.subject?.reference, "Patient/p1");
  assert.equal(observation.derivedFrom, undefined);
});

test("Myopia CarePlan coordinates interventions without using a List resource", () => {
  const plan = buildMyopiaManagementCarePlan({
    patientReference: "Patient/p1",
    episodeOfCareReference: "EpisodeOfCare/mm1",
    encounterReference: "Encounter/e1",
    created: "2026-04-28T12:00:00.000Z",
    activities: [
      { interventionCode: "ortho-K", resourceReference: "Device/l1" },
      { interventionCode: "atropine-medium-dose", resourceReference: "MedicationStatement/m1" },
    ],
  });

  assert.equal(plan.resourceType, "CarePlan");
  assert.equal(plan.supportingInfo?.[0]?.reference, "EpisodeOfCare/mm1");
  assert.equal(plan.activity?.[0]?.extension?.[0]?.url, MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL);
  assert.equal(plan.activity?.[1]?.detail?.code?.coding?.[0]?.code, "atropine-medium-dose");
});

test("Myopia CarePlan patch replaces activity and keeps supportingInfo in sync", () => {
  const existing = buildMyopiaManagementCarePlan({
    patientReference: "Patient/p1",
    created: "2026-04-28T12:00:00.000Z",
    activities: [{ interventionCode: "ortho-K", resourceReference: "Device/old" }],
  });
  const patch = buildUpdateMyopiaCarePlanPatch(
    existing,
    [{ interventionCode: "MiSight", resourceReference: "DeviceUseStatement/dus1" }],
    "active",
  );

  assert.equal(patch[0]?.path, "/status");
  assert.equal(patch[1]?.path, "/activity");
  assert.equal(patch[2]?.path, "/supportingInfo");
});

test("Atropine MedicationStatement stores compounded concentration in doseAndRate", () => {
  const medication = buildAtropineMedicationStatement({
    patientReference: "Patient/p1",
    episodeOfCareReference: "EpisodeOfCare/mm1",
    concentration: "0.025%",
    frequencyText: "1 drop OU qhs",
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
    dateAsserted: "2026-04-28T12:00:00.000Z",
  });

  assert.equal(medication.dosage?.[0]?.doseAndRate?.[0]?.doseQuantity?.code, "0.025%");
  assert.equal(medication.reasonReference?.[0]?.reference, "EpisodeOfCare/mm1");
});

test("Axial length builder uses existing v0.3 profile and mm UCUM", () => {
  const observation = buildMyopiaAxialLengthObservation({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    eye: "OD",
    measuredAt: "2026-04-28T12:00:00.000Z",
    valueMm: 24.1,
  });

  assert.equal(observation.valueQuantity?.code, "mm");
  assert.deepEqual(observation.code.coding?.[0], {
    system: "http://loinc.org",
    code: "64742-0",
    display: "Right eye Axial length",
  });
  assert.equal(observation.subject?.reference, "Patient/p1");
  assert.equal(observation.derivedFrom, undefined);
});
