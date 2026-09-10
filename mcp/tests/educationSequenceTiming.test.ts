import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateEducationSequenceTime, educationLocalDay } from "../src/comms/education-sequence-timing.js";
import type { EducationSequenceStep } from "../src/comms/education-sequence.js";
const row = (patch: Partial<EducationSequenceStep> = {}): EducationSequenceStep => ({
  stepIndex: 1, channel: "sms", lane: "clinical", content: { id: "education", version: 1 },
  recipientReference: "Patient/test", plannedAt: "2026-03-01T10:00:00Z", notBefore: "2026-03-01T10:00:00Z",
  latestUsefulTime: "2026-12-31T23:59:59Z", anchor: "predecessor-acceptance", predecessorStepIndex: 0,
  offsetDays: 1, dayInterpretation: "calendar", timezone: "America/New_York", ...patch,
});
test("stage entry uses its own notBefore without applying offset again", () => {
  assert.deepEqual(calculateEducationSequenceTime(row({ anchor: "stage-entry", offsetDays: 7, plannedAt: "2026-03-02T10:00:00Z" })), { status: "ready", effectiveAt: "2026-03-01T10:00:00.000Z" });
});
test("missing or unknown acceptance holds without using forecast", () => {
  for (const evidence of [undefined, { kind: "unknown" as const }])
    assert.deepEqual(calculateEducationSequenceTime(row(), evidence), { status: "held", reason: "predecessor-anchor-unavailable" });
});
test("recorded acceptance and explicit clinician skip determine pacing", () => {
  for (const kind of ["accepted", "clinician-skip"] as const)
    assert.deepEqual(calculateEducationSequenceTime(row(), { kind, at: "2026-03-04T15:30:00Z" }), { status: "ready", effectiveAt: "2026-03-05T15:30:00.000Z" });
});
test("spring gap advances to first valid local time, not shifted minutes", () => {
  assert.deepEqual(calculateEducationSequenceTime(row(), { kind: "accepted", at: "2026-03-07T07:30:15.250Z" }), { status: "ready", effectiveAt: "2026-03-08T07:00:00.000Z" });
});
test("fall overlap chooses first occurrence", () => {
  assert.deepEqual(calculateEducationSequenceTime(row(), { kind: "accepted", at: "2026-10-31T05:30:00Z" }), { status: "ready", effectiveAt: "2026-11-01T05:30:00.000Z" });
});
test("half-hour gap moves to its first valid time", () => {
  assert.deepEqual(calculateEducationSequenceTime(row({ timezone: "Australia/Lord_Howe" }), { kind: "accepted", at: "2026-10-02T15:45:00Z" }), { status: "ready", effectiveAt: "2026-10-03T15:30:00.000Z" });
});
test("business timing fails closed for missing and mismatched pinned definitions", () => {
  const step = row({ dayInterpretation: "business", calendar: { id: "practice", version: 3 } });
  const anchor = { kind: "accepted" as const, at: "2026-03-06T15:30:00Z" };
  for (const resolve of [undefined, () => undefined, () => ({ id: "practice", version: 2, workingWeekdays: [1, 2, 3, 4, 5], holidays: [] })])
    assert.deepEqual(calculateEducationSequenceTime(step, anchor, resolve), { status: "held", reason: "business-calendar-unavailable" });
});
test("pinned business calendar uses supplied weekdays and holidays across DST", () => {
  const step = row({ dayInterpretation: "business", calendar: { id: "practice", version: 3 }, offsetDays: 2 });
  assert.deepEqual(calculateEducationSequenceTime(step, { kind: "accepted", at: "2026-03-06T15:30:00Z" }, pin => {
    assert.deepEqual(pin, { id: "practice", version: 3 });
    return { ...pin, workingWeekdays: [1, 2, 3, 4, 5], holidays: ["2026-03-09"] };
  }), { status: "ready", effectiveAt: "2026-03-11T14:30:00.000Z" });
});
test("business calendar accepts explicitly working Sunday and never defaults empty calendars", () => {
  const step = row({ dayInterpretation: "business", calendar: { id: "practice", version: 3 } });
  const anchor = { kind: "accepted" as const, at: "2026-03-06T15:30:00Z" };
  assert.deepEqual(calculateEducationSequenceTime(step, anchor, pin => ({ ...pin, workingWeekdays: [0], holidays: [] })), { status: "ready", effectiveAt: "2026-03-08T14:30:00.000Z" });
  assert.deepEqual(calculateEducationSequenceTime(step, anchor, pin => ({ ...pin, workingWeekdays: [], holidays: [] })), { status: "held", reason: "business-calendar-unavailable" });
});
test("spacing identifies local calendar day across UTC midnight and DST overlap", () => {
  assert.equal(educationLocalDay("2026-03-08T02:00:00Z", "America/New_York"), "2026-03-07");
  assert.equal(educationLocalDay("2026-11-01T05:30:00Z", "America/New_York"), educationLocalDay("2026-11-01T06:30:00Z", "America/New_York"));
});
