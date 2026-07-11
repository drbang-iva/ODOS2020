import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiagnosisCompletenessDialog,
  runSignTimeCompletenessCheck,
} from "../src/components/charting/EncounterHeader";
import type { DiagnosisCompleteness } from "../src/lib/clinical-graph-client";

const missing: DiagnosisCompleteness = {
  encounterReference: "Encounter/e1",
  diagnoses: [{
    conditionReference: "Condition/c1",
    diagnosisKey: "poag",
    laterality: "right",
    display: "POAG",
    missing: [
      { findingKey: "gonioscopy", display: "gonioscopy" },
      { findingKey: "pachymetry", display: "pachymetry" },
      { findingKey: "visual_field", display: "visual field" },
    ],
  }],
};

test("sign advisory renders one quiet diagnosis line with non-blocking actions", () => {
  const html = renderToStaticMarkup(
    <DiagnosisCompletenessDialog
      diagnoses={missing.diagnoses}
      signing={false}
      onSignAnyway={() => undefined}
      onAddFindings={() => undefined}
    />,
  );
  assert.match(html, /POAG is active without: gonioscopy · pachymetry · visual field/);
  assert.match(html, />Sign anyway</);
  assert.match(html, />Add findings</);
  assert.doesNotMatch(html, /Order tests/);
});

test("sign-time completeness advises when needed but signs on empty results and read failures", async () => {
  let signed = 0;
  let advisories = 0;
  const sign = async () => { signed += 1; };
  const show = () => { advisories += 1; };

  await runSignTimeCompletenessCheck(async () => missing, sign, show);
  assert.equal(advisories, 1);
  assert.equal(signed, 0);

  await runSignTimeCompletenessCheck(async () => ({ encounterReference: "Encounter/e1", diagnoses: [] }), sign, show);
  assert.equal(signed, 1);

  await runSignTimeCompletenessCheck(async () => { throw new Error("read unavailable"); }, sign, show);
  assert.equal(signed, 2);
});

test("diagnosis completeness is called only from the explicit EncounterHeader sign path", () => {
  const chartingDirectory = join(process.cwd(), "src", "components", "charting");
  const header = readFileSync(join(chartingDirectory, "EncounterHeader.tsx"), "utf8");
  assert.match(header, /requestFinishEncounter/);
  assert.match(header, /onClick=\{requestFinishEncounter\}/);
  assert.match(header, /readDiagnosisCompleteness\(encounterId\)/);
  assert.match(header, /onSignAnyway=\{\(\) => void finishEncounter\(\)\}/);
  const otherChartingSources = readdirSync(chartingDirectory)
    .filter((name) => name.endsWith(".tsx") && name !== "EncounterHeader.tsx")
    .map((name) => readFileSync(join(chartingDirectory, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(otherChartingSources, /readDiagnosisCompleteness|diagnosis-completeness/);
});
