import type { Questionnaire, StructureDefinition } from "@medplum/fhirtypes";
import {
  DRY_EYE_QUESTIONNAIRE_INSTRUMENT_CODE_SYSTEM,
  DRY_EYE_TREATMENT_TYPE_CODE_SYSTEM,
  OSOD_FHIR_BASE,
} from "./contactLens.js";

export const DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/dry-eye-procedure-energy-mj`;
export const DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/dry-eye-procedure-wavelength-nm`;
export const DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/dry-eye-procedure-spot-count`;
export const OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/ophthalmic-medication-supply-type`;

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

export const DRY_EYE_QUESTIONNAIRE_URLS: Record<
  DryEyeQuestionnaireInstrument,
  string
> = {
  OSDI: `${OSOD_FHIR_BASE}/Questionnaire/dry-eye-osdi`,
  SPEED: `${OSOD_FHIR_BASE}/Questionnaire/dry-eye-speed`,
  "DEQ-5": `${OSOD_FHIR_BASE}/Questionnaire/dry-eye-deq-5`,
  McMonnies: `${OSOD_FHIR_BASE}/Questionnaire/dry-eye-mcmonnies`,
};

export const DRY_EYE_QUESTIONNAIRE_ITEM_COUNTS: Record<
  DryEyeQuestionnaireInstrument,
  number
> = {
  OSDI: 12,
  SPEED: 4,
  "DEQ-5": 5,
  McMonnies: 14,
};

export function questionnaireUrlForInstrument(
  instrument: DryEyeQuestionnaireInstrument,
): string {
  return DRY_EYE_QUESTIONNAIRE_URLS[instrument];
}

export function dryEyeTreatmentTypeConcept(code: DryEyeTreatmentTypeCode) {
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
) {
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
) {
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

export function buildDryEyeCanonicalResources(): Array<
  Questionnaire | StructureDefinition
> {
  return [
    ...buildDryEyeExtensionDefinitions(),
    observationProfile(
      "Observation-DryEyeQuestionnaireScore",
      "OSOD Observation - Dry Eye Questionnaire Score",
      "Summary score derived from a dry-eye QuestionnaireResponse.",
    ),
    ...DRY_EYE_QUESTIONNAIRE_INSTRUMENTS.map(buildDryEyeQuestionnaire),
  ];
}

function buildDryEyeQuestionnaire(
  instrument: DryEyeQuestionnaireInstrument,
): Questionnaire {
  const itemCount = DRY_EYE_QUESTIONNAIRE_ITEM_COUNTS[instrument];
  return {
    resourceType: "Questionnaire",
    url: questionnaireUrlForInstrument(instrument),
    version: "0.4.0",
    name: `OSODDryEye${instrument.replace(/[^A-Za-z0-9]/g, "")}`,
    title: displayForInstrument(instrument),
    status: "active",
    experimental: false,
    subjectType: ["Patient"],
    date: "2026-04-28",
    publisher: "OSOD",
    code: [
      {
        system: DRY_EYE_QUESTIONNAIRE_INSTRUMENT_CODE_SYSTEM,
        code: instrument,
        display: displayForInstrument(instrument),
      },
    ],
    item: Array.from({ length: itemCount }, (_, index) => ({
      linkId: `${instrument.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${index + 1}`,
      text: `${instrument} item ${index + 1}`,
      type: "integer",
      required: false,
    })),
  };
}

function buildDryEyeExtensionDefinitions(): StructureDefinition[] {
  return [
    quantityExtension(
      "dry-eye-procedure-energy-mj",
      "OSOD Dry Eye Procedure Energy",
      "Dry-eye treatment energy in millijoules.",
      DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL,
      "Procedure",
    ),
    quantityExtension(
      "dry-eye-procedure-wavelength-nm",
      "OSOD Dry Eye Procedure Wavelength",
      "Dry-eye treatment wavelength in nanometers.",
      DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL,
      "Procedure",
    ),
    valueExtension(
      "dry-eye-procedure-spot-count",
      "OSOD Dry Eye Procedure Spot Count",
      "Dry-eye treatment spot count.",
      DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL,
      "Procedure",
      [{ code: "integer" }],
    ),
    valueExtension(
      "ophthalmic-medication-supply-type",
      "OSOD Ophthalmic Medication Supply Type",
      "OTC, prescription, or supplement supply type for ophthalmic medication statements.",
      OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL,
      "MedicationStatement",
      [{ code: "code" }],
    ),
  ];
}

function observationProfile(
  id: string,
  title: string,
  description: string,
): StructureDefinition {
  const url = `${OSOD_FHIR_BASE}/StructureDefinition/${id}`;
  const element = withElementBase([
    { id: "Observation", path: "Observation", min: 0, max: "*", definition: `${title} resource.` },
    { id: "Observation.subject", path: "Observation.subject", min: 1, max: "1", definition: "Patient subject for the clinical observation." },
    { id: "Observation.code", path: "Observation.code", min: 1, max: "1", definition: "Dry-eye questionnaire score code." },
    {
      id: "Observation.derivedFrom",
      path: "Observation.derivedFrom",
      min: 1,
      max: "*",
      definition: "QuestionnaireResponse from which the summary score was computed.",
    },
  ]);
  return {
    resourceType: "StructureDefinition",
    url,
    version: "0.4.0",
    name: `OSOD${id.replace(/[^A-Za-z0-9]/g, "")}`,
    title,
    status: "draft",
    publisher: "OSOD",
    description,
    fhirVersion: "4.0.1",
    kind: "resource",
    abstract: false,
    type: "Observation",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Observation",
    derivation: "constraint",
    differential: { element },
    snapshot: { element },
  };
}

function quantityExtension(
  id: string,
  title: string,
  definition: string,
  url: string,
  contextExpression: string,
): StructureDefinition {
  return valueExtension(id, title, definition, url, contextExpression, [
    { code: "Quantity" },
  ]);
}

function valueExtension(
  id: string,
  title: string,
  definition: string,
  url: string,
  contextExpression: string,
  valueTypes: Array<{ code: string }>,
): StructureDefinition {
  const element = withElementBase([
    { id: "Extension", path: "Extension", min: 0, max: "1", definition },
    {
      id: "Extension.url",
      path: "Extension.url",
      min: 1,
      max: "1",
      definition: "Canonical extension URL.",
      fixedUri: url,
    },
    {
      id: "Extension.value[x]",
      path: "Extension.value[x]",
      min: 1,
      max: "1",
      definition,
      type: valueTypes,
    },
  ]);

  return {
    resourceType: "StructureDefinition",
    url,
    version: "0.4.0",
    name: `OSOD${id.replace(/[^A-Za-z0-9]/g, "")}`,
    title,
    status: "draft",
    publisher: "OSOD",
    description: definition,
    fhirVersion: "4.0.1",
    kind: "complex-type",
    abstract: false,
    type: "Extension",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
    derivation: "constraint",
    context: [{ type: "element", expression: contextExpression }],
    differential: { element },
    snapshot: { element },
  };
}

function withElementBase(
  element: NonNullable<StructureDefinition["differential"]>["element"],
): NonNullable<StructureDefinition["differential"]>["element"] {
  return element.map((entry, index) => ({
    ...entry,
    id: entry.id ?? entry.path,
    path: entry.path,
    min: entry.min ?? (index === 0 ? 0 : 0),
    max: entry.max ?? "*",
    base: {
      path: entry.path,
      min: entry.min ?? 0,
      max: entry.max ?? "1",
    },
  }));
}

function displayForInstrument(instrument: DryEyeQuestionnaireInstrument): string {
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

function displayForTreatmentType(code: DryEyeTreatmentTypeCode): string {
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
