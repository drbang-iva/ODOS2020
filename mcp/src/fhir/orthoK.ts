import type { CodeableConcept, Device, Observation, Procedure } from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir-client.js";
import {
  CONTACT_LENS_CLINICAL_OBSERVATION_CODE_SYSTEM,
  CONTACT_LENS_FITTING_EVENT_CODE_SYSTEM,
  CONTACT_LENS_TYPE_CODE_SYSTEM,
  buildLensDevice,
  buildLensFitObservation,
  buildUpdateLensDevicePropertiesPatch,
  type BuildLensDeviceInput,
  type ContactLensClinicalObservationCode,
  type ContactLensPropertyInput,
  type UcumUnitCode,
} from "./contactLens.js";

export const ORTHO_K_FIT_FINDING_CODES = [
  "centration",
  "lens-decentration",
  "corneal-molding-response",
  "fluorescein-pattern",
  "edge-clearance",
  "comfort",
] as const satisfies readonly ContactLensClinicalObservationCode[];

export type OrthoKFitFindingCode = (typeof ORTHO_K_FIT_FINDING_CODES)[number];

export interface BuildOrthoKLensDeviceInput extends Omit<BuildLensDeviceInput, "lensTypeCode"> {
  properties?: ContactLensPropertyInput[];
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
  bodySite?: CodeableConcept;
  wearTimeMs?: number;
}

export function buildOrthoKLensDevice(input: BuildOrthoKLensDeviceInput): Device {
  return buildLensDevice({
    ...input,
    lensTypeCode: "ortho-K",
  });
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
  return buildLensFitObservation({
    patientReference: input.patientReference,
    lensDeviceReference: input.lensDeviceReference,
    findingCode: input.findingCode,
    encounterReference: input.encounterReference,
    effectiveDateTime: input.effectiveDateTime,
    valueNumber: input.valueNumber,
    unitCode: input.unitCode,
    valueCode: input.valueCode,
    valueDisplay: input.valueDisplay,
    bodySite: input.bodySite,
    wearTimeMs: input.wearTimeMs,
  });
}

export function buildUpdateOrthoKLensParametersPatch(
  existing: Device,
  properties: ContactLensPropertyInput[],
): JsonPatchOperation[] {
  return buildUpdateLensDevicePropertiesPatch(existing, "ortho-K", properties);
}

export function orthoKTypeConcept(): CodeableConcept {
  return {
    coding: [
      {
        system: CONTACT_LENS_TYPE_CODE_SYSTEM,
        code: "ortho-K",
        display: "Orthokeratology lens",
      },
    ],
    text: "Orthokeratology lens",
  };
}

export function orthoKFitFindingConcept(code: OrthoKFitFindingCode): CodeableConcept {
  return {
    coding: [
      {
        system: CONTACT_LENS_CLINICAL_OBSERVATION_CODE_SYSTEM,
        code,
        display: titleCase(code),
      },
    ],
    text: titleCase(code),
  };
}

function fittingEventConcept(code: NonNullable<BuildOrthoKFittingEventInput["eventCode"]>): CodeableConcept {
  return {
    coding: [
      {
        system: CONTACT_LENS_FITTING_EVENT_CODE_SYSTEM,
        code,
        display: titleCase(code),
      },
    ],
    text: titleCase(code),
  };
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
