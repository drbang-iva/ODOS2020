import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPACT_BLOCK_HEIGHT,
  isCompactBlock,
  buildCompactCues,
  type CompactCue,
} from "../../ui/src/lib/scheduler-block-density.js";
import { SCHEDULER_PALETTE, type AppointmentBlockContent } from "../../ui/src/lib/scheduling.js";

test("blocks shorter than the threshold are compact", () => {
  // 15-min slot at zoom 1: 1 row × 46px − 6 = 40px → compact
  assert.equal(isCompactBlock(40), true);
  // 30-min at zoom 1: 2 × 46 − 6 = 86px → full content
  assert.equal(isCompactBlock(86), false);
  // 15-min at zoom 1.75: round(46 × 1.75) − 6 = 75px → zooming in restores full content
  assert.equal(isCompactBlock(75), false);
  assert.equal(isCompactBlock(COMPACT_BLOCK_HEIGHT), false, "threshold itself renders full");
  assert.equal(isCompactBlock(COMPACT_BLOCK_HEIGHT - 1), true);
});

function content(overrides: Partial<AppointmentBlockContent> = {}): AppointmentBlockContent {
  return {
    patientDisplay: "Test Patient",
    visitTypeDisplay: "Comprehensive Exam",
    color: "#4a7dff",
    status: "scheduled",
    statusDisplay: "Scheduled",
    confirmation: "not-confirmed",
    confirmationDisplay: "Not Confirmed",
    insuranceLine: "Vision: VSP · Medical: BCBS",
    badges: [],
    isNonPatient: false,
    ...overrides,
  };
}

function byKey(cues: CompactCue[], key: string): CompactCue | undefined {
  return cues.find((cue) => cue.key === key);
}

test("status cue: unconfirmed scheduled shows the attention glyph", () => {
  const cues = buildCompactCues(content());
  const status = byKey(cues, "status");
  assert.ok(status);
  assert.equal(status.glyph, "◌");
  assert.equal(status.color, SCHEDULER_PALETTE.nonPatientGold);
  assert.equal(status.label, "Not Confirmed");
});

test("status cue: confirmed scheduled shows a check", () => {
  const cues = buildCompactCues(content({ confirmation: "confirmed", confirmationDisplay: "Confirmed" }));
  const status = byKey(cues, "status");
  assert.ok(status);
  assert.equal(status.glyph, "✓");
  assert.equal(status.color, SCHEDULER_PALETTE.establishedTeal);
});

test("status cue: arrived family (checked-in / walk-in) shows the presence dot", () => {
  for (const code of ["checked-in", "walk-in"] as const) {
    const cues = buildCompactCues(content({ status: code, statusDisplay: code }));
    const status = byKey(cues, "status");
    assert.ok(status, code);
    assert.equal(status.glyph, "●", code);
    assert.equal(status.color, SCHEDULER_PALETTE.establishedTeal, code);
  }
});

test("status cue: no-show is a red cross, cancelled a muted cross, checked-out a muted dot", () => {
  const noShow = byKey(buildCompactCues(content({ status: "no-show", statusDisplay: "No Show" })), "status");
  assert.equal(noShow?.glyph, "✕");
  assert.equal(noShow?.color, SCHEDULER_PALETTE.urgentRed);
  const cancelled = byKey(buildCompactCues(content({ status: "cancelled", statusDisplay: "Cancelled" })), "status");
  assert.equal(cancelled?.glyph, "✕");
  assert.equal(cancelled?.color, SCHEDULER_PALETTE.mutedLineLight);
  const out = byKey(buildCompactCues(content({ status: "checked-out", statusDisplay: "Checked Out" })), "status");
  assert.equal(out?.glyph, "●");
  assert.equal(out?.color, SCHEDULER_PALETTE.mutedLineLight);
});

test("urgent badge adds the urgent cue", () => {
  const cues = buildCompactCues(content({ badges: [{ code: "urgent", display: "Urgent" }] }));
  const urgent = byKey(cues, "urgent");
  assert.ok(urgent);
  assert.equal(urgent.glyph, "!");
  assert.equal(urgent.color, SCHEDULER_PALETTE.urgentRed);
});

test("missing coverage on a patient visit adds the billing cue; non-patient blocks never get it", () => {
  const noCoverage = content({ insuranceLine: "Vision: none · Medical: none" });
  assert.ok(byKey(buildCompactCues(noCoverage), "insurance"));

  const covered = content(); // VSP + BCBS
  assert.equal(byKey(buildCompactCues(covered), "insurance"), undefined);

  const nonPatient = content({ insuranceLine: "Vision: none · Medical: none", isNonPatient: true });
  assert.equal(byKey(buildCompactCues(nonPatient), "insurance"), undefined);
});

test("cues cap at three and status always leads", () => {
  const everything = content({
    insuranceLine: "Vision: none · Medical: none",
    badges: [{ code: "urgent", display: "Urgent" }],
  });
  const cues = buildCompactCues(everything);
  assert.equal(cues.length, 3);
  assert.equal(cues[0]?.key, "status");
});
