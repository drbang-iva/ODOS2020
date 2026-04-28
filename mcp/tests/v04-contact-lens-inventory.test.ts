import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTACT_LENS_CLINICAL_OBSERVATION_CODES,
  CONTACT_LENS_COATING_CODES,
  CONTACT_LENS_FITTING_EVENT_CODES,
  CONTACT_LENS_MATERIAL_CODES,
  CONTACT_LENS_PARAMETER_CODES,
  CONTACT_LENS_TYPE_CODES,
  buildLensDevice,
  contactLensParameterConcept,
  contactLensTypeConcept,
} from "../src/fhir/contactLens.js";

test("v0.4a contact lens parameter inventory emits stable CodeableConcepts", async (t) => {
  for (const code of CONTACT_LENS_PARAMETER_CODES) {
    await t.test(`parameter ${code}`, () => {
      const concept = contactLensParameterConcept(code);
      assert.equal(concept.coding?.[0]?.code, code);
      assert.ok(concept.coding?.[0]?.system?.endsWith("/contact-lens-parameter"));
      assert.ok((concept.text ?? "").length > 0);
    });
  }
});

test("v0.4a contact lens type inventory emits stable CodeableConcepts", async (t) => {
  for (const code of CONTACT_LENS_TYPE_CODES) {
    await t.test(`type ${code}`, () => {
      const concept = contactLensTypeConcept(code);
      assert.equal(concept.coding?.[0]?.code, code);
      assert.ok(concept.coding?.[0]?.system?.endsWith("/contact-lens-type"));
      assert.ok((concept.text ?? "").length > 0);
    });
  }
});

test("v0.4a examples from the contact lens reference fit the corrected Device.property shape", async (t) => {
  const examples = [
    {
      name: "ortho-k",
      lensTypeCode: "ortho-K",
      properties: [
        { code: "base-curve-mm", valueNumber: 7.8, unitCode: "mm" },
        { code: "reverse-curve-depth-um", valueNumber: 525, unitCode: "um" },
        { code: "alignment-curve-mm", valueNumber: 8.2, unitCode: "mm" },
      ],
    },
    {
      name: "single-meridian-corneal-gp",
      lensTypeCode: "corneal-GP",
      properties: [
        { code: "base-curve-mm", valueNumber: 7.7, unitCode: "mm" },
        { code: "diameter-mm", valueNumber: 9.5, unitCode: "mm" },
      ],
    },
    {
      name: "bitoric-bifocal",
      lensTypeCode: "corneal-GP-bitoric-bifocal",
      properties: [
        { code: "flat-meridian-bc-back", valueNumber: 7.6, unitCode: "mm" },
        { code: "flat-meridian-power-front", valueNumber: -2.25, unitCode: "[diop]" },
        { code: "segment-style", valueCode: "crescent", valueDisplay: "Crescent" },
      ],
    },
    {
      name: "scleral-quadrant",
      lensTypeCode: "scleral-quadrant-haptic",
      properties: [
        { code: "sagittal-depth-um", valueNumber: 4600, unitCode: "um" },
        { code: "landing-zone-superior", valueCode: "steepen-2", valueDisplay: "Steepen 2" },
        { code: "landing-zone-temporal", valueCode: "flatten-1", valueDisplay: "Flatten 1" },
      ],
    },
    {
      name: "hybrid",
      lensTypeCode: "hybrid",
      properties: [
        { code: "gp-zone-base-curve-mm", valueNumber: 7.8, unitCode: "mm" },
        { code: "soft-skirt-curve", valueCode: "flat", valueDisplay: "Flat skirt" },
        { code: "junction-vault-um", valueNumber: 150, unitCode: "um" },
      ],
    },
    {
      name: "soft",
      lensTypeCode: "stock-soft",
      properties: [
        { code: "base-curve-mm", valueNumber: 8.6, unitCode: "mm" },
        { code: "water-content-percent", valueNumber: 55, unitCode: "%" },
        { code: "replacement-schedule", valueCode: "monthly", valueDisplay: "Monthly" },
      ],
    },
  ] as const;

  for (const example of examples) {
    await t.test(example.name, () => {
      const device = buildLensDevice(example);
      assert.equal(device.resourceType, "Device");
      assert.equal(device.property?.length, example.properties.length);
    });
  }
});

test("v0.4a contact lens event and product code lists have stable public values", () => {
  assert.deepEqual(CONTACT_LENS_FITTING_EVENT_CODES, [
    "initial-fit",
    "refit",
    "training",
    "remake",
    "parameter-adjustment",
    "failed-trial",
  ]);
  assert.ok(CONTACT_LENS_CLINICAL_OBSERVATION_CODES.includes("central-clearance-settled"));
  assert.ok(CONTACT_LENS_MATERIAL_CODES.includes("Boston-XO2"));
  assert.ok(CONTACT_LENS_COATING_CODES.includes("Hydra-PEG"));
});
