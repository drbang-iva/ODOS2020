import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComplaintIntake,
  DEFAULT_HPI_ROS_OPTIONS,
  HpiSection,
  buildHpiRequestBody,
  complaintDefinitionForRos,
  markRemainingReviewedNegative,
} from "../src/components/charting/HpiSection";
import {
  blankComplaintDraft,
  effectiveComplaintOptions,
  renderComplaintNarrative,
  type ComplaintDefinition,
  type GenericComplaintOptions,
} from "../src/lib/complaints";
import { SpineNav } from "../src/components/charting/SpineNav";

const GENERIC: GenericComplaintOptions = {
  conditions: [{ code: "dry-eyes", display: "Dry Eyes", active: true }],
  qualities: [{ code: "constant", display: "constant", active: true }],
  treatments: [{ code: "no-treatment", display: "no treatment", active: true }],
};

const DRY_EYE: ComplaintDefinition = {
  id: "complaint-definition-dry-eye",
  stableKey: "dry-eye",
  display: "Patient (Dry Eye)",
  kind: "patient-symptom",
  conditionOptions: [],
  qualityOptions: [
    { code: "environmentally-sensitive", display: "environmentally sensitive", active: true },
    { code: "brought-on-by-drafts-or-fans", display: "brought on by drafts or fans", active: true },
  ],
  treatmentOptions: [
    { code: "artificial-tears", display: "artificial tears", active: true },
    { code: "warm-compresses", display: "warm compresses", active: true },
  ],
  seedRank: 10,
  status: "active",
};

const ROUTINE: ComplaintDefinition = {
  ...DRY_EYE,
  id: "complaint-definition-routine-eye-exam",
  stableKey: "routine-eye-exam",
  display: "Routine Eye Exam",
  kind: "evaluation-reason",
  qualityOptions: [],
  treatmentOptions: [],
  seedRank: 3,
};

test("HPI section renders Presenting Complaints, Top Complaints, persistent ROS controls, and no legacy free-text grid", () => {
  const html = renderToStaticMarkup(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, /Chief complaint \/ HPI \/ ROS/);
  assert.match(html, /Presenting Complaints/);
  assert.match(html, /Top Complaints/);
  assert.match(html, /Search complaints/);
  assert.match(html, /Other/);
  assert.match(html, /Eye-focused/);
  assert.match(html, /General medical/);
  assert.match(html, /Mark remaining reviewed: negative/);
  assert.match(html, /Add another medical flag/);
  assert.match(html, /Add flag/);
  assert.doesNotMatch(html, /aria-label="Chief complaint"/);
  for (const legacy of ["Modifying factors", "Associated signs / symptoms", "History of present illness"]) assert.doesNotMatch(html, new RegExp(legacy));
});

test("Complaint Intake renders all six clusters and the automated narrative controls", () => {
  const draft = blankComplaintDraft({ complaintKey: "dry-eye" });
  const html = renderToStaticMarkup(<ComplaintIntake
    draft={draft}
    definition={DRY_EYE}
    options={effectiveComplaintOptions(GENERIC, DRY_EYE)}
    preview="Patient reports dry eye. Current treatment: none."
    overrideDirty={false}
    saving={false}
    onUpdate={() => undefined}
    onToggle={() => undefined}
    onNarrativeMode={() => undefined}
    onRegenerate={() => undefined}
    onCancel={() => undefined}
    onSave={() => undefined}
  />);
  for (const label of ["Symptoms", "Laterality", "Character", "Duration", "Current treatment", "Referral &amp; history", "History Narrative"]) assert.match(html, new RegExp(label));
  assert.match(html, /environmentally sensitive/);
  assert.match(html, /artificial tears/);
  assert.match(html, /Automated/);
  assert.match(html, /Override/);
  assert.match(html, /Save and Add Another/);
  assert.match(html, /Save Complaint/);
});

test("dry eye layers its sourced vocabulary while every other seed remains generic-only", () => {
  const dry = effectiveComplaintOptions(GENERIC, DRY_EYE);
  const routine = effectiveComplaintOptions(GENERIC, ROUTINE);
  assert.deepEqual(dry.qualities.map((option) => option.code), ["constant", "environmentally-sensitive", "brought-on-by-drafts-or-fans"]);
  assert.deepEqual(dry.treatments.map((option) => option.code), ["no-treatment", "artificial-tears", "warm-compresses"]);
  assert.deepEqual(routine, GENERIC);
});

test("History Narrative matches the worked dry-eye example and override text stays frozen", () => {
  const draft = {
    ...blankComplaintDraft({ complaintKey: "dry-eye" }),
    conditions: ["dry-eyes"],
    eyeLocation: "OU" as const,
    eyeComparison: "right-worse" as const,
    qualities: ["constant", "environmentally-sensitive", "brought-on-by-drafts-or-fans"],
    duration: { value: 3, unit: "months" as const },
    treatmentsTried: ["artificial-tears", "warm-compresses"],
    additionalHistory: "worse at end of workday",
  };
  const narrative = renderComplaintNarrative(draft, DRY_EYE, GENERIC);
  assert.equal(narrative, "Patient reports dry eyes, both eyes, right worse than left, ongoing for 3 months. Described as constant, environmentally sensitive, brought on by drafts or fans. Current treatment: artificial tears, warm compresses. Additional history: worse at end of workday.");
  assert.equal(renderComplaintNarrative({
    ...draft,
    conditions: [],
    narrative: { mode: "override", overrideText: "Clinician-authored paragraph." },
  }, DRY_EYE, GENERIC), "Clinician-authored paragraph.");
  assert.match(renderComplaintNarrative({
    ...draft,
    duration: { value: 1, unit: "weeks" },
  }, DRY_EYE, GENERIC), /ongoing for 1 week\./);
  const dirtyHtml = renderToStaticMarkup(<ComplaintIntake
    draft={{ ...draft, narrative: { mode: "override", overrideText: narrative } }}
    definition={DRY_EYE}
    options={effectiveComplaintOptions(GENERIC, DRY_EYE)}
    preview={narrative}
    overrideDirty={true}
    saving={false}
    onUpdate={() => undefined}
    onToggle={() => undefined}
    onNarrativeMode={() => undefined}
    onRegenerate={() => undefined}
    onCancel={() => undefined}
    onSave={() => undefined}
  />);
  assert.match(dirtyHtml, /Narrative is overridden and coded fields changed/);
  assert.match(dirtyHtml, /Regenerate from coded fields/);
});

test("ROS bulk-negative changes only Not reviewed items and positive rows map to pre-seeded complaints", () => {
  const statuses = markRemainingReviewedNegative(
    { "vision-changes": "positive", "eye-pain": "negative", diabetes: "" },
    DEFAULT_HPI_ROS_OPTIONS,
    "eye",
  );
  assert.equal(statuses["vision-changes"], "positive");
  assert.equal(statuses["eye-pain"], "negative");
  assert.equal(statuses["floaters-flashes"], "negative");
  assert.equal(statuses.diabetes, "");
  assert.equal(complaintDefinitionForRos(DEFAULT_HPI_ROS_OPTIONS.find((option) => option.code === "eye-pain")!, [DRY_EYE, ROUTINE, { ...DRY_EYE, stableKey: "patient-eye-pain" }])?.stableKey, "patient-eye-pain");
  assert.equal(complaintDefinitionForRos(DEFAULT_HPI_ROS_OPTIONS.find((option) => option.code === "diabetes")!, [DRY_EYE, ROUTINE]), undefined);
});

test("history request transmits only reviewed ROS values and bulk-attestation provenance inputs", () => {
  const body = buildHpiRequestBody({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    rosStatuses: { "vision-changes": "positive", diabetes: "negative" },
    rosOptions: DEFAULT_HPI_ROS_OPTIONS,
    reviewAttestations: ["general"],
  });
  assert.deepEqual(body.reviewOfSystems, [
    { code: "vision-changes", display: "Vision changes", category: "eye", status: "positive" },
    { code: "diabetes", display: "Diabetes", category: "general", status: "negative" },
  ]);
  assert.deepEqual(body.reviewAttestations, ["general"]);
});

test("legacy next-field wiring is fully removed from the source", () => {
  const source = readFileSync(new URL("../src/components/charting/HpiSection.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /HPI_ELEMENTS|EMPTY_HPI|chiefComplaint|modifyingFactors|associatedSignsSymptoms/);
});

test("History is the first top-level spine group before Pretest", () => {
  const html = renderToStaticMarkup(<SpineNav active="hpi" statuses={{}} onSelect={() => undefined} />);
  const historyIndex = html.indexOf("HISTORY");
  const hpiIndex = html.indexOf("Chief Complaint / HPI / ROS");
  const pretestIndex = html.indexOf("PRETEST");
  assert.ok(historyIndex >= 0 && hpiIndex > historyIndex && pretestIndex > hpiIndex);
});
