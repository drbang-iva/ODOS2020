import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_ANSWER_CODE,
  HISTORY_ANSWER_IDENTIFIER_SYSTEM,
  buildHistoryAnswerObservation,
  parseHistoryAnswerObservation,
} from "../src/clinical-graph/history-answer-observation.js";

const BASE = {
  id: "answer-family-history",
  complaintId: "complaint-1",
  templateKey: "glaucoma",
  sectionId: "risk-factors",
  optionCode: "family-history-of-glaucoma",
  value: { kind: "tri-state" as const, status: "negative" as const },
};

test("a denied template answer persists as a preliminary Observation and round-trips distinctly", () => {
  const observation = buildHistoryAnswerObservation(BASE, {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    recordedAt: "2026-09-03T14:00:00.000Z",
  });

  assert.equal(observation.status, "preliminary");
  assert.equal(observation.code.coding?.[0]?.code, HISTORY_ANSWER_CODE);
  assert.deepEqual(observation.identifier, [{ system: HISTORY_ANSWER_IDENTIFIER_SYSTEM, value: BASE.id }]);
  assert.deepEqual(parseHistoryAnswerObservation({ ...observation, id: "obs-answer-1" }), {
    ...BASE,
    observationReference: "Observation/obs-answer-1",
  });
});

test("an unasked catalog value has no persisted answer Observation", () => {
  const negative = parseHistoryAnswerObservation({
    ...buildHistoryAnswerObservation(BASE, {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      recordedAt: "2026-09-03T14:00:00.000Z",
    }),
    id: "obs-answer-1",
  });
  assert.equal(negative.value.kind === "tri-state" ? negative.value.status : undefined, "negative");
  assert.equal([negative].find((answer) => answer.optionCode === "steroid-nasal-sprays"), undefined);
});
