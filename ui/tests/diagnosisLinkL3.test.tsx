import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiagnosisCompletenessDialog,
  DiagnosisCompletenessDialogActions,
  runSignTimeCompletenessCheck,
} from "../src/components/charting/EncounterHeader";
import {
  readDiagnosisCompleteness,
  type DiagnosisCompleteness,
} from "../src/lib/clinical-graph-client";

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
  let shown: DiagnosisCompleteness["diagnoses"] | undefined;
  const sign = async () => { signed += 1; };
  const show = (diagnoses: DiagnosisCompleteness["diagnoses"]) => {
    advisories += 1;
    shown = diagnoses;
  };

  await runSignTimeCompletenessCheck(async () => missing, sign, show);
  assert.equal(advisories, 1);
  assert.deepEqual(shown, missing.diagnoses);
  assert.equal(signed, 0);

  await runSignTimeCompletenessCheck(async () => ({ encounterReference: "Encounter/e1", diagnoses: [] }), sign, show);
  assert.equal(signed, 1);

  await runSignTimeCompletenessCheck(async () => { throw new Error("read unavailable"); }, sign, show);
  assert.equal(signed, 2);
});

test("a hung completeness read aborts at its deadline and still signs", async () => {
  const originalFetch = globalThis.fetch;
  let signed = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  try {
    await runSignTimeCompletenessCheck(
      () => readDiagnosisCompleteness("e1", 5),
      async () => { signed += 1; },
      () => assert.fail("a hung read must not show advisories"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(signed, 1);
});

test("dialog actions invoke only their corresponding callbacks", () => {
  let addFindings = 0;
  let signAnyway = 0;
  const actions = DiagnosisCompletenessDialogActions({
    signing: false,
    onAddFindings: () => { addFindings += 1; },
    onSignAnyway: () => { signAnyway += 1; },
  });
  const buttons = React.Children.toArray(actions.props.children) as React.ReactElement<{ onClick: () => void }>[];
  buttons[0]?.props.onClick();
  assert.deepEqual({ addFindings, signAnyway }, { addFindings: 1, signAnyway: 0 });
  buttons[1]?.props.onClick();
  assert.deepEqual({ addFindings, signAnyway }, { addFindings: 1, signAnyway: 1 });
});

test("encounter changes clear advisories, cancel late checks, and reset only checking state", () => {
  const header = readFileSync(join(process.cwd(), "src", "components", "charting", "EncounterHeader.tsx"), "utf8");
  assert.match(header, /completenessCheckVersion\.current \+= 1;\s+setCompletenessAdvisories\(\[\]\);\s+setBusy\(\(current\) => current === "checking" \? null : current\)/);
  assert.match(header, /requestVersion === completenessCheckVersion\.current/);
  assert.match(header, /requestVersion !== completenessCheckVersion\.current/);
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
