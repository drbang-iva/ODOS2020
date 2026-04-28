import type { CodeableConcept } from "@medplum/fhirtypes";

export const OSOD_FHIR_BASE = "https://osod.dev/fhir";
export const DRY_EYE_TREATMENT_TYPE_CODE_SYSTEM =
  `${OSOD_FHIR_BASE}/CodeSystem/dry-eye-treatment-type`;
export const MEIBOGRAPHY_SCORE_CODE_SYSTEM =
  `${OSOD_FHIR_BASE}/CodeSystem/meibography-score`;
export const DRY_EYE_QUESTIONNAIRE_INSTRUMENT_CODE_SYSTEM =
  `${OSOD_FHIR_BASE}/CodeSystem/dry-eye-questionnaire-instrument`;
export const OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/Observation-MeibomianGlandScore`;
export const DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/dry-eye-procedure-energy-mj`;
export const DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/dry-eye-procedure-wavelength-nm`;
export const DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/dry-eye-procedure-spot-count`;
export const OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/ophthalmic-medication-supply-type`;
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

export const DRY_EYE_QUESTIONNAIRE_INSTRUMENTS = [
  "OSDI",
  "SPEED",
  "DEQ-5",
  "McMonnies",
] as const;
export type DryEyeQuestionnaireInstrument =
  (typeof DRY_EYE_QUESTIONNAIRE_INSTRUMENTS)[number];

export const DRY_EYE_QUESTIONNAIRE_ITEM_COUNTS: Record<
  DryEyeQuestionnaireInstrument,
  number
> = {
  OSDI: 12,
  SPEED: 4,
  "DEQ-5": 5,
  McMonnies: 14,
};

export const DRY_EYE_QUESTIONNAIRE_URLS: Record<
  DryEyeQuestionnaireInstrument,
  string
> = {
  OSDI: `${OSOD_FHIR_BASE}/Questionnaire/dry-eye-osdi`,
  SPEED: `${OSOD_FHIR_BASE}/Questionnaire/dry-eye-speed`,
  "DEQ-5": `${OSOD_FHIR_BASE}/Questionnaire/dry-eye-deq-5`,
  McMonnies: `${OSOD_FHIR_BASE}/Questionnaire/dry-eye-mcmonnies`,
};

export function questionnaireUrlForInstrument(
  instrument: DryEyeQuestionnaireInstrument,
): string {
  return DRY_EYE_QUESTIONNAIRE_URLS[instrument];
}

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

export function dryEyeQuestionnaireInstrumentConcept(
  instrument: DryEyeQuestionnaireInstrument,
): CodeableConcept {
  return {
    coding: [
      {
        system: DRY_EYE_QUESTIONNAIRE_INSTRUMENT_CODE_SYSTEM,
        code: instrument,
        display: displayForInstrument(instrument),
      },
    ],
    text: displayForInstrument(instrument),
  };
}

export function dryEyeQuestionnaireSummaryConcept(
  instrument: DryEyeQuestionnaireInstrument,
): CodeableConcept {
  return {
    coding: [
      {
        system: DRY_EYE_QUESTIONNAIRE_INSTRUMENT_CODE_SYSTEM,
        code: `${instrument}-summary-score`,
        display: `${displayForInstrument(instrument)} summary score`,
      },
    ],
    text: `${displayForInstrument(instrument)} summary score`,
  };
}

export function displayForInstrument(instrument: DryEyeQuestionnaireInstrument): string {
  switch (instrument) {
    case "OSDI":
      return "Ocular Surface Disease Index";
    case "SPEED":
      return "Standard Patient Evaluation of Eye Dryness";
    case "DEQ-5":
      return "Dry Eye Questionnaire 5";
    case "McMonnies":
      return "McMonnies Dry Eye Questionnaire";
  }
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
