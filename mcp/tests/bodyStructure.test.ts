import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEyeBodyStructure } from "../src/fhir/ophthalmology/bodyStructure.js";

const patientReference = "Patient/p1";

test("buildEyeBodyStructure OD emits SNOMED right eye BodyStructure", () => {
  const bodyStructure = buildEyeBodyStructure("OD", patientReference);

  assert.equal(bodyStructure.resourceType, "BodyStructure");
  assert.equal(bodyStructure.location?.coding?.[0]?.system, "http://snomed.info/sct");
  assert.equal(bodyStructure.location?.coding?.[0]?.code, "18944008");
  assert.equal(bodyStructure.location?.coding?.[0]?.display, "Right eye");
  assert.equal(bodyStructure.locationQualifier?.[0]?.coding?.[0]?.code, "24028007");
  assert.equal(bodyStructure.patient.reference, patientReference);
});

test("buildEyeBodyStructure OS emits SNOMED left eye BodyStructure", () => {
  const bodyStructure = buildEyeBodyStructure("OS", patientReference);

  assert.equal(bodyStructure.location?.coding?.[0]?.system, "http://snomed.info/sct");
  assert.equal(bodyStructure.location?.coding?.[0]?.code, "8966001");
  assert.equal(bodyStructure.location?.coding?.[0]?.display, "Left eye");
  assert.equal(bodyStructure.locationQualifier?.[0]?.coding?.[0]?.code, "7771000");
  assert.equal(bodyStructure.patient.reference, patientReference);
});

test("buildEyeBodyStructure OU emits eye plus bilateral qualifier", () => {
  const bodyStructure = buildEyeBodyStructure("OU", patientReference);

  assert.equal(bodyStructure.location?.coding?.[0]?.system, "http://snomed.info/sct");
  assert.equal(bodyStructure.location?.coding?.[0]?.code, "81745001");
  assert.equal(bodyStructure.location?.coding?.[0]?.display, "Eye");
  assert.equal(bodyStructure.locationQualifier?.[0]?.coding?.[0]?.system, "http://snomed.info/sct");
  assert.equal(bodyStructure.locationQualifier?.[0]?.coding?.[0]?.code, "51440002");
  assert.equal(bodyStructure.locationQualifier?.[0]?.coding?.[0]?.display, "Bilateral");
  assert.equal(bodyStructure.patient.reference, patientReference);
});
