import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTACT_LENS_COATING_EXTENSION_URL,
  CONTACT_LENS_PARAMETER_CODE_SYSTEM,
  DEVICE_CONTACT_LENS_PROFILE_URL,
  DEVICE_ORTHO_K_LENS_PROFILE_URL,
  DEVICE_SCLERAL_LENS_PROFILE_URL,
  OBSERVATION_CONTACT_LENS_FIT_FINDING_PROFILE_URL,
  OSOD_DEVICE_DEFINITION_IDENTIFIER_SYSTEM,
  OSOD_SUBSTANCE_IDENTIFIER_SYSTEM,
  PARAMETER_VALUE_SET_URLS,
  UCUM_CODE_SYSTEM,
  buildConceptMap,
  buildDeviceDefinition,
  buildLensDevice,
  buildLensFitObservation,
  buildSubstance,
  buildUpdateLensDevicePropertiesPatch,
  buildV04CanonicalResources,
  buildV04DeviceDefinitionSeeds,
  buildV04SubstanceSeeds,
} from "../src/fhir/contactLens.js";

test("contact lens Device builder uses Device.property for type-aware lens geometry", () => {
  const device = buildLensDevice({
    lensTypeCode: "ortho-K",
    patientReference: "Patient/p1",
    definitionReference: "DeviceDefinition/paragon",
    deviceName: "OD CRT trial lens",
    coatingSubstanceReference: "Substance/hydrapeg",
    properties: [
      { code: "base-curve-mm", valueNumber: 7.8, unitCode: "mm" },
      { code: "reverse-curve-depth-um", valueNumber: 525, unitCode: "um" },
      { code: "sphere-power", valueNumber: -1.25, unitCode: "[diop]" },
    ],
  });

  assert.deepEqual(device.meta?.profile, [
    DEVICE_CONTACT_LENS_PROFILE_URL,
    DEVICE_ORTHO_K_LENS_PROFILE_URL,
  ]);
  assert.equal(device.patient?.reference, "Patient/p1");
  assert.equal(device.definition?.reference, "DeviceDefinition/paragon");
  assert.equal(device.property?.[0]?.type.coding?.[0]?.system, CONTACT_LENS_PARAMETER_CODE_SYSTEM);
  assert.equal(device.property?.[0]?.valueQuantity?.[0]?.system, UCUM_CODE_SYSTEM);
  assert.equal(device.extension?.[0]?.url, CONTACT_LENS_COATING_EXTENSION_URL);
});

test("scleral lens builder accepts quadrant-specific haptic and clearance codes", () => {
  const device = buildLensDevice({
    lensTypeCode: "scleral-quadrant-haptic",
    properties: [
      { code: "sagittal-depth-um", valueNumber: 4600, unitCode: "um" },
      { code: "central-clearance-target-um", valueNumber: 250, unitCode: "um" },
      { code: "landing-zone-superior", valueCode: "steepen-2", valueDisplay: "Steepen 2" },
      { code: "landing-zone-nasal", valueCode: "flatten-1", valueDisplay: "Flatten 1" },
    ],
  });

  assert.equal(device.meta?.profile?.[1], DEVICE_SCLERAL_LENS_PROFILE_URL);
  assert.deepEqual(
    device.property?.map((property) => property.type.coding?.[0]?.code),
    [
      "sagittal-depth-um",
      "central-clearance-target-um",
      "landing-zone-superior",
      "landing-zone-nasal",
    ],
  );
});

test("corneal GP bitoric bifocal parameters preserve front and back surface semantics", () => {
  const device = buildLensDevice({
    lensTypeCode: "corneal-GP-bitoric-bifocal",
    properties: [
      { code: "flat-meridian-bc-back", valueNumber: 7.6, unitCode: "mm" },
      { code: "steep-meridian-bc-front", valueNumber: 7.1, unitCode: "mm" },
      { code: "segment-height-lower-pupil-margin-mm", valueNumber: 1.2, unitCode: "mm" },
    ],
  });

  assert.deepEqual(
    device.property?.map((property) => property.type.coding?.[0]?.code),
    [
      "flat-meridian-bc-back",
      "steep-meridian-bc-front",
      "segment-height-lower-pupil-margin-mm",
    ],
  );
});

test("type-aware property validation rejects parameters outside a lens family", () => {
  assert.throws(() =>
    buildLensDevice({
      lensTypeCode: "stock-soft",
      properties: [{ code: "sagittal-depth-um", valueNumber: 4200, unitCode: "um" }],
    }),
  );
});

test("lens property update patch replaces existing property entries and appends new ones", () => {
  const existing = buildLensDevice({
    lensTypeCode: "ortho-K",
    properties: [{ code: "base-curve-mm", valueNumber: 7.8, unitCode: "mm" }],
  });
  const patch = buildUpdateLensDevicePropertiesPatch(existing, "ortho-K", [
    { code: "base-curve-mm", valueNumber: 7.7, unitCode: "mm" },
    { code: "optic-zone-diameter-mm", valueNumber: 6.0, unitCode: "mm" },
  ]);

  assert.equal(patch[0].op, "replace");
  const next = patch[0].value as NonNullable<typeof existing.property>;
  assert.equal(next.length, 2);
  assert.equal(next[0].valueQuantity?.[0]?.value, 7.7);
  assert.equal(next[1].type.coding?.[0]?.code, "optic-zone-diameter-mm");
});

test("DeviceDefinition builder creates lab catalog blueprints with identifiers", () => {
  const definition = buildDeviceDefinition({
    catalogCode: "paragon-crt",
    displayName: "Paragon CRT",
    lensTypeCode: "ortho-K",
    manufacturer: "Paragon Vision Sciences",
    materialCodes: ["Boston-XO"],
  });

  assert.equal(definition.identifier?.[0]?.system, OSOD_DEVICE_DEFINITION_IDENTIFIER_SYSTEM);
  assert.equal(definition.identifier?.[0]?.value, "paragon-crt");
  assert.equal(definition.deviceName?.[0]?.name, "Paragon CRT");
  assert.equal(definition.material?.[0]?.substance.coding?.[0]?.code, "Boston-XO");
});

test("Substance builder records material and coating registry entries", () => {
  const material = buildSubstance({
    code: "Boston-XO2",
    display: "Boston XO2",
    kind: "material",
    dk: 141,
  });
  const coating = buildSubstance({
    code: "Hydra-PEG",
    display: "Hydra-PEG",
    kind: "coating",
  });

  assert.equal(material.identifier?.[0]?.system, OSOD_SUBSTANCE_IDENTIFIER_SYSTEM);
  assert.match(material.description ?? "", /Dk 141/);
  assert.equal(coating.code.coding?.[0]?.code, "Hydra-PEG");
});

test("ConceptMap builder uses OSOD source URI and lab-specific target URI", () => {
  const conceptMap = buildConceptMap({
    labCode: "bostonsight",
    labDisplay: "BostonSight",
    targetUri: "urn:osod:contact-lens-lab:bostonsight:parameter",
    organizationReference: "Organization/bostonsight",
    mappings: [
      {
        sourceCode: "sagittal-depth-um",
        targetCode: "Sag",
        targetDisplay: "Sagittal depth",
      },
    ],
  });

  assert.equal(conceptMap.sourceUri, CONTACT_LENS_PARAMETER_CODE_SYSTEM);
  assert.equal(conceptMap.group?.[0]?.element?.[0]?.code, "sagittal-depth-um");
  assert.equal(conceptMap.group?.[0]?.element?.[0]?.target?.[0]?.code, "Sag");
  assert.equal(conceptMap.group?.[0]?.extension?.[0]?.valueReference?.reference, "Organization/bostonsight");
});

test("contact lens fit finding observations are patient-subject and lens-focused", () => {
  const observation = buildLensFitObservation({
    patientReference: "Patient/p1",
    lensDeviceReference: "Device/lens1",
    findingCode: "central-clearance-settled",
    valueNumber: 250,
    unitCode: "um",
    wearTimeMs: 14_400_000,
  });

  assert.equal(observation.meta?.profile?.[0], OBSERVATION_CONTACT_LENS_FIT_FINDING_PROFILE_URL);
  assert.equal(observation.subject.reference, "Patient/p1");
  assert.equal(observation.focus?.[0]?.reference, "Device/lens1");
  assert.equal(observation.component?.[0]?.valueQuantity?.code, "ms");
});

test("installer resource generator includes v0.4 profiles, terminology, seeds, and bindings", () => {
  const canonical = buildV04CanonicalResources();
  const urls = canonical.map((resource) => resource.url);

  assert.ok(urls.includes(DEVICE_CONTACT_LENS_PROFILE_URL));
  assert.ok(urls.includes(PARAMETER_VALUE_SET_URLS.scleral));
  assert.equal(buildV04DeviceDefinitionSeeds().length >= 5, true);
  assert.equal(buildV04SubstanceSeeds().length >= 9, true);
});
