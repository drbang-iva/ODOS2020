import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTACT_LENS_PARAMETER_CODES,
  CONTACT_LENS_TYPE_CODES,
  UCUM_UNIT_CODES,
  buildLensDevice,
  buildLensFitObservation,
  type ContactLensParameterCode,
  type ContactLensTypeCode,
  type UcumUnitCode,
} from "../src/fhir/contactLens.js";
import {
  ORTHO_K_FIT_FINDING_CODES,
  buildOrthoKLensDevice,
  buildUpdateOrthoKLensParametersPatch,
} from "../src/fhir/orthoK.js";
import {
  ATROPINE_CONCENTRATION_CODES,
  MYOPIA_CONTROL_INTERVENTION_CODES,
  buildAtropineMedicationStatement,
  buildMyopiaManagementCarePlan,
} from "../src/fhir/myopiaManagement.js";

const patientReference = "Patient/v04c";
const encounterReference = "Encounter/v04c";

const CARE_PLAN_ACTIVITY_STATUSES = [
  "not-started",
  "scheduled",
  "in-progress",
  "on-hold",
  "completed",
  "cancelled",
  "stopped",
  "unknown",
  "entered-in-error",
] as const;

for (const interventionCode of MYOPIA_CONTROL_INTERVENTION_CODES) {
  for (const status of CARE_PLAN_ACTIVITY_STATUSES) {
    test(`v0.4c CarePlan activity supports ${interventionCode} ${status}`, () => {
      const plan = buildMyopiaManagementCarePlan({
        patientReference,
        encounterReference,
        created: "2026-04-28T12:00:00.000Z",
        activities: [{ interventionCode, status, description: `${interventionCode} ${status}` }],
      });
      assert.equal(plan.activity?.[0]?.detail?.code?.coding?.[0]?.code, interventionCode);
      assert.equal(plan.activity?.[0]?.detail?.status, status);
    });
  }
}

for (const concentration of ATROPINE_CONCENTRATION_CODES) {
  for (const frequencyText of ["qhs", "qam", "bid", "doctor-directed", "tapering", "paused"]) {
    test(`v0.4c atropine builder supports ${concentration} ${frequencyText}`, () => {
      const medication = buildAtropineMedicationStatement({
        patientReference,
        concentration,
        frequencyText,
        effectiveDateTime: "2026-04-28T12:00:00.000Z",
        dateAsserted: "2026-04-28T12:00:00.000Z",
      });
      assert.equal(medication.dosage?.[0]?.doseAndRate?.[0]?.doseQuantity?.code, concentration);
      assert.equal(medication.dosage?.[0]?.text, frequencyText);
    });
  }
}

for (const concentration of ATROPINE_CONCENTRATION_CODES) {
  for (const status of ["active", "completed", "intended", "stopped", "on-hold", "unknown", "not-taken"] as const) {
    test(`v0.4c atropine status ${status} is FHIR MedicationStatement-safe for ${concentration}`, () => {
      const medication = buildAtropineMedicationStatement({
        patientReference,
        concentration,
        frequencyText: "1 drop OU qhs",
        status,
        effectiveDateTime: "2026-04-28T12:00:00.000Z",
        dateAsserted: "2026-04-28T12:00:00.000Z",
      });
      assert.equal(medication.status, status);
    });
  }
}

for (const findingCode of ORTHO_K_FIT_FINDING_CODES) {
  for (const valueDisplay of [
    "centered",
    "slight nasal decentration",
    "mild",
    "moderate",
    "severe",
    "stable",
    "improved",
    "worse",
    "comfortable",
    "awareness",
    "edge lift noted",
    "acceptable",
  ]) {
    test(`v0.4c Ortho-K fit finding ${findingCode} accepts coded/text value ${valueDisplay}`, () => {
      const observation = buildLensFitObservation({
        patientReference,
        lensDeviceReference: "Device/ok1",
        findingCode,
        effectiveDateTime: "2026-04-28T12:00:00.000Z",
        valueCode: valueDisplay.toLowerCase().replaceAll(" ", "-"),
        valueDisplay,
      });
      assert.equal(observation.focus?.[0]?.reference, "Device/ok1");
      assert.equal(observation.derivedFrom, undefined);
    });
  }
}

for (const findingCode of ORTHO_K_FIT_FINDING_CODES) {
  for (const unitCode of UCUM_UNIT_CODES) {
    test(`v0.4c Ortho-K fit finding ${findingCode} accepts UCUM ${unitCode}`, () => {
      const observation = buildLensFitObservation({
        patientReference,
        lensDeviceReference: "Device/ok1",
        findingCode,
        effectiveDateTime: "2026-04-28T12:00:00.000Z",
        valueNumber: 1,
        unitCode,
      });
      assert.equal(observation.valueQuantity?.code, unitCode);
    });
  }
}

for (const parameterCode of [
  "base-curve-mm",
  "base-curve-diopter",
  "reverse-curve-depth-um",
  "alignment-curve-mm",
  "landing-zone",
  "optic-zone-diameter-mm",
  "diameter-mm",
  "sphere-power",
  "material",
  "coating",
  "center-thickness-mm",
  "markings",
] as ContactLensParameterCode[]) {
  test(`v0.4c Ortho-K update patch accepts ${parameterCode}`, () => {
    const existing = buildOrthoKLensDevice({
      patientReference,
      properties: [{ code: "base-curve-mm", valueNumber: 7.8, unitCode: "mm" }],
    });
    const operations = buildUpdateOrthoKLensParametersPatch(existing, [propertyForCode(parameterCode)]);
    assert.equal(operations[0]?.path, "/property");
  });
}

for (const parameterCode of CONTACT_LENS_PARAMETER_CODES) {
  test(`v0.4c custom-design base path accepts contact lens parameter ${parameterCode}`, () => {
    const device = buildLensDevice({
      lensTypeCode: "custom-design",
      patientReference,
      properties: [propertyForCode(parameterCode)],
    });
    assert.equal(device.property?.[0]?.type.coding?.[0]?.code, parameterCode);
  });
}

for (const lensTypeCode of CONTACT_LENS_TYPE_CODES) {
  test(`v0.4c lens type ${lensTypeCode} stays within the v0.4a five-profile foundation`, () => {
    const device = buildLensDevice({
      lensTypeCode,
      patientReference,
      properties: minimalPropertyForLensType(lensTypeCode),
    });
    const profiles = device.meta?.profile ?? [];
    assert.ok(profiles.includes("https://osod.dev/fhir/StructureDefinition/Device-ContactLens"));
    assert.ok(profiles.length <= 2);
  });
}

function propertyForCode(code: ContactLensParameterCode) {
  if (code.includes("power") || code === "base-curve-diopter" || code === "add-power" || code === "prism-ballast-diopter") {
    return { code, valueNumber: 1, unitCode: "[diop]" as UcumUnitCode };
  }
  if (code.includes("axis")) {
    return { code, valueNumber: 90, unitCode: "deg" as UcumUnitCode };
  }
  if (code.endsWith("-um")) {
    return { code, valueNumber: 100, unitCode: "um" as UcumUnitCode };
  }
  if (code.endsWith("-mm") || code.includes("diameter") || code.includes("curve")) {
    return { code, valueNumber: 7.8, unitCode: "mm" as UcumUnitCode };
  }
  if (code.includes("percent")) {
    return { code, valueNumber: 55, unitCode: "%" as UcumUnitCode };
  }
  return { code, valueCode: "example", valueDisplay: "Example" };
}

function minimalPropertyForLensType(lensTypeCode: ContactLensTypeCode) {
  if (lensTypeCode === "hybrid") {
    return [{ code: "gp-zone-base-curve-mm" as const, valueNumber: 7.8, unitCode: "mm" as const }];
  }
  if (lensTypeCode.startsWith("scleral")) {
    return [{ code: "sagittal-depth-um" as const, valueNumber: 4200, unitCode: "um" as const }];
  }
  if (lensTypeCode.startsWith("corneal") || lensTypeCode === "RGP") {
    return [{ code: "base-curve-mm" as const, valueNumber: 7.8, unitCode: "mm" as const }];
  }
  return [{ code: "diameter-mm" as const, valueNumber: 14, unitCode: "mm" as const }];
}
