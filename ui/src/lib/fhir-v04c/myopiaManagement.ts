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
} from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir";

export const OSOD_FHIR_BASE = "https://osod.dev/fhir";
export const MYOPIA_MANAGEMENT_CAREPLAN_PROFILE_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/CarePlan-MyopiaManagement`;
export const MYOPIA_CAREPLAN_ACTIVITY_INTERVENTION_EXTENSION_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/myopia-careplan-activity-intervention`;
export const OBSERVATION_AXIAL_LENGTH_PROFILE_URL =
  `${OSOD_FHIR_BASE}/StructureDefinition/Observation-AxialLength`;
export const MYOPIA_CONTROL_INTERVENTION_CODE_SYSTEM =
  `${OSOD_FHIR_BASE}/CodeSystem/myopia-control-intervention`;
export const ATROPINE_CONCENTRATION_UCUM_CODE_SYSTEM =
  `${OSOD_FHIR_BASE}/CodeSystem/atropine-concentration-ucum`;
export const UCUM_CODE_SYSTEM = "http://unitsofmeasure.org";
export const LOINC_CODE_SYSTEM = "http://loinc.org";
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

export const ATROPINE_CONCENTRATION_CODES = [
  "0.01%",
  "0.025%",
  "0.05%",
  "0.1%",
] as const;
export type AtropineConcentrationCode =
  (typeof ATROPINE_CONCENTRATION_CODES)[number];

export type EyeLaterality = "OD" | "OS" | "OU";

export interface MyopiaPlanActivityInput {
  interventionCode: MyopiaControlInterventionCode;
  status?: NonNullable<NonNullable<CarePlan["activity"]>[number]["detail"]>["status"];
  resourceReference?: string;
  scheduledDateTime?: string;
  description?: string;
}

export function buildMyopiaManagementCarePlan(input: {
  patientReference: string;
  episodeOfCareReference?: string;
  encounterReference?: string;
  status?: CarePlan["status"];
  intent?: CarePlan["intent"];
  created?: string;
  title?: string;
  activities: MyopiaPlanActivityInput[];
  noteText?: string;
}): CarePlan {
  if (input.activities.length === 0) {
    throw new Error("Myopia management CarePlan requires at least one activity.");
  }
  const supportingInfo = [
    input.episodeOfCareReference
      ? normalizeReference(input.episodeOfCareReference, "EpisodeOfCare")
      : undefined,
    ...input.activities.map((activity) => activity.resourceReference).filter(Boolean),
  ].filter((item): item is string => Boolean(item));

  return {
    resourceType: "CarePlan",
    meta: { profile: [MYOPIA_MANAGEMENT_CAREPLAN_PROFILE_URL] },
    status: input.status ?? "active",
    intent: input.intent ?? "plan",
    category: [myopiaManagementCategory()],
    title: input.title ?? "Myopia management care plan",
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    created: input.created ?? new Date().toISOString(),
    ...(supportingInfo.length ? { supportingInfo: uniqueReferences(supportingInfo).map((item) => reference(item)) } : {}),
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

export function buildAtropineMedicationStatement(input: {
  patientReference: string;
  concentration: AtropineConcentrationCode;
  frequencyText: string;
  status?: MedicationStatement["status"];
  encounterReference?: string;
  episodeOfCareReference?: string;
  effectiveDateTime?: string;
  dateAsserted?: string;
}): MedicationStatement {
  return {
    resourceType: "MedicationStatement",
    status: input.status ?? "active",
    medicationCodeableConcept: {
      text: `Atropine ${input.concentration}`,
      coding: [
        {
          system: "http://www.nlm.nih.gov/research/umls/rxnorm",
          code: "1223",
          display: "Atropine",
        },
      ],
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

export function buildMyopiaAxialLengthObservation(input: {
  patientReference: string;
  encounterReference: string;
  eye: EyeLaterality;
  measuredAt: string;
  valueMm: number;
  deviceReference?: string;
}): Observation {
  return {
    resourceType: "Observation",
    status: "final",
    meta: { profile: [OBSERVATION_AXIAL_LENGTH_PROFILE_URL] },
    code: axialLengthConcept(input.eye),
    valueQuantity: { value: input.valueMm, unit: "mm", system: UCUM_CODE_SYSTEM, code: "mm" },
    subject: reference(input.patientReference),
    encounter: reference(input.encounterReference),
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "exam",
            display: "Exam",
          },
        ],
      },
    ],
    effectiveDateTime: input.measuredAt,
    bodySite: lateralityConcept(input.eye),
    extension: [
      {
        url: `${OSOD_FHIR_BASE}/StructureDefinition/eye-laterality`,
        valueCodeableConcept: lateralityConcept(input.eye),
      },
    ],
    ...(input.deviceReference ? { device: reference(input.deviceReference) } : {}),
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

export function buildMyopiaDeviceUseStatement(input: {
  patientReference: string;
  deviceReference: string;
  status?: DeviceUseStatement["status"];
  recordedOn?: string;
  timingDateTime?: string;
  interventionCode: MyopiaControlInterventionCode;
  indicationText?: string;
}): DeviceUseStatement {
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

export function myopiaInterventionConcept(code: MyopiaControlInterventionCode): CodeableConcept {
  return {
    coding: [
      {
        system: MYOPIA_CONTROL_INTERVENTION_CODE_SYSTEM,
        code,
        display: titleCase(code),
      },
    ],
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

function myopiaManagementCategory(): CodeableConcept {
  return { text: "Myopia management" };
}

function osodConcept(code: string, display: string): CodeableConcept {
  return {
    coding: [
      { system: `${OSOD_FHIR_BASE}/CodeSystem/ophthalmology`, code, display },
      { system: "http://snomed.info/sct", code: "363787002", display: "Observable entity" },
    ],
    text: display,
  };
}

function lateralityConcept(value: EyeLaterality): CodeableConcept {
  const display = value === "OD" ? "Right eye" : value === "OS" ? "Left eye" : "Both eyes";
  return {
    coding: [{ system: `${OSOD_FHIR_BASE}/CodeSystem/ophthalmology`, code: value, display }],
    text: display,
  };
}

function reference<T extends Resource = Resource>(value: string): Reference<T> {
  return { reference: value } as Reference<T>;
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
