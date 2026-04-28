import type { Extension, Procedure } from "@medplum/fhirtypes";
import {
  OSOD_FHIR_BASE,
  UCUM_CODE_SYSTEM,
} from "./contactLens.js";
import {
  DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL,
  DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL,
  DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL,
  dryEyeTreatmentTypeConcept,
  type DryEyeTreatmentTypeCode,
} from "./dryEyeTerminology.js";
import { reference } from "./ophthalmology/extensions.js";

export const DRY_EYE_PROCEDURE_STATUS_CODES = [
  "preparation",
  "in-progress",
  "not-done",
  "on-hold",
  "stopped",
  "completed",
  "entered-in-error",
  "unknown",
] as const;
export type DryEyeProcedureStatusCode =
  (typeof DRY_EYE_PROCEDURE_STATUS_CODES)[number];
export type DryEyeProcedureStatusUpdate = "in-progress" | "completed" | "aborted";

export const DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM =
  `${OSOD_FHIR_BASE}/Identifier/dry-eye-treatment-session`;

export interface DryEyeTreatmentParametersInput {
  energyMj?: number;
  wavelengthNm?: number;
  spotCount?: number;
}

export interface DryEyeTreatmentProcedureInput {
  patientReference: string;
  treatmentType: DryEyeTreatmentTypeCode;
  status?: DryEyeProcedureStatusCode;
  encounterReference?: string;
  seriesProcedureReference?: string;
  performedDateTime?: string;
  performedPeriodStart?: string;
  performedPeriodEnd?: string;
  treatmentDeviceReference?: string;
  reasonText?: string;
  sessionNumber?: number;
  totalSessions?: number;
  parameters?: DryEyeTreatmentParametersInput;
}

export interface DryEyeTreatmentSeriesInput {
  patientReference: string;
  treatmentType: DryEyeTreatmentTypeCode;
  encounterReference?: string;
  seriesStartDateTime?: string;
  totalSessions: number;
  treatmentDeviceReference?: string;
  reasonText?: string;
  childScheduleDateTimes?: string[];
  parameters?: DryEyeTreatmentParametersInput;
}

export function buildDryEyeTreatmentSeriesProcedure(
  input: DryEyeTreatmentSeriesInput,
): Procedure {
  if (!Number.isInteger(input.totalSessions) || input.totalSessions < 1) {
    throw new Error("Dry-eye treatment series requires at least one planned session.");
  }

  return {
    resourceType: "Procedure",
    status: "in-progress",
    category: dryEyeTreatmentCategory(),
    code: dryEyeTreatmentTypeConcept(input.treatmentType),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    ...(input.seriesStartDateTime ? { performedDateTime: input.seriesStartDateTime } : {}),
    ...(input.reasonText ? { reasonCode: [{ text: input.reasonText }] } : {}),
    note: [{ text: `${input.totalSessions}-session dry-eye treatment series` }],
    ...(input.treatmentDeviceReference
      ? { usedReference: [reference(input.treatmentDeviceReference)] }
      : {}),
    ...(input.parameters ? { extension: dryEyeTreatmentParameterExtensions(input.parameters) } : {}),
  };
}

export function buildDryEyeTreatmentProcedure(
  input: DryEyeTreatmentProcedureInput,
): Procedure {
  const status = input.status ?? "in-progress";
  const extension = dryEyeTreatmentParameterExtensions(input.parameters);
  return {
    resourceType: "Procedure",
    status,
    category: dryEyeTreatmentCategory(),
    code: dryEyeTreatmentTypeConcept(input.treatmentType),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    ...(input.seriesProcedureReference
      ? { partOf: [reference(input.seriesProcedureReference)] }
      : {}),
    ...(input.performedDateTime ? { performedDateTime: input.performedDateTime } : {}),
    ...(input.performedPeriodStart || input.performedPeriodEnd
      ? {
          performedPeriod: {
            ...(input.performedPeriodStart ? { start: input.performedPeriodStart } : {}),
            ...(input.performedPeriodEnd ? { end: input.performedPeriodEnd } : {}),
          },
        }
      : {}),
    ...(input.treatmentDeviceReference
      ? { usedReference: [reference(input.treatmentDeviceReference)] }
      : {}),
    ...(input.reasonText ? { reasonCode: [{ text: input.reasonText }] } : {}),
    ...(input.sessionNumber || input.totalSessions
      ? {
          identifier: [
            {
              system: DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM,
              value: sessionIdentifierValue(input.sessionNumber, input.totalSessions),
            },
          ],
        }
      : {}),
    ...(extension.length ? { extension } : {}),
  };
}

export function buildDryEyeTreatmentSeriesChildren(
  input: DryEyeTreatmentSeriesInput & { seriesProcedureReference: string },
): Procedure[] {
  return Array.from({ length: input.totalSessions }, (_, index) =>
    buildDryEyeTreatmentProcedure({
      patientReference: input.patientReference,
      treatmentType: input.treatmentType,
      status: index === 0 ? "in-progress" : "preparation",
      encounterReference: input.encounterReference,
      seriesProcedureReference: input.seriesProcedureReference,
      performedDateTime: input.childScheduleDateTimes?.[index],
      treatmentDeviceReference: input.treatmentDeviceReference,
      reasonText: input.reasonText,
      sessionNumber: index + 1,
      totalSessions: input.totalSessions,
      parameters: index === 0 ? input.parameters : undefined,
    }),
  );
}

export function procedureStatusForDryEyeUpdate(
  status: DryEyeProcedureStatusUpdate,
): DryEyeProcedureStatusCode {
  return status === "aborted" ? "stopped" : status;
}

export function dryEyeTreatmentParameterExtensions(
  parameters: DryEyeTreatmentParametersInput | undefined,
): Extension[] {
  if (!parameters) {
    return [];
  }
  const extension: Extension[] = [];
  if (parameters.energyMj !== undefined) {
    extension.push({
      url: DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL,
      valueQuantity: {
        value: parameters.energyMj,
        unit: "mJ",
        system: UCUM_CODE_SYSTEM,
        code: "mJ",
      },
    });
  }
  if (parameters.wavelengthNm !== undefined) {
    extension.push({
      url: DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL,
      valueQuantity: {
        value: parameters.wavelengthNm,
        unit: "nm",
        system: UCUM_CODE_SYSTEM,
        code: "nm",
      },
    });
  }
  if (parameters.spotCount !== undefined) {
    extension.push({
      url: DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL,
      valueInteger: parameters.spotCount,
    });
  }
  return extension;
}

function dryEyeTreatmentCategory() {
  return {
    text: "Dry-eye treatment",
  };
}

function sessionIdentifierValue(
  sessionNumber: number | undefined,
  totalSessions: number | undefined,
): string {
  if (sessionNumber && totalSessions) {
    return `${sessionNumber}-of-${totalSessions}`;
  }
  if (sessionNumber) {
    return String(sessionNumber);
  }
  return `planned-${totalSessions}`;
}
