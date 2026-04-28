import type { CodeableConcept, MedicationStatement } from "@medplum/fhirtypes";
import { DRY_EYE_TREATMENT_TYPE_CODE_SYSTEM } from "./contactLens.js";
import { OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL } from "./dryEyeTerminology.js";
import { reference } from "./ophthalmology/extensions.js";

export const OPHTHALMIC_MEDICATION_STATUS_CODES = [
  "active",
  "completed",
  "entered-in-error",
  "intended",
  "stopped",
  "on-hold",
  "unknown",
  "not-taken",
] as const;
export type OphthalmicMedicationStatusCode =
  (typeof OPHTHALMIC_MEDICATION_STATUS_CODES)[number];

export const DRY_EYE_MEDICATION_TIMELINE_STATUS_CODES = [
  "active",
  "resolved",
  "resumed",
] as const;
export type DryEyeMedicationTimelineStatus =
  (typeof DRY_EYE_MEDICATION_TIMELINE_STATUS_CODES)[number];

export const OPHTHALMIC_SUPPLY_TYPE_CODES = ["otc", "rx", "supplement"] as const;
export type OphthalmicSupplyTypeCode = (typeof OPHTHALMIC_SUPPLY_TYPE_CODES)[number];

export interface OphthalmicMedicationCodeInput {
  system?: string;
  code?: string;
  display?: string;
  text: string;
}

export interface OphthalmicMedicationStatementInput {
  patientReference: string;
  medication: OphthalmicMedicationCodeInput;
  status?: OphthalmicMedicationStatusCode;
  encounterReference?: string;
  episodeOfCareReference?: string;
  effectiveDateTime?: string;
  effectivePeriodStart?: string;
  effectivePeriodEnd?: string;
  dateAsserted?: string;
  informationSourceReference?: string;
  supplyType?: OphthalmicSupplyTypeCode;
  indicationText?: string;
  dosageText?: string;
  reasonReference?: string;
}

export function buildOphthalmicMedicationStatement(
  input: OphthalmicMedicationStatementInput,
): MedicationStatement {
  const dateAsserted = input.dateAsserted ?? new Date().toISOString();
  return {
    resourceType: "MedicationStatement",
    status: input.status ?? "active",
    medicationCodeableConcept: medicationConcept(input.medication),
    subject: reference(input.patientReference),
    ...(input.encounterReference
      ? { context: reference(input.encounterReference) }
      : input.episodeOfCareReference
        ? { context: reference(input.episodeOfCareReference) }
        : {}),
    ...(input.effectiveDateTime ? { effectiveDateTime: input.effectiveDateTime } : {}),
    ...(input.effectivePeriodStart || input.effectivePeriodEnd
      ? {
          effectivePeriod: {
            ...(input.effectivePeriodStart ? { start: input.effectivePeriodStart } : {}),
            ...(input.effectivePeriodEnd ? { end: input.effectivePeriodEnd } : {}),
          },
        }
      : {}),
    dateAsserted,
    ...(input.informationSourceReference
      ? { informationSource: reference(input.informationSourceReference) }
      : {}),
    reasonCode: [
      {
        coding: [
          {
            system: DRY_EYE_TREATMENT_TYPE_CODE_SYSTEM,
            code: treatmentCodeForSupplyType(input.supplyType),
            display: input.indicationText ?? "Dry eye",
          },
        ],
        text: input.indicationText ?? "Dry eye",
      },
    ],
    ...(input.reasonReference ? { reasonReference: [reference(input.reasonReference)] } : {}),
    dosage: [
      {
        ...(input.dosageText ? { text: input.dosageText } : {}),
        route: { text: "Ophthalmic route" },
      },
    ],
    ...(input.supplyType
      ? {
          extension: [
            {
              url: OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL,
              valueCode: input.supplyType,
            },
          ],
        }
      : {}),
  };
}

export function medicationStatementStatusForTimeline(
  status: DryEyeMedicationTimelineStatus,
): OphthalmicMedicationStatusCode {
  switch (status) {
    case "active":
    case "resumed":
      return "active";
    case "resolved":
      return "completed";
  }
}

function medicationConcept(input: OphthalmicMedicationCodeInput): CodeableConcept {
  return {
    ...(input.system && input.code
      ? {
          coding: [
            {
              system: input.system,
              code: input.code,
              display: input.display ?? input.text,
            },
          ],
        }
      : {}),
    text: input.text,
  };
}

function treatmentCodeForSupplyType(
  supplyType: OphthalmicSupplyTypeCode | undefined,
): string {
  if (supplyType === "supplement") {
    return "omega-3";
  }
  if (supplyType === "otc") {
    return "artificial-tears";
  }
  return "prescription-anti-inflammatory";
}
