import type { CodeableConcept, Device, DeviceProperty, Observation, Procedure, Quantity } from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir";

export const OSOD_FHIR_BASE = "https://osod.dev/fhir";
export const CONTACT_LENS_TYPE_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-type`;
export const CONTACT_LENS_PARAMETER_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-parameter`;
export const CONTACT_LENS_FITTING_EVENT_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-fitting-event`;
export const CONTACT_LENS_CLINICAL_OBSERVATION_CODE_SYSTEM = `${OSOD_FHIR_BASE}/CodeSystem/contact-lens-clinical-observation`;
export const DEVICE_CONTACT_LENS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Device-ContactLens`;
export const DEVICE_ORTHO_K_LENS_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Device-OrthoKLens`;
export const OBSERVATION_CONTACT_LENS_FIT_FINDING_PROFILE_URL = `${OSOD_FHIR_BASE}/StructureDefinition/Observation-ContactLensFitFinding`;
export const UCUM_CODE_SYSTEM = "http://unitsofmeasure.org";

export const ORTHO_K_FIT_FINDING_CODES = [
  "centration",
  "lens-decentration",
  "corneal-molding-response",
  "fluorescein-pattern",
  "edge-clearance",
  "comfort",
] as const;
export type OrthoKFitFindingCode = (typeof ORTHO_K_FIT_FINDING_CODES)[number];

export type OrthoKPropertyCode =
  | "base-curve-mm"
  | "base-curve-diopter"
  | "reverse-curve-depth-um"
  | "alignment-curve-mm"
  | "landing-zone"
  | "optic-zone-diameter-mm"
  | "diameter-mm"
  | "sphere-power"
  | "material"
  | "coating"
  | "center-thickness-mm"
  | "markings";

export type UcumUnitCode = "[diop]" | "mm" | "um" | "ms" | "%" | "deg" | "mJ" | "nm";

export interface ContactLensPropertyInput {
  code: OrthoKPropertyCode | string;
  valueNumber?: number;
  unitCode?: UcumUnitCode;
  valueCode?: string;
  valueSystem?: string;
  valueDisplay?: string;
  valueText?: string;
}

export interface BuildOrthoKLensDeviceInput {
  patientReference?: string;
  definitionReference?: string;
  deviceName?: string;
  manufacturer?: string;
  modelNumber?: string;
  lotNumber?: string;
  serialNumber?: string;
  status?: Device["status"];
  properties?: ContactLensPropertyInput[];
  coatingSubstanceReference?: string;
}

export interface BuildOrthoKFittingEventInput {
  patientReference: string;
  encounterReference?: string;
  lensDeviceReference: string;
  eventCode?: "initial-fit" | "refit" | "parameter-adjustment" | "failed-trial";
  status?: Procedure["status"];
  performedDateTime?: string;
  seriesProcedureReference?: string;
  noteText?: string;
}

export interface BuildOrthoKTrialProcedureInput extends BuildOrthoKFittingEventInput {
  trialNumber: number;
  outcomeText?: string;
  parameterChangeSummary?: string;
}

export interface BuildOrthoKFitObservationInput {
  patientReference: string;
  lensDeviceReference: string;
  findingCode: OrthoKFitFindingCode;
  encounterReference?: string;
  effectiveDateTime?: string;
  valueNumber?: number;
  unitCode?: UcumUnitCode;
  valueCode?: string;
  valueDisplay?: string;
  wearTimeMs?: number;
}

const PARAMETER_DISPLAYS: Record<string, string> = {
  "base-curve-mm": "Base curve in millimeters",
  "base-curve-diopter": "Base curve in diopters",
  "reverse-curve-depth-um": "Reverse curve depth",
  "alignment-curve-mm": "Alignment curve",
  "landing-zone": "Landing zone",
  "optic-zone-diameter-mm": "Optic zone diameter",
  "diameter-mm": "Diameter",
  "sphere-power": "Sphere power",
  material: "Material",
  coating: "Coating",
  "center-thickness-mm": "Center thickness",
  markings: "Lens markings",
};

const ORTHO_K_ALLOWED_PARAMETERS = new Set(Object.keys(PARAMETER_DISPLAYS));

export function buildOrthoKLensDevice(input: BuildOrthoKLensDeviceInput): Device {
  const properties = (input.properties ?? []).map((property) => buildLensDeviceProperty(property));
  return {
    resourceType: "Device",
    status: input.status ?? "active",
    meta: { profile: [DEVICE_CONTACT_LENS_PROFILE_URL, DEVICE_ORTHO_K_LENS_PROFILE_URL] },
    ...(input.coatingSubstanceReference
      ? {
          extension: [
            {
              url: `${OSOD_FHIR_BASE}/StructureDefinition/contact-lens-coating`,
              valueReference: { reference: normalizeReference(input.coatingSubstanceReference, "Substance") },
            },
          ],
        }
      : {}),
    ...(input.definitionReference
      ? { definition: { reference: normalizeReference(input.definitionReference, "DeviceDefinition") } }
      : {}),
    ...(input.manufacturer ? { manufacturer: input.manufacturer } : {}),
    ...(input.modelNumber ? { modelNumber: input.modelNumber } : {}),
    ...(input.lotNumber ? { lotNumber: input.lotNumber } : {}),
    ...(input.serialNumber ? { serialNumber: input.serialNumber } : {}),
    ...(input.deviceName ? { deviceName: [{ name: input.deviceName, type: "user-friendly-name" }] } : {}),
    type: {
      coding: [
        {
          system: CONTACT_LENS_TYPE_CODE_SYSTEM,
          code: "ortho-K",
          display: "Orthokeratology lens",
        },
      ],
      text: "Orthokeratology lens",
    },
    ...(input.patientReference
      ? { patient: { reference: normalizeReference(input.patientReference, "Patient") } }
      : {}),
    ...(properties.length ? { property: properties } : {}),
  };
}

export function buildOrthoKFittingEvent(input: BuildOrthoKFittingEventInput): Procedure {
  return {
    resourceType: "Procedure",
    status: input.status ?? "in-progress",
    code: fittingEventConcept(input.eventCode ?? "initial-fit"),
    subject: { reference: input.patientReference },
    ...(input.encounterReference ? { encounter: { reference: input.encounterReference } } : {}),
    ...(input.performedDateTime ? { performedDateTime: input.performedDateTime } : {}),
    ...(input.seriesProcedureReference
      ? { partOf: [{ reference: normalizeReference(input.seriesProcedureReference, "Procedure") }] }
      : {}),
    usedReference: [{ reference: normalizeReference(input.lensDeviceReference, "Device") }],
    ...(input.noteText ? { note: [{ text: input.noteText }] } : {}),
  };
}

export function buildOrthoKTrialProcedure(input: BuildOrthoKTrialProcedureInput): Procedure {
  const procedure = buildOrthoKFittingEvent({
    ...input,
    eventCode: input.eventCode ?? "parameter-adjustment",
    noteText: [`trial ${input.trialNumber}`, input.parameterChangeSummary, input.noteText]
      .filter(Boolean)
      .join("; "),
  });
  return {
    ...procedure,
    outcome: input.outcomeText ? { text: input.outcomeText } : procedure.outcome,
  };
}

export function buildOrthoKFitObservation(input: BuildOrthoKFitObservationInput): Observation {
  const components = input.wearTimeMs !== undefined
    ? [
        {
          code: clinicalObservationConcept("wear-time-duration"),
          valueQuantity: ucumQuantity(input.wearTimeMs, "ms"),
        },
      ]
    : undefined;

  return {
    resourceType: "Observation",
    status: "final",
    meta: { profile: [OBSERVATION_CONTACT_LENS_FIT_FINDING_PROFILE_URL] },
    code: clinicalObservationConcept(input.findingCode),
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
    subject: { reference: normalizeReference(input.patientReference, "Patient") },
    focus: [{ reference: normalizeReference(input.lensDeviceReference, "Device") }],
    ...(input.encounterReference ? { encounter: { reference: normalizeReference(input.encounterReference, "Encounter") } } : {}),
    effectiveDateTime: input.effectiveDateTime ?? new Date().toISOString(),
    ...(input.valueNumber !== undefined
      ? { valueQuantity: ucumQuantity(input.valueNumber, input.unitCode ?? "um") }
      : {}),
    ...(input.valueCode || input.valueDisplay
      ? {
          valueCodeableConcept: {
            coding: input.valueCode
              ? [
                  {
                    system: CONTACT_LENS_CLINICAL_OBSERVATION_CODE_SYSTEM,
                    code: input.valueCode,
                    display: input.valueDisplay,
                  },
                ]
              : undefined,
            text: input.valueDisplay ?? input.valueCode,
          },
        }
      : {}),
    ...(components ? { component: components } : {}),
  };
}

export function buildUpdateOrthoKLensParametersPatch(
  existing: Device,
  properties: ContactLensPropertyInput[],
): JsonPatchOperation[] {
  if (properties.length === 0) {
    throw new Error("update_ortho_k_lens_parameters requires at least one property.");
  }
  const next = [...(existing.property ?? [])];
  for (const input of properties) {
    const property = buildLensDeviceProperty(input);
    const code = property.type.coding?.[0]?.code;
    const index = next.findIndex((candidate) => candidate.type.coding?.[0]?.code === code);
    if (index >= 0) next[index] = property;
    else next.push(property);
  }
  return [{ op: existing.property ? "replace" : "add", path: "/property", value: next }];
}

function buildLensDeviceProperty(input: ContactLensPropertyInput): DeviceProperty {
  if (!ORTHO_K_ALLOWED_PARAMETERS.has(input.code)) {
    throw new Error(`${input.code} is not valid for contact lens type ortho-K.`);
  }
  if (input.valueNumber !== undefined) {
    if (!input.unitCode) {
      throw new Error(`Lens property ${input.code} requires unitCode when valueNumber is supplied.`);
    }
    return {
      type: parameterConcept(input.code),
      valueQuantity: [ucumQuantity(input.valueNumber, input.unitCode)],
    };
  }
  if (input.valueCode || input.valueDisplay || input.valueText) {
    return {
      type: parameterConcept(input.code),
      valueCode: [
        {
          ...(input.valueCode
            ? {
                coding: [
                  {
                    system: input.valueSystem ?? `${CONTACT_LENS_PARAMETER_CODE_SYSTEM}/${input.code}`,
                    code: input.valueCode,
                    ...(input.valueDisplay ? { display: input.valueDisplay } : {}),
                  },
                ],
              }
            : {}),
          text: input.valueText ?? input.valueDisplay ?? input.valueCode,
        },
      ],
    };
  }
  throw new Error(`Lens property ${input.code} requires a quantity or coded/text value.`);
}

function parameterConcept(code: string): CodeableConcept {
  return {
    coding: [
      {
        system: CONTACT_LENS_PARAMETER_CODE_SYSTEM,
        code,
        display: PARAMETER_DISPLAYS[code] ?? code,
      },
    ],
    text: PARAMETER_DISPLAYS[code] ?? code,
  };
}

function fittingEventConcept(code: NonNullable<BuildOrthoKFittingEventInput["eventCode"]>): CodeableConcept {
  return {
    coding: [{ system: CONTACT_LENS_FITTING_EVENT_CODE_SYSTEM, code, display: titleCase(code) }],
    text: titleCase(code),
  };
}

function clinicalObservationConcept(code: string): CodeableConcept {
  return {
    coding: [{ system: CONTACT_LENS_CLINICAL_OBSERVATION_CODE_SYSTEM, code, display: titleCase(code) }],
    text: titleCase(code),
  };
}

function ucumQuantity(value: number, code: UcumUnitCode): Quantity {
  return { value, system: UCUM_CODE_SYSTEM, code, unit: code };
}

function normalizeReference(value: string, resourceType: string): string {
  return value.startsWith(`${resourceType}/`) ? value : `${resourceType}/${value}`;
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
