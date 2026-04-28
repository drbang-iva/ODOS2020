import type { AdverseEvent, CodeableConcept } from "@medplum/fhirtypes";
import { reference } from "./common.js";

export function buildDryEyeAdverseEvent(input: {
  patientReference: string;
  event: { system?: string; code?: string; display?: string; text: string };
  actuality?: AdverseEvent["actuality"];
  encounterReference?: string;
  date?: string;
  detected?: string;
  recordedDate?: string;
  seriousnessText?: string;
  severityText?: string;
  outcomeText?: string;
  suspectEntityReferences?: string[];
}): AdverseEvent {
  return {
    resourceType: "AdverseEvent",
    actuality: input.actuality ?? "actual",
    category: [{ text: "Dry-eye adverse event" }],
    event: codeableConcept(input.event),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.detected ? { detected: input.detected } : {}),
    recordedDate: input.recordedDate ?? new Date().toISOString(),
    ...(input.seriousnessText ? { seriousness: { text: input.seriousnessText } } : {}),
    ...(input.severityText ? { severity: { text: input.severityText } } : {}),
    ...(input.outcomeText ? { outcome: { text: input.outcomeText } } : {}),
    ...(input.suspectEntityReferences?.length
      ? {
          suspectEntity: input.suspectEntityReferences.map((item) => ({
            instance: reference(item),
          })),
        }
      : {}),
  };
}

function codeableConcept(input: { system?: string; code?: string; display?: string; text: string }): CodeableConcept {
  return {
    ...(input.system && input.code
      ? { coding: [{ system: input.system, code: input.code, display: input.display ?? input.text }] }
      : {}),
    text: input.text,
  };
}
