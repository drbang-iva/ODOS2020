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

test("a patient-scoped answer persists its scope distinctly from complaint answers", () => {
  const answer = {
    id: "ocular-e1-conditions-glaucoma-OD",
    subjectScope: "patient",
    templateKey: "ocular-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
    eye: "OD",
    value: { kind: "tri-state", status: "positive", note: "Diagnosed in 2024" },
  } as const;
  const observation = buildHistoryAnswerObservation(answer, {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    recordedAt: "2026-09-03T15:00:00.000Z",
  });

  assert.deepEqual(JSON.parse(observation.extension?.[0]?.valueString ?? "null"), answer);
  assert.deepEqual(parseHistoryAnswerObservation({ ...observation, id: "obs-ocular-1" }), {
    ...answer,
    observationReference: "Observation/obs-ocular-1",
  });
  assert.throws(() => buildHistoryAnswerObservation({ ...answer, complaintId: "complaint-1" }, {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    recordedAt: "2026-09-03T15:00:00.000Z",
  }), /exactly one subject/i);
});

test("a family relations answer persists and parses back with denied and unasked relatives distinct", () => {
  const answer = {
    id: "family-e1-conditions-glaucoma",
    subjectScope: "patient",
    templateKey: "family-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
    value: {
      kind: "relations",
      positive: ["father", "brother"],
      negative: ["mother"],
      note: "Maternal history denied",
    },
  } as const;
  const observation = buildHistoryAnswerObservation(answer, {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    recordedAt: "2026-09-05T15:00:00.000Z",
  });

  assert.deepEqual(parseHistoryAnswerObservation({ ...observation, id: "obs-family-1" }), {
    ...answer,
    observationReference: "Observation/obs-family-1",
  });
  assert.deepEqual(answer.value.negative, ["mother"], "an unlisted relative remains unasked");
});

test("family relations shape requires two string arrays without overlap and an optional string note", () => {
  const base = {
    id: "family-e1-conditions-glaucoma",
    subjectScope: "patient",
    templateKey: "family-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
  };
  for (const value of [
    { kind: "relations", negative: [] },
    { kind: "relations", positive: [], negative: "mother" },
    { kind: "relations", positive: [7], negative: [] },
    { kind: "relations", positive: ["father"], negative: ["father"] },
    { kind: "relations", positive: [], negative: [], note: 7 },
  ]) {
    assert.throws(() => buildHistoryAnswerObservation({ ...base, value } as never, {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      recordedAt: "2026-09-05T15:00:00.000Z",
    }), /value is invalid/i);
  }
});
