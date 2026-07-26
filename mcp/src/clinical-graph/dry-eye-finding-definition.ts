import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import type { CustomFieldEntry } from "./custom-fields.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";
import { applyOcularHealthDiagnosisCandidates } from "./ocular-health-definition.js";

export const DRY_EYE_SYMPTOMS_KEY = "dry-eye:symptoms";
export const DRY_EYE_TEAR_STABILITY_SECTION_KEY = "dry-eye:tear-stability";
export const DRY_EYE_TEAR_VOLUME_KEY = "dry-eye:tear-volume";
export const DRY_EYE_MARKERS_KEY = "dry-eye:markers";
export const DRY_EYE_GLAND_STRUCTURE_KEY = "dry-eye:gland-structure";
export const DRY_EYE_GLAND_FUNCTION_KEY = "dry-eye:gland-function";
export const DRY_EYE_CONJUNCTIVAL_STAINING_KEY = "dry-eye:conjunctival-staining";
export const DRY_EYE_STAGING_KEY = "dry-eye:staging";

export const DRY_EYE_SECTION_ORDER = [
  DRY_EYE_SYMPTOMS_KEY,
  DRY_EYE_TEAR_STABILITY_SECTION_KEY,
  DRY_EYE_TEAR_VOLUME_KEY,
  DRY_EYE_MARKERS_KEY,
  DRY_EYE_GLAND_STRUCTURE_KEY,
  DRY_EYE_GLAND_FUNCTION_KEY,
  DRY_EYE_CONJUNCTIVAL_STAINING_KEY,
  DRY_EYE_STAGING_KEY,
] as const;

export function buildDryEyeFindingDefinitions(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition[] {
  return [
    definition({
      id: "finding-def-dry-eye-symptoms",
      stableKey: DRY_EYE_SYMPTOMS_KEY,
      display: "Symptoms",
      perEye: false,
      fields: [
        selectField("CUSTOM_INSTRUMENT", "Instrument", 0, [
          option("SPEED", "SPEED"),
          option("OSDI", "OSDI"),
          option("DEQ-5", "DEQ-5"),
        ], { allowCreate: true }),
        numberField("CUSTOM_TOTAL_SCORE", "Total score", 1, { min: 0 }),
        stringField("CUSTOM_DATE_ADMINISTERED", "Date administered", 2, {
          inputControl: "date",
        }),
        selectField("CUSTOM_UNABLE_TO_TEST", "Unable to test", 3, [
          option("unable", "Unable to test"),
        ], { inputControl: "toggle" }),
      ],
      provenance,
    }),
    definition({
      id: "finding-def-dry-eye-tear-volume",
      stableKey: DRY_EYE_TEAR_VOLUME_KEY,
      display: "Tear Volume",
      perEye: true,
      valueKind: "quantity",
      unit: { system: "http://unitsofmeasure.org", code: "mm", display: "mm" },
      fields: [
        numberField("CUSTOM_SCHIRMER_MM", "Schirmer wetting", 0, {
          min: 0,
          step: 1,
          unit: "mm",
        }),
        selectField("CUSTOM_VARIANT", "Variant", 1, [
          option("with-anesthesia", "With anesthesia"),
          option("without-anesthesia", "Without anesthesia"),
          option("phenol-red-thread", "Phenol red thread"),
        ]),
        numberField("CUSTOM_DURATION_MIN", "Duration", 2, {
          min: 0,
          step: 1,
          defaultValue: 5,
        }),
      ],
      provenance,
    }),
    definition({
      id: "finding-def-dry-eye-markers",
      stableKey: DRY_EYE_MARKERS_KEY,
      display: "Tear Film Markers",
      perEye: true,
      valueKind: "quantity",
      unit: {
        system: "http://unitsofmeasure.org",
        code: "mosm/L",
        display: "mOsm/L",
      },
      fields: [
        numberField("CUSTOM_OSMOLARITY_MOSM_L", "Osmolarity (mOsm/L)", 0, {
          min: 0,
          step: 1,
          unit: "mosm/L",
        }),
        stringField("CUSTOM_INSTRUMENT", "Instrument", 1),
        selectField("CUSTOM_INFLAMMATORY_MARKER_TEST", "Inflammatory marker test", 2, [
          option("mmp-9-inflammadry", "MMP-9 / InflammaDry (naming provisional)"),
        ]),
        selectField("CUSTOM_INFLAMMATORY_RESULT", "Inflammatory result", 3, [
          option("positive", "Positive"),
          option("negative", "Negative"),
          option("not-tested", "Not tested"),
        ]),
      ],
      provenance,
    }),
    definition({
      id: "finding-def-dry-eye-gland-structure",
      stableKey: DRY_EYE_GLAND_STRUCTURE_KEY,
      display: "Gland Structure",
      perEye: true,
      fields: [
        stringField("CUSTOM_IMAGE_REFERENCE", "Meibography image", 0),
        selectField(
          "CUSTOM_DROPOUT_GRADE",
          "Dropout grade (grading scheme provisional)",
          1,
          ["Grade 0", "Grade 1", "Grade 2", "Grade 3", "Grade 4"]
            .map((display) => option(slug(display), display)),
        ),
      ],
      provenance,
    }),
    definition({
      id: "finding-def-dry-eye-gland-function",
      stableKey: DRY_EYE_GLAND_FUNCTION_KEY,
      display: "Gland Function",
      perEye: true,
      relatedFindingDefinitionKeys: ["ocular-health:anterior:lids-lashes"],
      fields: [
        selectField("CUSTOM_EXPRESSIBILITY", "Expressibility", 0, [
          option("normal", "Normal"),
          option("reduced", "Reduced"),
          option("non-expressible", "Non-expressible"),
        ]),
        selectField("CUSTOM_SECRETION_QUALITY", "Secretion quality", 1, [
          option("clear", "Clear"),
          option("cloudy", "Cloudy"),
          option("granular", "Granular"),
          option("inspissated", "Inspissated"),
        ]),
        numberField("CUSTOM_GLANDS_YIELDING_LIQUID", "Glands yielding liquid", 2, {
          min: 0,
          max: 20,
          step: 1,
        }),
      ],
      provenance,
    }),
    definition({
      id: "finding-def-dry-eye-conjunctival-staining",
      stableKey: DRY_EYE_CONJUNCTIVAL_STAINING_KEY,
      display: "Surface Staining",
      perEye: true,
      valueSchemaType: "ocular-health-structure",
      normalTemplate: "No conjunctival staining.",
      fields: [
        selectField(
          "CUSTOM_CONJUNCTIVAL_STAINING_GRADE",
          "Conjunctival staining grade (grading scheme provisional)",
          0,
          ["Grade 0", "Grade 1", "Grade 2", "Grade 3", "Grade 4"]
            .map((display) => option(slug(display), display)),
        ),
        selectField("CUSTOM_VITAL_DYE", "Vital dye", 1, [
          option("fluorescein", "Fluorescein"),
          option("lissamine-green", "Lissamine green"),
        ]),
      ],
      provenance,
    }),
    definition({
      id: "finding-def-dry-eye-staging",
      stableKey: DRY_EYE_STAGING_KEY,
      display: "Staging & Subtype",
      perEye: false,
      fields: [
        selectField("CUSTOM_SUBTYPE", "Subtype", 0, [
          option("aqueous-deficient", "Aqueous-deficient"),
          option("evaporative-mgd", "Evaporative / MGD"),
          option("mixed", "Mixed"),
          option("neuropathic-pain-suspect", "Neuropathic pain suspect"),
        ]),
        selectField(
          "CUSTOM_SEVERITY_LEVEL",
          "Severity level (grading scheme provisional)",
          1,
          ["Level 1", "Level 2", "Level 3", "Level 4"]
            .map((display) => option(slug(display), display)),
        ),
        stringField("CUSTOM_TREATMENT_PHASE_NOTE", "Treatment phase note", 2),
      ],
      provenance,
    }),
  ].map(applyOcularHealthDiagnosisCandidates);
}

function definition(input: {
  id: string;
  stableKey: string;
  display: string;
  perEye: boolean;
  fields: CustomFieldEntry[];
  provenance: ClinicalGraphProvenance;
  valueKind?: string;
  valueSchemaType?: string;
  unit?: { system: string; code: string; display: string };
  normalTemplate?: string;
  relatedFindingDefinitionKeys?: string[];
}): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    id: input.id,
    stableKey: input.stableKey,
    display: input.display,
    sectionKey: input.stableKey,
    anatomyTarget: input.perEye ? "eye" : "other",
    valueSchema: {
      ...(input.valueKind ? { valueKind: input.valueKind } : {}),
      ...(input.valueSchemaType ? { type: input.valueSchemaType } : {}),
      perEye: input.perEye,
      ...(input.unit ? { unit: input.unit } : {}),
      ...(input.relatedFindingDefinitionKeys
        ? { relatedFindingDefinitionKeys: input.relatedFindingDefinitionKeys }
        : {}),
      fields: Object.fromEntries(input.fields.map((field) => [field.localCode, field])),
    },
    normalSemantics: input.normalTemplate
      ? { template: input.normalTemplate, diagnosisSuggestions: false }
      : { diagnosisSuggestions: false },
    sourceStatus: "verified-seed",
    fhirObservationCode: odosConcept(input.stableKey, input.display),
    allowDiagnosisMapping: false,
    notBillReady: true,
    active: true,
    provenance: input.provenance,
  });
}

function numberField(
  localCode: string,
  display: string,
  order: number,
  input: Pick<CustomFieldEntry, "min" | "max" | "step" | "unit" | "defaultValue"> = {},
): CustomFieldEntry {
  return {
    localCode,
    display,
    origin: "practice",
    valueType: "number",
    order,
    active: true,
    ...input,
  };
}

function stringField(
  localCode: string,
  display: string,
  order: number,
  input: Pick<CustomFieldEntry, "inputControl"> = {},
): CustomFieldEntry {
  return {
    localCode,
    display,
    origin: "practice",
    valueType: "string",
    order,
    active: true,
    ...input,
  };
}

function selectField(
  localCode: string,
  display: string,
  order: number,
  options: NonNullable<CustomFieldEntry["options"]>,
  input: Pick<CustomFieldEntry, "inputControl"> & { allowCreate?: boolean } = {},
): CustomFieldEntry {
  return {
    localCode,
    display,
    origin: "practice",
    valueType: "select",
    options,
    order,
    active: true,
    ...input,
  } as CustomFieldEntry;
}

function option(code: string, display: string) {
  return { code, display, active: true as const };
}

function slug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
