import { z } from "zod";
import type { Observation } from "@medplum/fhirtypes";
import { historyReviewTargetKey, type HistoryTemplateAnswer } from "./history-template-engine.js";

const BASE = "https://odos2020.com/fhir";
export const HISTORY_ANSWER_SCOPE_SYSTEM = `${BASE}/CodeSystem/history-answer-scope`;
export const HISTORY_ANSWER_CODE_SYSTEM = `${BASE}/CodeSystem/odos-history-template-answer`;
export const HISTORY_ANSWER_CODE = "history-template-answer";
export const HISTORY_ANSWER_IDENTIFIER_SYSTEM = `${BASE}/NamingSystem/history-template-answer-id`;
export const HISTORY_ANSWER_EXTENSION_URL = `${BASE}/StructureDefinition/odos-history-template-answer-json`;
export const HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM = `${BASE}/CodeSystem/odos-history-review`;
export const HISTORY_REVIEW_ATTESTATION_CODE = "history-review-attestation";
export const HISTORY_REVIEW_ATTESTATION_IDENTIFIER_SYSTEM = `${BASE}/NamingSystem/history-review-attestation`;
export const HISTORY_REVIEW_SECTION_EXTENSION_URL = `${BASE}/StructureDefinition/odos-history-review-section`;
const HISTORY_REVIEW_ACTION_SYSTEM = `${BASE}/CodeSystem/odos-history-review-action`;

export const HISTORY_ITEM_REVIEW_CODE = "history-item-review";
export const HISTORY_ITEM_RETRACTION_CODE = "history-item-review-retraction";
export const HISTORY_ITEMS_RETRACTED_ACTION = "items-review-retracted";
export const HISTORY_ITEMS_REVIEWED_ACTION = "items-reviewed";
export const HISTORY_REVIEW_METHOD_EXTENSION_URL = `${BASE}/StructureDefinition/odos-history-review-method`;
export const HISTORY_REVIEW_TARGET_EXTENSION_URL = `${BASE}/StructureDefinition/odos-history-review-target`;
export const historyReviewTargetSchema = z.object({
  sectionKey: z.string().regex(/^[a-z][a-z0-9-]{0,119}$/),
  sectionId: z.string().regex(/^[a-z][a-z0-9-]{0,119}$/),
  optionCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/).optional(),
  eye: z.enum(["OD", "OS", "OU"]).optional(),
}).strict();
export type ReviewTarget = z.infer<typeof historyReviewTargetSchema>;
export interface HistoryItemReview {
  sectionKey: string;
  gestureId: string;
  method: "individual" | "bulk";
  targets: ReviewTarget[];
  patientReference: string;
  encounterReference: string;
  actorReference: string;
  recordedAt: string;
}

export { historyReviewTargetKey } from "./history-template-engine.js";

export function buildHistoryItemReview(input: HistoryItemReview): Observation {
  return {
    resourceType: "Observation",
    identifier: [{ system: HISTORY_REVIEW_ATTESTATION_IDENTIFIER_SYSTEM,
      value: `${input.encounterReference.slice("Encounter/".length)}:${input.sectionKey}:${input.gestureId}` }],
    status: "preliminary",
    code: { coding: [{ system: HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM, code: HISTORY_ITEM_REVIEW_CODE, display: "History item review" }] },
    subject: { reference: input.patientReference },
    encounter: { reference: input.encounterReference },
    effectiveDateTime: input.recordedAt,
    issued: input.recordedAt,
    performer: [{ reference: input.actorReference }],
    valueCodeableConcept: { coding: [{ system: HISTORY_REVIEW_ACTION_SYSTEM, code: HISTORY_ITEMS_REVIEWED_ACTION, display: "Items reviewed" }] },
    extension: [
      { url: HISTORY_REVIEW_SECTION_EXTENSION_URL, valueCode: input.sectionKey },
      { url: HISTORY_REVIEW_METHOD_EXTENSION_URL, valueCode: input.method },
      ...input.targets.map(target => ({ url: HISTORY_REVIEW_TARGET_EXTENSION_URL, valueString: JSON.stringify(target) })),
    ],
  };
}

export function parseHistoryItemReview(observation: Observation): Pick<HistoryItemReview, "method" | "targets"> {
  if (!observation.code.coding?.some(c => c.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && c.code === HISTORY_ITEM_REVIEW_CODE) ||
    !observation.valueCodeableConcept?.coding?.some(c => c.system === HISTORY_REVIEW_ACTION_SYSTEM && c.code === HISTORY_ITEMS_REVIEWED_ACTION)) {
    throw new Error("Observation is not an ODOS history item review.");
  }
  const methods = observation.extension?.filter(e => e.url === HISTORY_REVIEW_METHOD_EXTENSION_URL) ?? [];
  const method = methods[0]?.valueCode;
  if (methods.length !== 1 || (method !== "individual" && method !== "bulk")) throw new Error("History item review method is invalid.");
  const targets = (observation.extension ?? []).filter(e => e.url === HISTORY_REVIEW_TARGET_EXTENSION_URL)
    .map(e => historyReviewTargetSchema.parse(JSON.parse(e.valueString ?? "null")));
  if (!targets.length) throw new Error("History item review has no targets.");
  return { method, targets };
}

export type HistoryItemRetraction = Omit<HistoryItemReview, "method"> & { retracts: string };

export function buildHistoryItemRetraction(input: HistoryItemRetraction): Observation {
  const act = buildHistoryItemReview({ ...input, method: "individual" });
  return {
    ...act,
    code: { coding: [{ system: HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM, code: HISTORY_ITEM_RETRACTION_CODE, display: "History item review retraction" }] },
    valueCodeableConcept: { coding: [{ system: HISTORY_REVIEW_ACTION_SYSTEM, code: HISTORY_ITEMS_RETRACTED_ACTION, display: "Items review retracted" }] },
    extension: act.extension!.filter(e => e.url !== HISTORY_REVIEW_METHOD_EXTENSION_URL),
    derivedFrom: [{ reference: input.retracts }],
  };
}

export function parseHistoryItemRetraction(observation: Observation): Pick<HistoryItemRetraction, "targets" | "retracts"> {
  if (!observation.code.coding?.some(c => c.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && c.code === HISTORY_ITEM_RETRACTION_CODE) ||
    !observation.valueCodeableConcept?.coding?.some(c => c.system === HISTORY_REVIEW_ACTION_SYSTEM && c.code === HISTORY_ITEMS_RETRACTED_ACTION)) {
    throw new Error("Observation is not an ODOS history item review retraction.");
  }
  const targets = (observation.extension ?? []).filter(e => e.url === HISTORY_REVIEW_TARGET_EXTENSION_URL)
    .map(e => historyReviewTargetSchema.parse(JSON.parse(e.valueString ?? "null")));
  const retracts = observation.derivedFrom?.[0]?.reference;
  if (targets.length !== 1 || observation.derivedFrom?.length !== 1 || !retracts?.match(/^Observation\/[A-Za-z0-9.-]+$/)) {
    throw new Error("History retraction requires one target and one original act.");
  }
  return { targets, retracts };
}

export function historyRetractedTargets(acts: Observation[], patientReference: string): Map<string, Set<string>> {
  const live = (row: Observation) => row.subject?.reference === patientReference && row.status !== "entered-in-error" && row.status !== "cancelled";
  const actsByReference = new Map(acts.map(row => [`Observation/${row.id}`, row]));
  const retracted = new Map<string, Set<string>>();
  for (const observation of acts) {
    if (!live(observation) || !observation.code.coding?.some(c => c.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && c.code === HISTORY_ITEM_RETRACTION_CODE)) continue;
    const { targets, retracts } = parseHistoryItemRetraction(observation);
    const original = actsByReference.get(retracts);
    if (!original || !live(original) || original.encounter?.reference !== observation.encounter?.reference) continue;
    const keys = retracted.get(retracts) ?? new Set<string>();
    keys.add(historyReviewTargetKey(targets[0]));
    retracted.set(retracts, keys);
  }
  return retracted;
}

export function deriveHistoryLastReviewed(
  answers: Observation[],
  acts: Observation[],
  patientReference: string,
): Array<{ target: ReviewTarget; lastReviewed: string }> {
  const latest = new Map<string, { target: ReviewTarget; lastReviewed: string }>();
  const answerTargets = new Map<string, ReviewTarget>();
  const live = (row: Observation) => row.subject?.reference === patientReference && row.status !== "entered-in-error" && row.status !== "cancelled";
  const record = (target: ReviewTarget, date: string | undefined) => {
    if (!date || !Number.isFinite(Date.parse(date))) return;
    const key = historyReviewTargetKey(target), existing = latest.get(key);
    if (!existing || Date.parse(date) > Date.parse(existing.lastReviewed)) latest.set(key, { target, lastReviewed: date });
  };
  for (const observation of answers) {
    if (!live(observation) || !isHistoryAnswerObservation(observation)) continue;
    const answer = parseHistoryAnswerObservation(observation);
    if (!answer.subjectScope) continue;
    const target: ReviewTarget = { sectionKey: answer.templateKey, sectionId: answer.sectionId,
      ...(answer.optionCode ? { optionCode: answer.optionCode } : {}), ...(answer.eye ? { eye: answer.eye } : {}) };
    if (observation.id) answerTargets.set(`Observation/${observation.id}`, target);
    record(target, observation.effectiveDateTime);
  }
  const retracted = historyRetractedTargets(acts, patientReference);
  for (const observation of acts) {
    if (!live(observation)) continue;
    if (observation.code.coding?.some(c => c.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && c.code === HISTORY_ITEM_REVIEW_CODE)) {
      for (const target of parseHistoryItemReview(observation).targets) {
        if (!retracted.get(`Observation/${observation.id}`)?.has(historyReviewTargetKey(target))) record(target, observation.effectiveDateTime);
      }
    } else if (observation.code.coding?.some(c => c.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && c.code === HISTORY_REVIEW_ATTESTATION_CODE) &&
      observation.valueCodeableConcept?.coding?.some(c => c.system === HISTORY_REVIEW_ACTION_SYSTEM && c.code === "reviewed-no-change")) {
      for (const reference of observation.derivedFrom ?? []) {
        const target = answerTargets.get(reference.reference ?? "");
        if (target) record(target, observation.effectiveDateTime);
      }
    }
  }
  return [...latest.values()];
}

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
    category: [
      ...(existing?.category ?? []).flatMap((category) => {
        const coding = category.coding?.filter((coding) => coding.system !== HISTORY_ANSWER_SCOPE_SYSTEM);
        return category.text || coding?.length ? [{ ...category, coding }] : [];
      }),
      { coding: [{ system: HISTORY_ANSWER_SCOPE_SYSTEM, code: persistedAnswer.subjectScope ?? "complaint" }] },
    ],
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

export function buildHistoryReviewAttestation(
  input: {
    patientReference: string;
    encounterReference: string;
    sectionKey: string;
    actorReference: string;
    recordedAt: string;
    priorAnswerReferences: string[];
  },
  existing?: Observation,
): Observation {
  return {
    resourceType: "Observation",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{
      system: HISTORY_REVIEW_ATTESTATION_IDENTIFIER_SYSTEM,
      value: `${input.encounterReference.slice("Encounter/".length)}:${input.sectionKey}`,
    }],
    status: "preliminary",
    code: { coding: [{
      system: HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM,
      code: HISTORY_REVIEW_ATTESTATION_CODE,
      display: "History review attestation",
    }] },
    subject: { reference: input.patientReference },
    encounter: { reference: input.encounterReference },
    effectiveDateTime: input.recordedAt,
    issued: input.recordedAt,
    performer: [{ reference: input.actorReference }],
    valueCodeableConcept: { coding: [{
      system: HISTORY_REVIEW_ACTION_SYSTEM,
      code: "reviewed-no-change",
      display: "Reviewed today, no change",
    }] },
    extension: [{ url: HISTORY_REVIEW_SECTION_EXTENSION_URL, valueCode: input.sectionKey }],
    derivedFrom: input.priorAnswerReferences.map((reference) => ({ reference })),
  };
}

export function assertHistoryTemplateAnswer(value: unknown): HistoryTemplateAnswer {
  if (!isRecord(value)) throw new Error("History template answer must be an object.");
  const complaintScoped = typeof value.complaintId === "string" && /^[A-Za-z0-9.-]+$/.test(value.complaintId);
  const subjectScoped = value.subjectScope === "encounter" || value.subjectScope === "patient";
  if (Number(complaintScoped) + Number(subjectScoped) !== 1 || (subjectScoped && value.complaintId !== undefined)) {
    throw new Error("History template answer must bind to exactly one subject.");
  }
  for (const field of ["id", "templateKey", "sectionId"] as const) {
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
  if (value.kind === "tri-state" && ["positive", "negative"].includes(String(value.status)) && optionalText(value.note) &&
    (value.status === "positive" || value.note === undefined)) return;
  if (value.kind === "relations" && validRelationsValue(value)) return;
  if (value.kind === "selection" && validCode(value.code)) return;
  if (value.kind === "severity" && ["mild", "moderate", "severe"].includes(String(value.level))) return;
  if (value.kind === "duration" && typeof value.value === "number" && Number.isFinite(value.value) && value.value > 0 && ["days", "weeks", "months", "years"].includes(String(value.unit))) return;
  if (value.kind === "numeric" && typeof value.value === "number" && Number.isFinite(value.value) && (value.unit === undefined || typeof value.unit === "string")) return;
  if (value.kind === "interval" && ["better", "same", "worse"].includes(String(value.code)) && optionalText(value.note)) return;
  if (value.kind === "laterality" && ["OD-worse", "OS-worse", "equal", "other"].includes(String(value.code)) && optionalText(value.note)) return;
  if (value.kind === "text" && typeof value.text === "string") return;
  throw new Error("History template answer value is invalid.");
}

function validRelationsValue(value: Record<string, unknown>): boolean {
  const positive = value.positive;
  const negative = value.negative;
  if (!stringArray(positive) || !stringArray(negative)) return false;
  return optionalText(value.note) &&
    new Set(positive).size === positive.length &&
    new Set(negative).size === negative.length &&
    !positive.some((relation) => negative.includes(relation));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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
