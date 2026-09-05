import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Observation } from "@medplum/fhirtypes";
import { historyRosFixture } from "./helpers/historyRosFixture.js";
import { buildHistoryAnswerObservation, buildHistoryItemReview } from "../src/clinical-graph/history-answer-observation.js";
import { handleHpiRecordRequest, handleHistoryItemReviewRequest, handleHpiCaptureRequest } from "../src/clinical-graph/hpi-endpoint.js";
import { HISTORY_SUBJECT_SECTIONS, HISTORY_OPTION_CATALOGS, historySubjectSectionState, type HistoryTemplateAnswer } from "../src/clinical-graph/history-template-engine.js";
import { projectHistorySubjectSections } from "../src/clinical-graph/history-subject-projection.js";

const patientReference = "Patient/ros-test", encounterReference = "Encounter/current";
const now = "2026-09-05T12:00:00Z";
const target = { sectionKey: "social-history", sectionId: "tobacco" };
const tobacco: HistoryTemplateAnswer = { id: "tobacco", subjectScope: "patient", templateKey: "social-history", sectionId: "tobacco", value: { kind: "selection", code: "never" } };
function answer(date: string, overrides: Partial<Observation> = {}) {
  return { ...buildHistoryAnswerObservation(tobacco, { patientReference, encounterReference: "Encounter/prior", recordedAt: date }), id: randomUUID(), ...overrides };
}
async function record(s: ReturnType<typeof historyRosFixture>) {
  const response = await handleHpiRecordRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
  assert.equal(response.status, 200);
  return response.body as any;
}
const reminders = (r: any) => r.subjectSectionNudges.filter((n: any) => n.target.sectionKey === "social-history");

test("ROS composed note never exposes review method for any coverage or encounter age", () => {
  for (const start of [now, undefined]) for (const method of ["individual", "bulk"] as const) {
    const act = { ...buildHistoryItemReview({ patientReference, encounterReference, sectionKey: "review-of-systems", method, gestureId: randomUUID(), targets: [{ sectionKey: "review-of-systems", sectionId: "systems", optionCode: "headache" }], actorReference: "Practitioner/test", recordedAt: now }), id: randomUUID() };
    const summary = projectHistorySubjectSections([act], patientReference, encounterReference, start).find(s => s.sectionKey === "review-of-systems")!.summary;
    assert.doesNotMatch(summary, /Review method:|\bbulk\b|\bindividual\b/);
  }
});
test("bulk and individual acts produce byte-identical composed summaries", () => {
  for (const size of [1, 8, 54]) {
    const targets = HISTORY_OPTION_CATALOGS.ros_items.slice(0, size).map(o => ({ sectionKey: "review-of-systems", sectionId: "systems", optionCode: o.code }));
    const summaries = (["individual", "bulk"] as const).map(method => {
      const act = { ...buildHistoryItemReview({ patientReference, encounterReference, sectionKey: "review-of-systems", method, gestureId: randomUUID(), targets, actorReference: "Practitioner/test", recordedAt: now }), id: randomUUID() };
      return projectHistorySubjectSections([act], patientReference, encounterReference, now).find(s => s.sectionKey === "review-of-systems")!.summary;
    });
    assert.equal(summaries[0], summaries[1]);
  }
});
test("Social declares per-item review and still requires exactly four answers", () => {
  const social = HISTORY_SUBJECT_SECTIONS.find(s => s.key === "social-history")!;
  assert.equal(social.review, "per-item");
  assert.equal(social.charted_when, undefined);
  const context = { encounterStart: now, lastReviewed: [{ target, lastReviewed: now }] };
  assert.equal(historySubjectSectionState(social, [], context), "not-started");
  assert.equal(historySubjectSectionState(social, [tobacco], context), "started");
  const complete = [tobacco, ...["driving", "alcohol-drugs", "home-safety"].map(sectionId => ({ ...tobacco, id: sectionId, sectionId, optionCode: sectionId === "driving" ? "drives-at-night" : sectionId === "alcohol-drugs" ? "alcohol-use" : "does-not-feel-safe-at-home", value: { kind: "tri-state" as const, status: "negative" as const } }))];
  assert.equal(historySubjectSectionState(social, complete, context), "charted");
  for (let i = 0; i < 4; i++) assert.notEqual(historySubjectSectionState(social, complete.filter((_, n) => n !== i), context), "charted");
});
test("reminder survives a tobacco review act and clears only after answer persistence", async () => {
  const s = historyRosFixture([answer("2025-09-05T12:00:00Z")]);
  assert.equal(reminders(await record(s))[0].text, "Tobacco status not documented this performance period.");
  const review = await handleHistoryItemReviewRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, sectionKey: target.sectionKey, action: "items-reviewed", method: "individual", gestureId: randomUUID(), targets: [target] } });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const reviewed = await record(s);
  assert.equal(reminders(reviewed).length, 1);
  assert.equal(reviewed.lastReviewed.find((r: any) => r.target.sectionKey === target.sectionKey).lastReviewed, now);
  assert.notEqual(reviewed.subjectSectionSummaries.find((r: any) => r.sectionKey === target.sectionKey).state, "charted");
  const saved = await handleHpiCaptureRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, templateAnswers: [tobacco] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(reminders(await record(s)).length, 0);
});
test("reminder uses persisted patient answers across visits with inclusive calendar-year dates", async () => {
  for (const date of ["2026-01-01T00:00:00Z", "2026-09-04T12:00:00Z", "2026-12-31T23:59:59.999Z", "2026-01-01T00:15:00+05:00"]) {
    assert.equal(reminders(await record(historyRosFixture([answer(date)]))).length, 0, date);
  }
});
test("out-of-window, voided, cancelled, undated, foreign, and non-selection answers cannot clear reminder", async () => {
  const wrongKind = buildHistoryAnswerObservation({ ...tobacco, value: { kind: "text", text: "never" } }, { patientReference, encounterReference: "Encounter/prior", recordedAt: now });
  for (const row of [answer("2025-12-31T23:59:59Z"), answer("2027-01-01T00:00:00Z"), answer(now, { status: "entered-in-error" }), answer(now, { status: "cancelled" }), answer(now, { effectiveDateTime: undefined }), answer(now, { subject: { reference: "Patient/foreign" } }), { ...wrongKind, id: randomUUID() }]) {
    assert.equal(reminders(await record(historyRosFixture([row]))).length, 1, JSON.stringify(row));
  }
});
test("row 64 records the period verification with primary URLs and access date", () => {
  const ledger = readFileSync(new URL("../../data/code-bindings/v0.6-verification-ledger.md", import.meta.url), "utf8");
  const row = ledger.split("\n").find(line => /^\| 64 \|/.test(line));
  assert.ok(row, "Mandate 14 row 64 is required");
  assert.match(row, /https:\/\/ecqi\.healthit\.gov\//);
  assert.match(row, /https:\/\/qpp\.cms\.gov\//);
  assert.match(row, /2026-09-05/);
});
