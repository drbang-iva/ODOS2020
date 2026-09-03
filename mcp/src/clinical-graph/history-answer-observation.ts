import type { Observation } from "@medplum/fhirtypes";
import type { HistoryTemplateAnswer } from "./history-template-engine.js";

const BASE = "https://odos2020.com/fhir";
export const HISTORY_ANSWER_CODE_SYSTEM = `${BASE}/CodeSystem/odos-history-template-answer`;
export const HISTORY_ANSWER_CODE = "history-template-answer";
export const HISTORY_ANSWER_IDENTIFIER_SYSTEM = `${BASE}/NamingSystem/history-template-answer-id`;
export const HISTORY_ANSWER_EXTENSION_URL = `${BASE}/StructureDefinition/odos-history-template-answer-json`;

export function buildHistoryAnswerObservation(
  answer: HistoryTemplateAnswer,
  context: { patientReference: string; encounterReference: string; recordedAt: string },
  existing?: Observation,
): Observation {
  const validated = assertHistoryTemplateAnswer(answer);
  const { observationReference: _observationReference, ...persistedAnswer } = validated;
  return {
    resourceType: "Observation",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: HISTORY_ANSWER_IDENTIFIER_SYSTEM, value: persistedAnswer.id }],
    status: "preliminary",
    code: { coding: [{
      system: HISTORY_ANSWER_CODE_SYSTEM,
      code: HISTORY_ANSWER_CODE,
      display: "History template answer",
    }] },
    subject: { reference: context.patientReference },
    encounter: { reference: context.encounterReference },
    effectiveDateTime: context.recordedAt,
    issued: context.recordedAt,
    extension: [{ url: HISTORY_ANSWER_EXTENSION_URL, valueString: JSON.stringify(persistedAnswer) }],
  };
}

export function parseHistoryAnswerObservation(observation: Observation): HistoryTemplateAnswer {
  if (!observation.code.coding?.some((coding) =>
    coding.system === HISTORY_ANSWER_CODE_SYSTEM && coding.code === HISTORY_ANSWER_CODE
  )) throw new Error("Observation is not an ODOS history template answer.");
  const raw = observation.extension?.find((extension) => extension.url === HISTORY_ANSWER_EXTENSION_URL)?.valueString;
  if (!raw) throw new Error("History template answer Observation is missing its JSON extension.");
  const answer = assertHistoryTemplateAnswer(JSON.parse(raw));
  const identifier = observation.identifier?.find((row) => row.system === HISTORY_ANSWER_IDENTIFIER_SYSTEM)?.value;
  if (identifier !== answer.id) throw new Error("History template answer identifier does not match its answer id.");
  return {
    ...answer,
    ...(observation.id ? { observationReference: `Observation/${observation.id}` } : {}),
  };
}

export function isHistoryAnswerObservation(observation: Observation): boolean {
  return observation.code.coding?.some((coding) =>
    coding.system === HISTORY_ANSWER_CODE_SYSTEM && coding.code === HISTORY_ANSWER_CODE
  ) === true;
}

export function assertHistoryTemplateAnswer(value: unknown): HistoryTemplateAnswer {
  if (!isRecord(value)) throw new Error("History template answer must be an object.");
  for (const field of ["id", "complaintId", "templateKey", "sectionId"] as const) {
    if (typeof value[field] !== "string" || !/^[A-Za-z0-9.-]+$/.test(value[field])) {
      throw new Error(`History template answer ${field} is invalid.`);
    }
  }
  if (value.optionCode !== undefined && (typeof value.optionCode !== "string" || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(value.optionCode))) {
    throw new Error("History template answer optionCode is invalid.");
  }
  if (value.eye !== undefined && !["OD", "OS", "OU"].includes(String(value.eye))) {
    throw new Error("History template answer eye is invalid.");
  }
  if (value.observationReference !== undefined && (typeof value.observationReference !== "string" || !/^Observation\/[A-Za-z0-9.-]+$/.test(value.observationReference))) {
    throw new Error("History template answer observationReference is invalid.");
  }
  if (!isRecord(value.value) || typeof value.value.kind !== "string") throw new Error("History template answer value is invalid.");
  validateValue(value.value);
  return value as unknown as HistoryTemplateAnswer;
}

function validateValue(value: Record<string, unknown>): void {
  if (value.kind === "tri-state" && ["positive", "negative"].includes(String(value.status))) return;
  if (value.kind === "selection" && validCode(value.code)) return;
  if (value.kind === "severity" && ["mild", "moderate", "severe"].includes(String(value.level))) return;
  if (value.kind === "duration" && typeof value.value === "number" && Number.isFinite(value.value) && value.value > 0 && ["days", "weeks", "months", "years"].includes(String(value.unit))) return;
  if (value.kind === "numeric" && typeof value.value === "number" && Number.isFinite(value.value) && (value.unit === undefined || typeof value.unit === "string")) return;
  if (value.kind === "interval" && ["better", "same", "worse"].includes(String(value.code)) && optionalText(value.note)) return;
  if (value.kind === "laterality" && ["OD-worse", "OS-worse", "equal", "other"].includes(String(value.code)) && optionalText(value.note)) return;
  if (value.kind === "text" && typeof value.text === "string") return;
  throw new Error("History template answer value is invalid.");
}

function validCode(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function optionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
