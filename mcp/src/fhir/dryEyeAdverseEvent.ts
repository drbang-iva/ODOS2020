import type { AdverseEvent, CodeableConcept } from "@medplum/fhirtypes";
import { reference } from "./ophthalmology/extensions.js";

export const DRY_EYE_ADVERSE_EVENT_ACTUALITY_CODES = ["actual", "potential"] as const;
export type DryEyeAdverseEventActuality =
  (typeof DRY_EYE_ADVERSE_EVENT_ACTUALITY_CODES)[number];

export interface DryEyeAdverseEventCodeInput {
  system?: string;
  code?: string;
  display?: string;
  text: string;
}

export interface DryEyeAdverseEventInput {
  patientReference: string;
  event: DryEyeAdverseEventCodeInput;
  actuality?: DryEyeAdverseEventActuality;
  encounterReference?: string;
  date?: string;
  detected?: string;
  recordedDate?: string;
  seriousnessText?: string;
  severityText?: string;
  outcomeText?: string;
  recorderReference?: string;
  suspectEntityReferences?: string[];
  referenceDocumentReferences?: string[];
  resultingConditionReferences?: string[];
}

export function buildDryEyeAdverseEvent(
  input: DryEyeAdverseEventInput,
): AdverseEvent {
  const recordedDate = input.recordedDate ?? new Date().toISOString();
  return {
    resourceType: "AdverseEvent",
    actuality: input.actuality ?? "actual",
    category: [{ text: "Dry-eye adverse event" }],
    event: codeableConcept(input.event),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.detected ? { detected: input.detected } : {}),
    recordedDate,
    ...(input.resultingConditionReferences?.length
      ? { resultingCondition: input.resultingConditionReferences.map((item) => reference(item)) }
      : {}),
    ...(input.seriousnessText ? { seriousness: { text: input.seriousnessText } } : {}),
    ...(input.severityText ? { severity: { text: input.severityText } } : {}),
    ...(input.outcomeText ? { outcome: { text: input.outcomeText } } : {}),
    ...(input.recorderReference ? { recorder: reference(input.recorderReference) } : {}),
    ...(input.suspectEntityReferences?.length
      ? {
          suspectEntity: input.suspectEntityReferences.map((item) => ({
            instance: reference(item),
          })),
        }
      : {}),
    ...(input.referenceDocumentReferences?.length
      ? { referenceDocument: input.referenceDocumentReferences.map((item) => reference(item)) }
      : {}),
  };
}

function codeableConcept(input: DryEyeAdverseEventCodeInput): CodeableConcept {
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
