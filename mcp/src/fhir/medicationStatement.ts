import type {
  CodeableConcept,
  Identifier,
  MedicationStatement,
  Reference,
} from "@medplum/fhirtypes";

export const MEDICATION_STATEMENT_STATUS_CODES = [
  "active",
  "completed",
  "entered-in-error",
  "intended",
  "stopped",
  "on-hold",
  "unknown",
  "not-taken",
] as const;

export type MedicationStatementStatusCode =
  (typeof MEDICATION_STATEMENT_STATUS_CODES)[number];

export interface MedicationStatementCodeInput {
  system: string;
  code: string;
  display?: string;
  text?: string;
}

export interface MedicationStatementInput {
  patientReference: string;
  identifiers?: Identifier[];
  medication: MedicationStatementCodeInput | CodeableConcept;
  status?: MedicationStatementStatusCode;
  encounterReference?: string;
  episodeOfCareReference?: string;
  effectiveDateTime?: string;
  effectivePeriodStart?: string;
  effectivePeriodEnd?: string;
  dateAsserted?: string;
  informationSourceReference?: string;
}

export function buildMedicationStatement(
  input: MedicationStatementInput,
): MedicationStatement {
  return {
    resourceType: "MedicationStatement",
    status: input.status ?? "unknown",
    medicationCodeableConcept: medicationConcept(input.medication),
    subject: reference(input.patientReference),
    ...(input.identifiers?.length ? { identifier: input.identifiers } : {}),
    ...(input.encounterReference
      ? { context: reference(input.encounterReference) }
      : input.episodeOfCareReference
        ? { context: reference(input.episodeOfCareReference) }
        : {}),
    ...(input.effectiveDateTime ? { effectiveDateTime: input.effectiveDateTime } : {}),
    ...(!input.effectiveDateTime && (input.effectivePeriodStart || input.effectivePeriodEnd)
      ? {
          effectivePeriod: {
            ...(input.effectivePeriodStart ? { start: input.effectivePeriodStart } : {}),
            ...(input.effectivePeriodEnd ? { end: input.effectivePeriodEnd } : {}),
          },
        }
      : {}),
    ...(input.dateAsserted ? { dateAsserted: input.dateAsserted } : {}),
    ...(input.informationSourceReference
      ? { informationSource: reference(input.informationSourceReference) }
      : {}),
  };
}

function medicationConcept(
  input: MedicationStatementCodeInput | CodeableConcept,
): CodeableConcept {
  if (!("system" in input)) return input;

  return {
    coding: [{
      system: input.system,
      code: input.code,
      ...(input.display ? { display: input.display } : {}),
    }],
    ...(input.text || input.display ? { text: input.text ?? input.display } : {}),
  };
}

function reference(value: string): Reference<never> {
  return { reference: value };
}
