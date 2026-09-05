import type { Observation } from "@medplum/fhirtypes";
import { HISTORY_SUBJECT_SECTIONS, historySubjectSectionState, renderDeclaredSubjectSummary } from "./history-template-engine.js";
import { deriveHistoryLastReviewed, isHistoryAnswerObservation, parseHistoryAnswerObservation, parseHistoryItemReview,
  historyRetractedTargets, historyReviewTargetKey, HISTORY_ITEM_REVIEW_CODE, HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM } from "./history-answer-observation.js";

export function projectHistorySubjectSections(
  observations: Observation[], patientReference: string, encounterReference: string, encounterStart?: string,
) {
  const current = observations.filter(o => o.subject?.reference === patientReference && o.encounter?.reference === encounterReference &&
    o.status !== "entered-in-error" && o.status !== "cancelled");
  const answerObservations = current.filter(isHistoryAnswerObservation);
  const answers = answerObservations.map(parseHistoryAnswerObservation);
  const lastReviewed = deriveHistoryLastReviewed(answerObservations, current, patientReference);
  const retracted = historyRetractedTargets(current, patientReference);
  return HISTORY_SUBJECT_SECTIONS.map(declaration => {
    const sectionAnswers = answers.filter(a => a.templateKey === declaration.key && a.subjectScope === declaration.subjectScope);
    const methods = current.flatMap(row => {
      if (!row.code.coding?.some(c => c.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && c.code === HISTORY_ITEM_REVIEW_CODE) ||
        !(Date.parse(row.effectiveDateTime ?? "") >= Date.parse(encounterStart ?? "0001-01-01T00:00:00Z"))) return [];
      const act = parseHistoryItemReview(row);
      return act.targets.some(t => t.sectionKey === declaration.key && !retracted.get(`Observation/${row.id}`)?.has(historyReviewTargetKey(t))) ? [act.method] : [];
    });
    // If a legacy encounter has no start, only its own entries are eligible; no prior acts are included.
    const context = { encounterStart: encounterStart ?? "0001-01-01T00:00:00Z", lastReviewed, methods };
    return { sectionKey: declaration.key, state: historySubjectSectionState(declaration, sectionAnswers, context),
      summary: renderDeclaredSubjectSummary(declaration, sectionAnswers, context) };
  });
}
