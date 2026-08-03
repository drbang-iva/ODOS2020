import type { CodeableConcept } from "@medplum/fhirtypes";

export const ODOS_FHIR_BASE = "https://odos2020.com/fhir";
export const DRY_EYE_TREATMENT_TYPE_CODE_SYSTEM =
  `${ODOS_FHIR_BASE}/CodeSystem/dry-eye-treatment-type`;
export const MEIBOGRAPHY_SCORE_CODE_SYSTEM =
  `${ODOS_FHIR_BASE}/CodeSystem/meibography-score`;
export const OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL =
  `${ODOS_FHIR_BASE}/StructureDefinition/Observation-MeibomianGlandScore`;
export const DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL =
  `${ODOS_FHIR_BASE}/StructureDefinition/dry-eye-procedure-energy-mj`;
export const DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL =
  `${ODOS_FHIR_BASE}/StructureDefinition/dry-eye-procedure-wavelength-nm`;
export const DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL =
  `${ODOS_FHIR_BASE}/StructureDefinition/dry-eye-procedure-spot-count`;
export const OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL =
  `${ODOS_FHIR_BASE}/StructureDefinition/ophthalmic-medication-supply-type`;
export const UCUM_CODE_SYSTEM = "http://unitsofmeasure.org";

export const DRY_EYE_TREATMENT_TYPE_CODES = [
  "IPL",
  "LLLT",
  "RF",
  "heat-mask",
  "lid-debridement",
  "blepharoexfoliation",
  "scleral-lens-rehab",
  "artificial-tears",
  "prescription-anti-inflammatory",
  "omega-3",
] as const;
export type DryEyeTreatmentTypeCode = (typeof DRY_EYE_TREATMENT_TYPE_CODES)[number];

export function dryEyeTreatmentTypeConcept(code: DryEyeTreatmentTypeCode): CodeableConcept {
  return {
    coding: [
      {
        system: DRY_EYE_TREATMENT_TYPE_CODE_SYSTEM,
        code,
        display: displayForTreatmentType(code),
      },
    ],
    text: displayForTreatmentType(code),
  };
}

export function displayForTreatmentType(code: DryEyeTreatmentTypeCode): string {
  switch (code) {
    case "IPL":
      return "Intense pulsed light";
    case "LLLT":
      return "Low-level light therapy";
    case "RF":
      return "Radiofrequency treatment";
    case "heat-mask":
      return "Heat mask";
    case "lid-debridement":
      return "Lid debridement";
    case "blepharoexfoliation":
      return "Blepharoexfoliation";
    case "scleral-lens-rehab":
      return "Scleral lens rehabilitation";
    case "artificial-tears":
      return "Artificial tears";
    case "prescription-anti-inflammatory":
      return "Prescription anti-inflammatory";
    case "omega-3":
      return "Omega-3 supplement";
  }
}
