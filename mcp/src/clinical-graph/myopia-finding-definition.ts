import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";

export const AXIAL_LENGTH_KEY = "AXIAL_LENGTH";
export const CORNEAL_RADIUS_KEY = "CORNEAL_RADIUS";
export const BIOMETRY_METHODS = ["OPTICAL_BIOMETRY", "ULTRASOUND_A_SCAN"] as const;
export type BiometryMethod = (typeof BIOMETRY_METHODS)[number];

const BIOMETRY_OPTIONS = BIOMETRY_METHODS.map((code) => ({
  code,
  display: code === "OPTICAL_BIOMETRY" ? "Optical biometry" : "Ultrasound A-scan",
  active: true as const,
}));

export function buildMyopiaFindingDefinitions(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition[] {
  return [
    buildClinicalFindingDefinition({
      id: "finding-def-axial-length",
      stableKey: AXIAL_LENGTH_KEY,
      display: "Axial Length",
      sectionKey: "myopia-progression",
      anatomyTarget: "eye",
      valueSchema: {
        valueKind: "quantity",
        perEye: true,
        unit: { system: "http://unitsofmeasure.org", code: "mm", display: "mm" },
        fields: {
          value: {
            display: "Axial Length",
            type: "decimal-input",
            minimum: 18,
            maximum: 32,
            step: 0.01,
            unit: "mm",
            required: true,
          },
          biometryMethod: {
            display: "Biometry method",
            type: "single-select",
            required: true,
            options: BIOMETRY_OPTIONS,
          },
          instrument: {
            display: "Instrument",
            type: "string",
            required: false,
          },
        },
      },
      normalSemantics: { diagnosisSuggestions: false },
      sourceStatus: "verified-seed",
      fhirObservationCode: odosConcept(AXIAL_LENGTH_KEY, "Axial length"),
      allowDiagnosisMapping: false,
      notBillReady: true,
      active: true,
      provenance,
    }),
    buildClinicalFindingDefinition({
      id: "finding-def-corneal-radius",
      stableKey: CORNEAL_RADIUS_KEY,
      display: "Corneal Radius",
      sectionKey: "myopia-progression",
      anatomyTarget: "cornea",
      valueSchema: {
        valueKind: "quantity",
        perEye: true,
        capturedNotCurrentlyConsumed: true,
        unit: { system: "http://unitsofmeasure.org", code: "mm", display: "mm" },
        fields: {
          value: {
            display: "Corneal Radius",
            type: "decimal-input",
            minimum: 5,
            maximum: 12,
            step: 0.01,
            unit: "mm",
            required: false,
          },
        },
      },
      normalSemantics: {
        diagnosisSuggestions: false,
        lifecycle: "captured, not currently consumed",
      },
      sourceStatus: "verified-seed",
      fhirObservationCode: odosConcept(CORNEAL_RADIUS_KEY, "Corneal radius"),
      allowDiagnosisMapping: false,
      notBillReady: true,
      active: true,
      provenance: {
        ...provenance,
        note: "Captured, not currently consumed. Do not wire a clinical dependency without a separate reviewed slice.",
      },
    }),
  ];
}
