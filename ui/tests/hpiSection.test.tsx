import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_HPI_ROS_OPTIONS,
  HPI_ELEMENTS,
  HpiSection,
  buildHpiRequestBody,
} from "../src/components/charting/HpiSection";
import { SpineNav } from "../src/components/charting/SpineNav";

test("HPI section statically renders chief complaint, all eight HPI elements, and extensible ROS controls", () => {
  const html = renderToStaticMarkup(
    <HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />,
  );

  assert.match(html, /Chief complaint \/ HPI \/ ROS/);
  assert.match(html, /aria-label="Chief complaint"/);
  for (const [, display] of HPI_ELEMENTS) assert.match(html, new RegExp(display.replace("/", "\\/")));
  for (const option of DEFAULT_HPI_ROS_OPTIONS) assert.match(html, new RegExp(option.display.replace("/", "\\/")));
  assert.match(html, /Eye-focused/);
  assert.match(html, /General medical/);
  assert.match(html, /Not reviewed/);
  assert.match(html, /Negative/);
  assert.match(html, /Positive/);
  assert.match(html, /Add another medical flag/);
  assert.match(html, /Add flag/);
  assert.match(html, /Save history/);
  assert.match(html, /disabled=""/);
});

test("HPI request builder trims text, omits blank elements, and carries custom general-medical flags", () => {
  const rosOptions = [
    ...DEFAULT_HPI_ROS_OPTIONS,
    { code: "migraine", display: "Migraine", category: "general" as const },
  ];
  const body = buildHpiRequestBody({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    chiefComplaint: "  blurred vision  ",
    hpi: {
      location: "  both eyes ",
      quality: "",
      severity: " moderate ",
      duration: "",
      timing: "",
      context: " reading ",
      modifyingFactors: "",
      associatedSignsSymptoms: " eyestrain ",
    },
    rosStatuses: { "vision-changes": "positive", diabetes: "negative", migraine: "positive" },
    rosOptions,
  });

  assert.equal(body.chiefComplaint, "blurred vision");
  assert.deepEqual(body.hpi, {
    location: "both eyes",
    severity: "moderate",
    context: "reading",
    associatedSignsSymptoms: "eyestrain",
  });
  assert.deepEqual(body.reviewOfSystems, [
    { code: "vision-changes", display: "Vision changes", category: "eye", status: "positive" },
    { code: "diabetes", display: "Diabetes", category: "general", status: "negative" },
    { code: "migraine", display: "Migraine", category: "general", status: "positive" },
  ]);
});

test("History is the first top-level spine group before Pretest", () => {
  const html = renderToStaticMarkup(<SpineNav active="hpi" statuses={{}} onSelect={() => undefined} />);
  const historyIndex = html.indexOf("HISTORY");
  const hpiIndex = html.indexOf("Chief Complaint / HPI / ROS");
  const pretestIndex = html.indexOf("PRETEST");

  assert.ok(historyIndex >= 0);
  assert.ok(hpiIndex >= 0);
  assert.ok(pretestIndex >= 0);
  assert.ok(historyIndex < hpiIndex);
  assert.ok(hpiIndex < pretestIndex);
});
