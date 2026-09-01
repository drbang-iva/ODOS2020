import type { Observation } from "@medplum/fhirtypes";
import type { CustomFieldEntry } from "./custom-fields.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type FindingValue,
} from "./glaucoma-suspect.js";

const PUPILS_KEY = "entrance:pupils";
const PUPIL_NORMAL_VALUES = {
  CUSTOM_PUPIL_SIZE_BRIGHT: 3,
  CUSTOM_PUPIL_SIZE_DIM: 5,
  CUSTOM_PUPIL_SHAPE: "round",
  CUSTOM_PUPIL_REACTIVITY: "brisk",
} as const;
const STEREO_KEY = "entrance:stereo";
const COLOR_KEY = "entrance:color";
export const EOM_KEY = "entrance:eom";
export const CVF_KEY = "entrance:cvf";
export const VISUAL_FIELD_DEFECT_KEY = "entrance:visual-field-defect";
export const VISUAL_FIELD_DESCRIPTOR_FIELD = "CUSTOM_FIELD_DEFECT";
export const COVER_TEST_KEY = "entrance:cover";
export const PACHYMETRY_KEY = "pachymetry_um";
export const MANUAL_K_KEY = "manual_keratometry";
export const DILATION_KEY = "entrance:dilation";

export function buildEntranceFindingDefinitions(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition[] {
  return [
    stateDefinition(PUPILS_KEY, "Pupils", "PERRLA; no RAPD OU", [
      { ...numberField("CUSTOM_PUPIL_SIZE_BRIGHT", "Size — bright", 1, 9, 0.5, "mm", 0), defaultValue: PUPIL_NORMAL_VALUES.CUSTOM_PUPIL_SIZE_BRIGHT },
      { ...numberField("CUSTOM_PUPIL_SIZE_DIM", "Size — dim", 1, 9, 0.5, "mm", 1), defaultValue: PUPIL_NORMAL_VALUES.CUSTOM_PUPIL_SIZE_DIM },
      numberField("CUSTOM_PUPIL_SIZE_NEAR", "Size — near", 1, 9, 0.5, "mm", 2),
      { ...selectField("CUSTOM_PUPIL_SHAPE", "Shape", ["round", "irregular"], 3), defaultValue: PUPIL_NORMAL_VALUES.CUSTOM_PUPIL_SHAPE },
      { ...selectField("CUSTOM_PUPIL_REACTIVITY", "Reactivity", ["brisk", "moderate", "sluggish", "nonreactive"], 4), defaultValue: PUPIL_NORMAL_VALUES.CUSTOM_PUPIL_REACTIVITY },
      selectField("CUSTOM_PUPIL_RAPD", "RAPD", ["none", "trace", "1+", "2+", "3+", "4+", "reverse"], 5),
      selectField("CUSTOM_PUPIL_NEUTRAL_DENSITY", "Neutral density (log units)", ["none", "0.3", "0.6", "0.9", "1.2"], 6),
    ], "entrance.pupils", provenance, {
      sourceStatus: "unseeded-needs-operator-input",
      setupMessage: "The additional pupil descriptor fields need practice setup before they can be added.",
    }),
    stateDefinition(STEREO_KEY, "Stereopsis", "Stereo present", [
      selectField("CUSTOM_STEREO_TEST", "Test", ["Stereo Fly", "Random Dot", "Randot", "Reindeer", "Titmus Stereo Test"], 0),
      selectField("CUSTOM_STEREO_ARC_SECONDS", "Seconds of arc", [], 1),
      selectField("CUSTOM_STEREO_UNABLE", "Unable to test", ["no", "yes"], 2),
    ], "entrance.stereo", provenance, {
      perEye: false,
      sourceStatus: "unseeded-needs-operator-input",
      setupMessage: "Seconds-of-arc choices need practice setup; no clinical values were guessed.",
    }),
    stateDefinition(COLOR_KEY, "Color vision", "Color normal per test OU", [
      selectField("CUSTOM_COLOR_TEST", "Test", ["Ishihara", "HRR"], 0),
      selectField("CUSTOM_COLOR_PLATES_CORRECT", "Plates correct", ["1", "2", "3", "4", "5", "6", "7"], 1),
      numberField("CUSTOM_COLOR_PLATES_TOTAL", "Plates total", 0, 100, 1, undefined, 2),
      selectField("CUSTOM_COLOR_UNABLE", "Unable to test", ["no", "yes"], 3),
    ], "entrance.color", provenance, {
      sourceStatus: "unseeded-needs-operator-input",
      setupMessage: "Ishihara derives 7 total plates. HRR plate total still needs practice setup.",
    }),
    buildClinicalFindingDefinition({
      id: "finding-def-entrance-eom",
      stableKey: EOM_KEY,
      display: "EOM / diplopia",
      sectionKey: EOM_KEY,
      anatomyTarget: "eye",
      valueSchema: {
        type: "eom-section",
        perEye: true,
        fields: Object.fromEntries(eomPositionFields().map((field) => [field.localCode, field])),
      },
      normalSemantics: { template: "Full OU — SAFE", allowDeferred: true },
      sourceStatus: "verified-seed",
      allowDiagnosisMapping: true,
      diagnosisCandidates: ["diplopia", "paralytic_strabismus"].map((diagnosisKey, index) => ({
        id: `SEED_EOM_DIPLOPIA_${index + 1}`,
        diagnosisKey,
        trigger: {
          kind: "allOf" as const,
          triggers: [
            { kind: "option" as const, field: "binocular", anyOf: ["yes"] },
            { kind: "option" as const, field: "incomitant", anyOf: ["yes"] },
          ],
        },
        priority: true,
        origin: "seed" as const,
        active: true,
      })),
      documentationElements: [{ code: "entrance.eom", origin: "seed", active: true }],
      notBillReady: true,
      active: true,
      provenance,
    }),
    stateDefinition(CVF_KEY, "Confrontation visual fields", "Full to finger counting OU", [
      selectField("CUSTOM_CVF_UPPER_LEFT", "Upper left", ["restricted", "full"], 0),
      selectField("CUSTOM_CVF_UPPER_RIGHT", "Upper right", ["restricted", "full"], 1),
      selectField("CUSTOM_CVF_LOWER_LEFT", "Lower left", ["restricted", "full"], 2),
      selectField("CUSTOM_CVF_LOWER_RIGHT", "Lower right", ["restricted", "full"], 3),
      selectField("CUSTOM_CVF_UNABLE", "Unable", ["no", "yes"], 4),
      selectField("CUSTOM_CVF_METHOD", "Method", ["finger count", "hand motion"], 5),
    ], "entrance.cvf", provenance),
    visualFieldDefectDefinition(provenance),
    buildClinicalFindingDefinition({
      id: "finding-def-entrance-cover",
      stableKey: COVER_TEST_KEY,
      display: "Cover test",
      sectionKey: COVER_TEST_KEY,
      anatomyTarget: "eye",
      valueSchema: { type: "cover-test-section", perEye: false, fields: {} },
      normalSemantics: { diagnosisSuggestions: false },
      sourceStatus: "verified-seed",
      allowDiagnosisMapping: false,
      documentationElements: [{ code: "entrance.cover", origin: "seed", active: true }],
      notBillReady: true,
      active: true,
      provenance,
    }),
    measurementDefinition({
      stableKey: PACHYMETRY_KEY,
      sectionKey: "entrance:pachymetry",
      display: "Pachymetry",
      fields: [
        decimalField("CUSTOM_CCT", "Central corneal thickness", 200, 1000, 0, "um", 0, 540),
        selectField("CUSTOM_PACHYMETRY_METHOD", "Method", ["ultrasound", "optical"], 1),
        stringField("CUSTOM_PACHYMETRY_TIME", "Time", "time-input", 2),
      ],
      documentationCode: "entrance.pachymetry",
      provenance,
    }),
    measurementDefinition({
      stableKey: MANUAL_K_KEY,
      sectionKey: "entrance:manual-keratometry",
      display: "Manual keratometry",
      fields: [
        decimalField("CUSTOM_FLAT_K", "Flat K", 30, 60, 2, "[diop]", 0, 43.5),
        integerSelectField("CUSTOM_FLAT_AXIS", "Flat axis", 0, 180, 1),
        decimalField("CUSTOM_STEEP_K", "Steep K", 30, 60, 2, "[diop]", 2, 43.5),
        integerSelectField("CUSTOM_STEEP_AXIS", "Steep axis", 0, 180, 3),
        selectField("CUSTOM_MIRES_QUALITY", "Mires quality", ["clear", "distorted"], 4),
      ],
      provenance,
    }),
    buildClinicalFindingDefinition({
      id: "finding-def-entrance-dilation",
      stableKey: DILATION_KEY,
      display: "Dilation",
      sectionKey: "entrance:dilation",
      anatomyTarget: "eye",
      valueSchema: {
        type: "dilation-administration",
        fields: {
          agent: {
            localCode: "CUSTOM_DILATION_AGENT",
            display: "Agent",
            origin: "practice",
            valueType: "select",
            type: "catalog-select",
            editable: true,
            options: [
              { code: "tropicamide-1", display: "Tropicamide 1%", active: true },
              { code: "phenylephrine-2-5", display: "Phenylephrine 2.5%", active: true },
              { code: "cyclopentolate", display: "Cyclopentolate", active: true },
            ],
            order: 0,
            active: true,
          },
          drops: { display: "Drops", type: "integer-input", minimum: 1, maximum: 10 },
          eyes: {
            display: "Eye(s)",
            type: "single-select",
            options: [
              { code: "OD", display: "OD", active: true },
              { code: "OS", display: "OS", active: true },
              { code: "OU", display: "OU", active: true },
            ],
          },
          time: { display: "Time", type: "time-input" },
          administeredBy: { display: "Administered by", type: "string" },
        },
      },
      normalSemantics: { diagnosisSuggestions: false },
      sourceStatus: "verified-seed",
      allowDiagnosisMapping: false,
      documentationElements: [{ code: "entrance.dilation.dfe", origin: "seed", active: true }],
      notBillReady: true,
      active: true,
      provenance,
    }),
  ];
}

type VisualFieldCodeSelection =
  | { kind: "eye"; slot: "right" | "left" }
  | { kind: "field"; slot: "right" | "left" }
  | { kind: "fixed" };

export interface VisualFieldDescriptorResolution {
  descriptor: string;
  diagnosisKey?: "vf_other_localized" | "vf_heteronymous_bilateral" | "vf_homonymous_bilateral";
  codeSelection?: VisualFieldCodeSelection;
}

const VISUAL_FIELD_DESCRIPTORS: Array<{
  code: string;
  display: string;
  lesionSite?: "pre-chiasmal" | "chiasmal" | "post-chiasmal";
  diagnosisKey?: VisualFieldDescriptorResolution["diagnosisKey"];
  codeSelection?: VisualFieldCodeSelection;
}> = [
  { code: "no-defect", display: "No defect" },
  { code: "field-loss-od", display: "Field loss OD", lesionSite: "pre-chiasmal", diagnosisKey: "vf_other_localized", codeSelection: { kind: "eye", slot: "right" } },
  { code: "field-loss-os", display: "Field loss OS", lesionSite: "pre-chiasmal", diagnosisKey: "vf_other_localized", codeSelection: { kind: "eye", slot: "left" } },
  { code: "bitemporal-hemianopsia", display: "Bitemporal hemianopsia", lesionSite: "chiasmal", diagnosisKey: "vf_heteronymous_bilateral", codeSelection: { kind: "fixed" } },
  { code: "right-homonymous-hemianopsia", display: "Right homonymous hemianopsia", lesionSite: "post-chiasmal", diagnosisKey: "vf_homonymous_bilateral", codeSelection: { kind: "field", slot: "right" } },
  { code: "left-homonymous-hemianopsia", display: "Left homonymous hemianopsia", lesionSite: "post-chiasmal", diagnosisKey: "vf_homonymous_bilateral", codeSelection: { kind: "field", slot: "left" } },
  { code: "superior-right-homonymous-quadrantanopia", display: "Superior right homonymous quadrantanopia", lesionSite: "post-chiasmal", diagnosisKey: "vf_homonymous_bilateral", codeSelection: { kind: "field", slot: "right" } },
  { code: "inferior-right-homonymous-quadrantanopia", display: "Inferior right homonymous quadrantanopia", lesionSite: "post-chiasmal", diagnosisKey: "vf_homonymous_bilateral", codeSelection: { kind: "field", slot: "right" } },
  { code: "superior-left-homonymous-quadrantanopia", display: "Superior left homonymous quadrantanopia", lesionSite: "post-chiasmal", diagnosisKey: "vf_homonymous_bilateral", codeSelection: { kind: "field", slot: "left" } },
  { code: "inferior-left-homonymous-quadrantanopia", display: "Inferior left homonymous quadrantanopia", lesionSite: "post-chiasmal", diagnosisKey: "vf_homonymous_bilateral", codeSelection: { kind: "field", slot: "left" } },
];

export function visualFieldDescriptorResolution(
  definitionStableKey: string | undefined,
  value: FindingValue | undefined,
): VisualFieldDescriptorResolution | undefined {
  if (definitionStableKey !== VISUAL_FIELD_DEFECT_KEY || value?.type !== "components") return undefined;
  const descriptor = value.components.find((component) =>
    component.code === VISUAL_FIELD_DESCRIPTOR_FIELD
  )?.value;
  if (typeof descriptor !== "string") return undefined;
  const row = VISUAL_FIELD_DESCRIPTORS.find((candidate) => candidate.code === descriptor);
  return row ? {
    descriptor: row.code,
    ...(row.diagnosisKey ? { diagnosisKey: row.diagnosisKey } : {}),
    ...(row.codeSelection ? { codeSelection: row.codeSelection } : {}),
  } : undefined;
}

export function visualFieldDescriptorResolutionFromObservation(
  definitionStableKey: string | undefined,
  observation: Observation | undefined,
): VisualFieldDescriptorResolution | undefined {
  if (definitionStableKey !== VISUAL_FIELD_DEFECT_KEY || !observation) return undefined;
  const descriptor = observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === VISUAL_FIELD_DESCRIPTOR_FIELD)
  )?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  if (!descriptor) return undefined;
  const row = VISUAL_FIELD_DESCRIPTORS.find((candidate) => candidate.code === descriptor);
  return row ? {
    descriptor: row.code,
    ...(row.diagnosisKey ? { diagnosisKey: row.diagnosisKey } : {}),
    ...(row.codeSelection ? { codeSelection: row.codeSelection } : {}),
  } : undefined;
}

function visualFieldDefectDefinition(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  const field: CustomFieldEntry = {
    localCode: VISUAL_FIELD_DESCRIPTOR_FIELD,
    display: "Field Defect",
    origin: "practice",
    valueType: "select",
    options: VISUAL_FIELD_DESCRIPTORS.map((row) => ({
      code: row.code,
      display: row.display,
      active: true,
      ...(row.lesionSite ? { parentCode: row.lesionSite } : {}),
    })),
    order: 0,
    active: true,
  };
  return buildClinicalFindingDefinition({
    id: "finding-def-entrance-visual-field-defect",
    stableKey: VISUAL_FIELD_DEFECT_KEY,
    display: "Visual Field",
    sectionKey: VISUAL_FIELD_DEFECT_KEY,
    anatomyTarget: "other",
    valueSchema: {
      type: "visual-field-defect",
      perEye: false,
      fields: { [field.localCode]: field },
    },
    sourceStatus: "verified-seed",
    allowDiagnosisMapping: true,
    diagnosisCandidates: VISUAL_FIELD_DESCRIPTORS.flatMap((row, index) => row.diagnosisKey ? [{
      id: `SEED_VISUAL_FIELD_DESCRIPTOR_${index + 1}`,
      diagnosisKey: row.diagnosisKey,
      trigger: { kind: "option" as const, field: VISUAL_FIELD_DESCRIPTOR_FIELD, anyOf: [row.code] },
      priority: true,
      origin: "seed" as const,
      active: true,
    }] : []),
    documentationElements: [{ code: "entrance.visual-field-defect", origin: "seed", active: true }],
    notBillReady: true,
    active: true,
    provenance,
  });
}

function eomPositionFields(): CustomFieldEntry[] {
  return [
    ["UP_LEFT", "Up left"], ["UP", "Up"], ["UP_RIGHT", "Up right"],
    ["LEFT", "Left"], ["PRIMARY", "Primary"], ["RIGHT", "Right"],
    ["DOWN_LEFT", "Down left"], ["DOWN", "Down"], ["DOWN_RIGHT", "Down right"],
  ].map(([code, display], order) => selectField(
    `CUSTOM_EOM_POS_${code}`,
    display!,
    ["-4", "-3", "-2", "-1", "0", "+1", "+2", "+3", "+4"],
    order,
  ));
}

function stateDefinition(
  stableKey: string,
  display: string,
  template: string,
  fields: CustomFieldEntry[],
  documentationCode: string,
  provenance: ClinicalGraphProvenance,
  config: {
    perEye?: boolean;
    sourceStatus?: ClinicalFindingDefinition["sourceStatus"];
    setupMessage?: string;
  } = {},
): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    id: `finding-def-${stableKey.replaceAll(":", "-")}`,
    stableKey,
    display,
    sectionKey: stableKey,
    anatomyTarget: "eye",
    valueSchema: {
      type: "entrance-state-section",
      perEye: config.perEye ?? true,
      fields: Object.fromEntries(fields.map((field) => [field.localCode, field])),
    },
    normalSemantics: {
      template,
      allowDeferred: true,
      ...(config.setupMessage ? { setupMessage: config.setupMessage } : {}),
    },
    sourceStatus: config.sourceStatus ?? "verified-seed",
    allowDiagnosisMapping: false,
    documentationElements: [{ code: documentationCode, origin: "seed", active: true }],
    notBillReady: true,
    active: true,
    provenance,
  });
}

function measurementDefinition(input: {
  stableKey: string;
  sectionKey: string;
  display: string;
  fields: CustomFieldEntry[];
  documentationCode?: string;
  provenance: ClinicalGraphProvenance;
}): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    id: `finding-def-${input.stableKey.replaceAll("_", "-")}`,
    stableKey: input.stableKey,
    display: input.display,
    sectionKey: input.sectionKey,
    anatomyTarget: "cornea",
    valueSchema: {
      type: "entrance-measurement",
      perEye: true,
      fields: Object.fromEntries(input.fields.map((field) => [field.localCode, field])),
    },
    normalSemantics: { diagnosisSuggestions: false },
    sourceStatus: "verified-seed",
    allowDiagnosisMapping: false,
    documentationElements: input.documentationCode
      ? [{ code: input.documentationCode, origin: "seed", active: true }]
      : [],
    notBillReady: true,
    active: true,
    provenance: input.provenance,
  });
}

function numberField(
  localCode: string,
  display: string,
  min: number,
  max: number,
  step: number,
  unit: CustomFieldEntry["unit"] | undefined,
  order: number,
): CustomFieldEntry {
  return { localCode, display, origin: "practice", valueType: "number", min, max, step, ...(unit ? { unit } : {}), order, active: true };
}

function decimalField(
  localCode: string,
  display: string,
  minimum: number,
  maximum: number,
  precision: number,
  unit: CustomFieldEntry["unit"],
  order: number,
  defaultValue: number,
): CustomFieldEntry {
  return {
    ...numberField(localCode, display, minimum, maximum, precision === 0 ? 1 : 10 ** -precision, unit, order),
    type: "decimal-input",
    minimum,
    maximum,
    precision,
    defaultValue,
  } as CustomFieldEntry;
}

function integerSelectField(
  localCode: string,
  display: string,
  minimum: number,
  maximum: number,
  order: number,
): CustomFieldEntry {
  return {
    ...numberField(localCode, display, minimum, maximum, 1, "deg", order),
    type: "integer-select",
    minimum,
    maximum,
    precision: 0,
  } as CustomFieldEntry;
}

function stringField(
  localCode: string,
  display: string,
  type: string,
  order: number,
): CustomFieldEntry {
  return { localCode, display, origin: "practice", valueType: "string", type, order, active: true } as CustomFieldEntry;
}

function selectField(
  localCode: string,
  display: string,
  values: string[],
  order: number,
): CustomFieldEntry {
  return {
    localCode,
    display,
    origin: "practice",
    valueType: "select",
    options: values.map((value) => ({ code: optionCode(value), display: value, active: true })),
    order,
    active: true,
  };
}

function optionCode(value: string): string {
  return value.toLowerCase().replaceAll("+", "-plus").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
