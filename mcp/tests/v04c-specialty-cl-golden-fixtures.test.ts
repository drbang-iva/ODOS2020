import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEVICE_CORNEAL_GP_LENS_PROFILE_URL,
  DEVICE_HYBRID_LENS_PROFILE_URL,
  DEVICE_SCLERAL_LENS_PROFILE_URL,
  buildLensDevice,
  buildLensFitObservation,
  type ContactLensPropertyInput,
  type ContactLensTypeCode,
} from "../src/fhir/contactLens.js";

interface GoldenExample {
  label: string;
  lensTypeCode: ContactLensTypeCode;
  expectedProfile: string;
  properties: ContactLensPropertyInput[];
  observations?: ReturnType<typeof buildLensFitObservation>[];
}

const patientReference = "Patient/golden";

const EXAMPLES: GoldenExample[] = [
  {
    label: "Example A: OD bitoric translating bifocal",
    lensTypeCode: "corneal-GP-bitoric-bifocal",
    expectedProfile: DEVICE_CORNEAL_GP_LENS_PROFILE_URL,
    properties: [
      { code: "flat-meridian-bc-back", valueNumber: 7.65, unitCode: "mm" },
      { code: "steep-meridian-bc-back", valueNumber: 7.35, unitCode: "mm" },
      { code: "flat-meridian-power-back", valueNumber: -2.25, unitCode: "[diop]" },
      { code: "steep-meridian-power-back", valueNumber: -3.25, unitCode: "[diop]" },
      { code: "segment-style", valueCode: "translating", valueDisplay: "Translating bifocal" },
      { code: "segment-height-lower-edge-mm", valueNumber: 4.2, unitCode: "mm" },
      { code: "segment-height-lower-pupil-margin-mm", valueNumber: 1.0, unitCode: "mm" },
      { code: "prism-ballast-diopter", valueNumber: 1.5, unitCode: "[diop]" },
      { code: "truncation-mm", valueNumber: 0.4, unitCode: "mm" },
    ],
  },
  {
    label: "Example B: OS back-surface bitoric plus front-surface segmented bifocal",
    lensTypeCode: "corneal-GP-bitoric-bifocal",
    expectedProfile: DEVICE_CORNEAL_GP_LENS_PROFILE_URL,
    properties: [
      { code: "flat-meridian-bc-back", valueNumber: 7.9, unitCode: "mm" },
      { code: "steep-meridian-bc-back", valueNumber: 7.55, unitCode: "mm" },
      { code: "flat-meridian-power-front", valueNumber: -1.5, unitCode: "[diop]" },
      { code: "steep-meridian-power-front", valueNumber: -2.25, unitCode: "[diop]" },
      { code: "segment-style", valueCode: "front-surface-segmented", valueDisplay: "Front-surface segmented bifocal" },
      { code: "segment-height-lower-edge-mm", valueNumber: 4.0, unitCode: "mm" },
    ],
  },
  {
    label: "Example C: prolate mini-scleral with toric haptic",
    lensTypeCode: "scleral-toric-haptic",
    expectedProfile: DEVICE_SCLERAL_LENS_PROFILE_URL,
    properties: [
      { code: "sagittal-depth-um", valueNumber: 4200, unitCode: "um" },
      { code: "central-clearance-target-um", valueNumber: 250, unitCode: "um" },
      { code: "limbal-clearance-um", valueNumber: 100, unitCode: "um" },
      { code: "landing-zone-type", valueCode: "toric", valueDisplay: "Toric landing zone" },
      { code: "landing-zone-flat-meridian", valueCode: "flat", valueDisplay: "Flat haptic meridian" },
      { code: "landing-zone-steep-meridian", valueCode: "steep", valueDisplay: "Steep haptic meridian" },
      { code: "landing-zone-axis-degree", valueNumber: 180, unitCode: "deg" },
    ],
  },
  {
    label: "Example D: oblate scleral with quadrant-specific haptic",
    lensTypeCode: "scleral-quadrant-haptic",
    expectedProfile: DEVICE_SCLERAL_LENS_PROFILE_URL,
    properties: [
      { code: "sagittal-depth-um", valueNumber: 4550, unitCode: "um" },
      { code: "landing-zone-superior", valueCode: "steep-2", valueDisplay: "Superior steep 2" },
      { code: "landing-zone-inferior", valueCode: "flat-1", valueDisplay: "Inferior flat 1" },
      { code: "landing-zone-nasal", valueCode: "flat-2", valueDisplay: "Nasal flat 2" },
      { code: "landing-zone-temporal", valueCode: "standard", valueDisplay: "Temporal standard" },
    ],
  },
  {
    label: "Example E: scleral multifocal",
    lensTypeCode: "scleral-multifocal",
    expectedProfile: DEVICE_SCLERAL_LENS_PROFILE_URL,
    properties: [
      { code: "sagittal-depth-um", valueNumber: 4400, unitCode: "um" },
      { code: "sphere-power", valueNumber: -4.25, unitCode: "[diop]" },
      { code: "multifocal-design", valueCode: "distance-center", valueDisplay: "Distance-center multifocal" },
      { code: "near-zone-size-mm", valueNumber: 2.5, unitCode: "mm" },
      { code: "add-power", valueNumber: 2.0, unitCode: "[diop]" },
    ],
  },
  {
    label: "Example F: hybrid soft-skirted GP",
    lensTypeCode: "hybrid",
    expectedProfile: DEVICE_HYBRID_LENS_PROFILE_URL,
    properties: [
      { code: "gp-zone-base-curve-mm", valueNumber: 7.6, unitCode: "mm" },
      { code: "gp-zone-diameter-mm", valueNumber: 8.5, unitCode: "mm" },
      { code: "sphere-power", valueNumber: -3.0, unitCode: "[diop]" },
      { code: "soft-skirt-curve", valueCode: "medium", valueDisplay: "Medium skirt curve" },
      { code: "soft-skirt-material", valueCode: "silicone-hydrogel-generic", valueDisplay: "Silicone hydrogel" },
      { code: "soft-skirt-edge-lift", valueCode: "standard", valueDisplay: "Standard skirt edge" },
      { code: "junction-vault-um", valueNumber: 150, unitCode: "um" },
      { code: "junction-lift", valueCode: "low", valueDisplay: "Low junction lift" },
    ],
  },
];

for (const example of EXAMPLES) {
  test(`${example.label} round-trips through v0.4a Device.property shape`, () => {
    const device = buildLensDevice({
      lensTypeCode: example.lensTypeCode,
      patientReference,
      deviceName: example.label,
      properties: example.properties,
    });

    assert.equal(device.resourceType, "Device");
    assert.equal(device.patient?.reference, patientReference);
    assert.ok(device.meta?.profile?.includes(example.expectedProfile));
    assert.equal(device.property?.length, example.properties.length);
    assert.deepEqual(
      device.property?.map((property) => property.type.coding?.[0]?.code),
      example.properties.map((property) => property.code),
    );

    const serialized = JSON.stringify(device);
    const parsed = JSON.parse(serialized) as typeof device;
    assert.deepEqual(parsed.property, device.property);
  });
}

test("Example A clinical findings remain separate queryable Observations focused on the lens Device", () => {
  const findings = ["translation", "segment-position", "rotation-stability", "comfort", "visual-acuity"] as const;
  for (const findingCode of findings) {
    const observation = buildLensFitObservation({
      patientReference,
      lensDeviceReference: "Device/example-a",
      findingCode,
      effectiveDateTime: "2026-04-28T12:00:00.000Z",
      valueDisplay: "stable",
    });
    assert.equal(observation.focus?.[0]?.reference, "Device/example-a");
    assert.equal(observation.derivedFrom, undefined);
  }
});

test("Example C settled central clearance uses Observation.focus and wear-time component", () => {
  const observation = buildLensFitObservation({
    patientReference,
    lensDeviceReference: "Device/example-c",
    findingCode: "central-clearance-settled",
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
    valueNumber: 220,
    unitCode: "um",
    wearTimeMs: 14_400_000,
  });

  assert.equal(observation.focus?.[0]?.reference, "Device/example-c");
  assert.equal(observation.valueQuantity?.code, "um");
  assert.equal(observation.component?.[0]?.code.coding?.[0]?.code, "wear-time-duration");
  assert.equal(observation.component?.[0]?.valueQuantity?.code, "ms");
  assert.equal(observation.derivedFrom, undefined);
});
