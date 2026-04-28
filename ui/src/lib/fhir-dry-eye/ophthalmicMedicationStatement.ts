import type { CodeableConcept, MedicationStatement } from "@medplum/fhirtypes";
import { reference } from "./common.js";
import {
  DRY_EYE_TREATMENT_TYPE_CODE_SYSTEM,
  OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL,
} from "./terminology.js";

export const OPHTHALMIC_SUPPLY_TYPE_CODES = ["otc", "rx", "supplement"] as const;
export type OphthalmicSupplyTypeCode = (typeof OPHTHALMIC_SUPPLY_TYPE_CODES)[number];

export function buildOphthalmicMedicationStatement(input: {
  patientReference: string;
  medication: { system?: string; code?: string; display?: string; text: string };
  status?: MedicationStatement["status"];
  encounterReference?: string;
  episodeOfCareReference?: string;
  effectiveDateTime?: string;
  dateAsserted?: string;
  supplyType?: OphthalmicSupplyTypeCode;
  indicationText?: string;
  dosageText?: string;
}): MedicationStatement {
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
    dateAsserted: input.dateAsserted ?? new Date().toISOString(),
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

function medicationConcept(input: { system?: string; code?: string; display?: string; text: string }): CodeableConcept {
  return {
    ...(input.system && input.code
      ? { coding: [{ system: input.system, code: input.code, display: input.display ?? input.text }] }
      : {}),
    text: input.text,
  };
}

function treatmentCodeForSupplyType(supplyType: OphthalmicSupplyTypeCode | undefined): string {
  if (supplyType === "supplement") return "omega-3";
  if (supplyType === "otc") return "artificial-tears";
  return "prescription-anti-inflammatory";
}
