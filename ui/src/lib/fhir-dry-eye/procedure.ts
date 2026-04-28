import type { Extension, Procedure } from "@medplum/fhirtypes";
import { reference } from "./common.js";
import {
  DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL,
  DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL,
  DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL,
  UCUM_CODE_SYSTEM,
  dryEyeTreatmentTypeConcept,
  type DryEyeTreatmentTypeCode,
} from "./terminology.js";

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
export type DryEyeProcedureStatusCode = (typeof DRY_EYE_PROCEDURE_STATUS_CODES)[number];

export function buildDryEyeTreatmentSeriesProcedure(input: {
  patientReference: string;
  treatmentType: DryEyeTreatmentTypeCode;
  encounterReference?: string;
  seriesStartDateTime?: string;
  totalSessions: number;
  treatmentDeviceReference?: string;
  reasonText?: string;
  parameters?: DryEyeTreatmentParametersInput;
}): Procedure {
  return {
    resourceType: "Procedure",
    status: "in-progress",
    category: { text: "Dry-eye treatment" },
    code: dryEyeTreatmentTypeConcept(input.treatmentType),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    ...(input.seriesStartDateTime ? { performedDateTime: input.seriesStartDateTime } : {}),
    ...(input.reasonText ? { reasonCode: [{ text: input.reasonText }] } : {}),
    note: [{ text: `${input.totalSessions}-session dry-eye treatment series` }],
    ...(input.treatmentDeviceReference ? { usedReference: [reference(input.treatmentDeviceReference)] } : {}),
    ...(input.parameters ? { extension: dryEyeTreatmentParameterExtensions(input.parameters) } : {}),
  };
}

export interface DryEyeTreatmentParametersInput {
  energyMj?: number;
  wavelengthNm?: number;
  spotCount?: number;
}

export function buildDryEyeTreatmentProcedure(input: {
  patientReference: string;
  treatmentType: DryEyeTreatmentTypeCode;
  status?: DryEyeProcedureStatusCode;
  encounterReference?: string;
  seriesProcedureReference?: string;
  performedDateTime?: string;
  treatmentDeviceReference?: string;
  reasonText?: string;
  sessionNumber?: number;
  totalSessions?: number;
  parameters?: DryEyeTreatmentParametersInput;
}): Procedure {
  return {
    resourceType: "Procedure",
    status: input.status ?? "in-progress",
    category: { text: "Dry-eye treatment" },
    code: dryEyeTreatmentTypeConcept(input.treatmentType),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    ...(input.seriesProcedureReference ? { partOf: [reference(input.seriesProcedureReference)] } : {}),
    ...(input.performedDateTime ? { performedDateTime: input.performedDateTime } : {}),
    ...(input.treatmentDeviceReference ? { usedReference: [reference(input.treatmentDeviceReference)] } : {}),
    ...(input.reasonText ? { reasonCode: [{ text: input.reasonText }] } : {}),
    ...(input.sessionNumber || input.totalSessions
      ? {
          identifier: [
            {
              system: "https://osod.dev/fhir/Identifier/dry-eye-treatment-session",
              value: input.sessionNumber && input.totalSessions
                ? `${input.sessionNumber}-of-${input.totalSessions}`
                : String(input.sessionNumber ?? input.totalSessions),
            },
          ],
        }
      : {}),
    ...(input.parameters ? { extension: dryEyeTreatmentParameterExtensions(input.parameters) } : {}),
  };
}

export function dryEyeTreatmentParameterExtensions(
  parameters: DryEyeTreatmentParametersInput,
): Extension[] {
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
