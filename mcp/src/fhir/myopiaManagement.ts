import type {
  CarePlan,
  CodeableConcept,
  DeviceUseStatement,
  Extension,
  MedicationStatement,
  Observation,
  Quantity,
  Reference,
  Resource,
  StructureDefinition,
} from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir-client.js";
import {
  ATROPINE_CONCENTRATION_UCUM_CODE_SYSTEM,
  LOINC_CODE_SYSTEM,
  MYOPIA_CONTROL_INTERVENTION_CODE_SYSTEM,
  OSOD_FHIR_BASE,
  UCUM_CODE_SYSTEM,
} from "./contactLens.js";
import { applyCommonObservationFields, osodConcept, quantity, reference } from "./ophthalmology/extensions.js";
import type { EyeLaterality } from "./ophthalmology/types.js";

export const MYOPIA_MANAGEMENT_CAREPLAN_PROFILE_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/CarePlan-MyopiaManagement`;
export const MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/myopia-careplan-activity-intervention`;
export const OBSERVATION_AXIAL_LENGTH_PROFILE_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/Observation-AxialLength`;
export const AXIAL_LENGTH_LOINC_BY_EYE = {
  OD: { code: "64742-0", display: "Right eye Axial length" },
  OS: { code: "66067-0", display: "Left eye Axial length" },
} as const;

export const MYOPIA_CONTROL_INTERVENTION_CODES = [
  "ortho-K",
  "atropine-low-dose",
  "atropine-medium-dose",
  "atropine-high-dose",
  "MiSight",
  "dual-focus-CL",
  "Stellest-spectacles",
  "undercorrection",
  "outdoor-time-Rx",
] as const;
export type MyopiaControlInterventionCode =
  (typeof MYOPIA_CONTROL_INTERVENTION_CODES)[number];

export const ATROPINE_CONCENTRATION_CODES = ["0.01%", "0.025%", "0.05%", "0.1%"] as const;
export type AtropineConcentrationCode = (typeof ATROPINE_CONCENTRATION_CODES)[number];

export const ATROPINE_MEDICATION_TIMELINE_STATUS_CODES = [
  "active",
  "tapering",
  "resolved",
] as const;
export type AtropineMedicationTimelineStatus =
  (typeof ATROPINE_MEDICATION_TIMELINE_STATUS_CODES)[number];

export interface MyopiaPlanActivityInput {
  interventionCode: MyopiaControlInterventionCode;
  status?: NonNullable<NonNullable<CarePlan["activity"]>[number]["detail"]>["status"];
  resourceReference?: string;
  scheduledDateTime?: string;
  description?: string;
}

export interface BuildMyopiaManagementCarePlanInput {
  patientReference: string;
  episodeOfCareReference?: string;
  encounterReference?: string;
  status?: CarePlan["status"];
  intent?: CarePlan["intent"];
  created?: string;
  title?: string;
  activities: MyopiaPlanActivityInput[];
  noteText?: string;
}

export interface BuildAtropineMedicationStatementInput {
  patientReference: string;
  concentration: AtropineConcentrationCode;
  frequencyText: string;
  status?: MedicationStatement["status"];
  encounterReference?: string;
  episodeOfCareReference?: string;
  effectiveDateTime?: string;
  dateAsserted?: string;
}

export interface BuildMyopiaAxialLengthObservationInput {
  patientReference: string;
  encounterReference: string;
  eye: EyeLaterality;
  measuredAt: string;
  valueMm: number;
  deviceReference?: string;
  performerReferences?: string[];
  sourceReferences?: string[];
  qualityScore?: number;
  confidenceScore?: number;
}

export interface BuildMyopiaDeviceUseStatementInput {
  patientReference: string;
  deviceReference: string;
  status?: DeviceUseStatement["status"];
  recordedOn?: string;
  timingDateTime?: string;
  interventionCode: MyopiaControlInterventionCode;
  indicationText?: string;
}

export function buildMyopiaManagementCarePlan(
  input: BuildMyopiaManagementCarePlanInput,
): CarePlan {
  if (input.activities.length === 0) {
    throw new Error("Myopia management CarePlan requires at least one activity.");
  }
  const supportingInfo = [
    input.episodeOfCareReference ? normalizeReference(input.episodeOfCareReference, "EpisodeOfCare") : undefined,
    ...input.activities.map((activity) => activity.resourceReference).filter(Boolean),
  ].filter((item): item is string => Boolean(item));

  return {
    resourceType: "CarePlan",
    meta: { profile: [MYOPIA_MANAGEMENT_CAREPLAN_PROFILE_URL] },
    status: input.status ?? "active",
    intent: input.intent ?? "plan",
    category: [{ text: "Myopia management" }],
    title: input.title ?? "Myopia management care plan",
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    created: input.created ?? new Date().toISOString(),
    ...(supportingInfo.length
      ? { supportingInfo: uniqueReferences(supportingInfo).map((item) => reference(item)) }
      : {}),
    activity: input.activities.map((activity) => carePlanActivity(activity)),
    ...(input.noteText ? { note: [{ text: input.noteText }] } : {}),
  };
}

export function buildUpdateMyopiaCarePlanPatch(
  existing: CarePlan,
  activities: MyopiaPlanActivityInput[],
  status?: CarePlan["status"],
): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  if (status !== undefined) {
    operations.push({ op: "replace", path: "/status", value: status });
  }
  if (activities.length) {
    operations.push({
      op: existing.activity ? "replace" : "add",
      path: "/activity",
      value: activities.map((activity) => carePlanActivity(activity)),
    });
    const nextSupportingInfo = [
      ...(existing.supportingInfo ?? []).map((item) => item.reference).filter(Boolean),
      ...activities.map((activity) => activity.resourceReference).filter(Boolean),
    ].filter((item): item is string => Boolean(item));
    operations.push({
      op: existing.supportingInfo ? "replace" : "add",
      path: "/supportingInfo",
      value: uniqueReferences(nextSupportingInfo).map((item) => reference(item)),
    });
  }
  if (operations.length === 0) {
    throw new Error("create_or_update_myopia_plan update requires status or activities.");
  }
  return operations;
}

export function buildAtropineMedicationStatement(
  input: BuildAtropineMedicationStatementInput,
): MedicationStatement {
  return {
    resourceType: "MedicationStatement",
    status: input.status ?? "active",
    medicationCodeableConcept: {
      text: `Atropine ${input.concentration}`,
      coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "1223", display: "Atropine" }],
    },
    subject: reference(input.patientReference),
    ...(input.encounterReference
      ? { context: reference(input.encounterReference) }
      : input.episodeOfCareReference
        ? { context: reference(input.episodeOfCareReference) }
        : {}),
    ...(input.effectiveDateTime ? { effectiveDateTime: input.effectiveDateTime } : {}),
    dateAsserted: input.dateAsserted ?? new Date().toISOString(),
    reasonCode: [myopiaInterventionConcept(interventionCodeForAtropine(input.concentration))],
    ...(input.episodeOfCareReference ? { reasonReference: [reference(input.episodeOfCareReference)] } : {}),
    dosage: [
      {
        text: input.frequencyText,
        route: { text: "Ophthalmic route" },
        doseAndRate: [
          {
            type: { text: "Compounded concentration" },
            doseQuantity: atropineConcentrationQuantity(input.concentration),
          },
        ],
      },
    ],
  };
}

export function medicationStatementStatusForAtropineTimeline(
  status: AtropineMedicationTimelineStatus,
): MedicationStatement["status"] {
  switch (status) {
    case "active":
    case "tapering":
      return "active";
    case "resolved":
      return "completed";
  }
}

export function buildMyopiaAxialLengthObservation(
  input: BuildMyopiaAxialLengthObservationInput,
): Observation {
  if (!Number.isFinite(input.valueMm) || input.valueMm <= 0) {
    throw new Error("Axial length must be a positive numeric millimeter value.");
  }
  return applyCommonObservationFields(
    {
      resourceType: "Observation",
      status: "final",
      meta: { profile: [OBSERVATION_AXIAL_LENGTH_PROFILE_URL] },
      code: axialLengthConcept(input.eye),
      valueQuantity: quantity(input.valueMm, "mm", UCUM_CODE_SYSTEM, "mm"),
    },
    {
      patientReference: input.patientReference,
      encounterReference: input.encounterReference,
      eye: input.eye,
      measuredAt: input.measuredAt,
      deviceReference: input.deviceReference,
      performerReferences: input.performerReferences,
      sourceReferences: input.sourceReferences,
      qualityScore: input.qualityScore,
      confidenceScore: input.confidenceScore,
    },
  );
}

export function buildMyopiaDeviceUseStatement(
  input: BuildMyopiaDeviceUseStatementInput,
): DeviceUseStatement {
  return {
    resourceType: "DeviceUseStatement",
    status: input.status ?? "active",
    subject: reference(input.patientReference),
    device: reference(input.deviceReference),
    recordedOn: input.recordedOn ?? new Date().toISOString(),
    ...(input.timingDateTime ? { timingDateTime: input.timingDateTime } : {}),
    reasonCode: [
      {
        ...myopiaInterventionConcept(input.interventionCode),
        ...(input.indicationText ? { text: input.indicationText } : {}),
      },
    ],
  };
}

export function axialLengthConcept(eye: EyeLaterality): CodeableConcept {
  const osod = osodConcept("AXIAL_LENGTH", "Axial length");
  const loinc = eye === "OD" || eye === "OS" ? AXIAL_LENGTH_LOINC_BY_EYE[eye] : undefined;
  return {
    coding: [
      ...(loinc ? [{ system: LOINC_CODE_SYSTEM, code: loinc.code, display: loinc.display }] : []),
      ...(osod.coding ?? []),
    ],
    text: osod.text,
  };
}

export function buildMyopiaCanonicalResources(): StructureDefinition[] {
  return [
    extensionDefinition(),
    carePlanProfile(),
  ];
}

export function myopiaInterventionConcept(code: MyopiaControlInterventionCode): CodeableConcept {
  return {
    coding: [{ system: MYOPIA_CONTROL_INTERVENTION_CODE_SYSTEM, code, display: titleCase(code) }],
    text: titleCase(code),
  };
}

export function atropineConcentrationQuantity(code: AtropineConcentrationCode): Quantity {
  return {
    value: Number(code.replace("%", "")),
    unit: "%",
    system: ATROPINE_CONCENTRATION_UCUM_CODE_SYSTEM,
    code,
  };
}

export function interventionCodeForAtropine(
  concentration: AtropineConcentrationCode,
): MyopiaControlInterventionCode {
  switch (concentration) {
    case "0.01%":
      return "atropine-low-dose";
    case "0.025%":
    case "0.05%":
      return "atropine-medium-dose";
    case "0.1%":
      return "atropine-high-dose";
  }
}

export function carePlanInterventionReference(
  activity: NonNullable<CarePlan["activity"]>[number],
): string | undefined {
  return activity.extension?.find(
    (extension) => extension.url === MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL,
  )?.valueReference?.reference;
}

function carePlanActivity(input: MyopiaPlanActivityInput): NonNullable<CarePlan["activity"]>[number] {
  const extensions: Extension[] = input.resourceReference
    ? [
        {
          url: MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL,
          valueReference: reference(input.resourceReference) as Reference<Resource>,
        },
      ]
    : [];
  return {
    ...(extensions.length ? { extension: extensions } : {}),
    detail: {
      status: input.status ?? "in-progress",
      code: myopiaInterventionConcept(input.interventionCode),
      ...(input.scheduledDateTime ? { scheduledTiming: { event: [input.scheduledDateTime] } } : {}),
      ...(input.description ? { description: input.description } : {}),
    },
  };
}

function extensionDefinition(): StructureDefinition {
  return {
    resourceType: "StructureDefinition",
    url: MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL,
    version: "0.4.0",
    name: "OSODMyopiaCarePlanActivityIntervention",
    title: "OSOD Myopia CarePlan Activity Intervention",
    status: "draft",
    publisher: "OSOD",
    description: "FHIR R4-valid reference from CarePlan.activity to the active intervention resource.",
    fhirVersion: "4.0.1",
    kind: "complex-type",
    abstract: false,
    type: "Extension",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
    derivation: "constraint",
    context: [{ type: "element", expression: "CarePlan.activity" }],
    differential: {
      element: withElementBase([
        { id: "Extension", path: "Extension", min: 0, max: "1", definition: "Referenced myopia intervention resource." },
        { id: "Extension.url", path: "Extension.url", min: 1, max: "1", definition: "Canonical extension URL.", fixedUri: MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL },
        {
          id: "Extension.value[x]",
          path: "Extension.value[x]",
          min: 1,
          max: "1",
          definition: "The intervention resource represented by this CarePlan activity.",
          type: [
            {
              code: "Reference",
              targetProfile: [
                "http://hl7.org/fhir/StructureDefinition/Device",
                "http://hl7.org/fhir/StructureDefinition/DeviceUseStatement",
                "http://hl7.org/fhir/StructureDefinition/MedicationStatement",
                "http://hl7.org/fhir/StructureDefinition/Procedure",
              ],
            },
          ],
        },
      ]),
    },
    snapshot: {
      element: withElementBase([
        { id: "Extension", path: "Extension", min: 0, max: "1", definition: "Referenced myopia intervention resource." },
        { id: "Extension.url", path: "Extension.url", min: 1, max: "1", definition: "Canonical extension URL.", fixedUri: MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL },
        { id: "Extension.value[x]", path: "Extension.value[x]", min: 1, max: "1", definition: "The intervention resource represented by this CarePlan activity.", type: [{ code: "Reference" }] },
      ]),
    },
  };
}

function carePlanProfile(): StructureDefinition {
  return {
    resourceType: "StructureDefinition",
    url: MYOPIA_MANAGEMENT_CAREPLAN_PROFILE_URL,
    version: "0.4.0",
    name: "OSODCarePlanMyopiaManagement",
    title: "OSOD CarePlan - Myopia Management",
    status: "draft",
    publisher: "OSOD",
    description: "CarePlan profile for coordinating myopia-management interventions.",
    fhirVersion: "4.0.1",
    kind: "resource",
    abstract: false,
    type: "CarePlan",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/CarePlan",
    derivation: "constraint",
    differential: {
      element: withElementBase([
        { id: "CarePlan", path: "CarePlan", min: 0, max: "*", definition: "Myopia management CarePlan." },
        { id: "CarePlan.activity", path: "CarePlan.activity", min: 1, max: "*", definition: "CarePlan activity entries for active or planned myopia interventions." },
        { id: "CarePlan.activity.detail", path: "CarePlan.activity.detail", min: 1, max: "1", definition: "Coded intervention detail." },
        { id: "CarePlan.supportingInfo", path: "CarePlan.supportingInfo", min: 0, max: "*", definition: "Episode and linked intervention resources supporting the plan." },
      ]),
    },
    snapshot: {
      element: withElementBase([
        { id: "CarePlan", path: "CarePlan", min: 0, max: "*", definition: "Myopia management CarePlan." },
        { id: "CarePlan.activity", path: "CarePlan.activity", min: 1, max: "*", definition: "CarePlan activity entries for active or planned myopia interventions." },
        { id: "CarePlan.activity.detail", path: "CarePlan.activity.detail", min: 1, max: "1", definition: "Coded intervention detail." },
        { id: "CarePlan.supportingInfo", path: "CarePlan.supportingInfo", min: 0, max: "*", definition: "Episode and linked intervention resources supporting the plan." },
      ]),
    },
  };
}

function normalizeReference(value: string, resourceType: string): string {
  return value.startsWith(`${resourceType}/`) ? value : `${resourceType}/${value}`;
}

function uniqueReferences(values: string[]): string[] {
  return [...new Set(values)];
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function withElementBase<T extends { id: string; path: string }>(
  elements: T[],
): Array<T & { base: { path: string; min: number; max: string } }> {
  return elements.map((element) => ({
    ...element,
    base: { path: element.path, min: 0, max: "*" },
  }));
}
