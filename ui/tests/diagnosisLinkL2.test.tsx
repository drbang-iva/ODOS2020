import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const CHARTING = join(process.cwd(), "src", "components", "charting");

test("diagnosis picker stays collapsed until clicked and exposes paired Possible and Confirm actions plus catalog search", () => {
  const source = readFileSync(join(CHARTING, "DiagnosisPicker.tsx"), "utf8");
  assert.match(source, /dx ▾ \{finding\.candidates\.length\}/);
  assert.match(source, /setOpenId\(\(current\) => current === finding\.findingInstanceId/);
  assert.match(source, />Possible<\/button>/);
  assert.match(source, />Confirm<\/button>/);
  assert.match(source, /Search full diagnosis catalog/);
  assert.match(source, /catalog-search/);
  assert.match(source, /finding\.candidates\.length > 0/);
  assert.match(source, /loadVersion/);
  assert.match(source, /code=\{catalogCode\(candidate\)\}/);
});

test("cup-disc and refraction charted rows use the shared picker route", () => {
  const cupDisc = readFileSync(join(CHARTING, "CupDiscSection.tsx"), "utf8");
  const refraction = readFileSync(join(CHARTING, "RefractionSection.tsx"), "utf8");
  assert.match(cupDisc, /observationReferences=\{\[result\.observationReference\]\}/);
  assert.match(cupDisc, /findingDefinitionKey="cup_disc_ratio"/);
  assert.match(refraction, /savedObservationReferences\[block\.id\]/);
  assert.match(refraction, /clearSavedObservationReferences\(blockId\)/);
  assert.match(refraction, /findingDefinitionKey="refraction"/);
  assert.doesNotMatch(refraction, /Reject suggestion/);
});

test("Assessment renders Possible decisions, hides refuted rows, and shows linked finding provenance only when present", () => {
  const source = readFileSync(join(CHARTING, "AssessmentSection.tsx"), "utf8");
  assert.match(source, /\["refuted", "entered-in-error"\]\.includes\(verificationStatus\(condition\)\)/);
  assert.match(source, /possible=\{verificationStatus\(condition\) === "provisional"\}/);
  assert.match(source, /onConfirm=\{\(\) => decidePossible\(condition, "confirm"\)\}/);
  assert.match(source, /onDiscard=\{\(\) => decidePossible\(condition, "discard"\)\}/);
  assert.match(source, /← from \{provenanceLine\}/);
  assert.match(source, /stableCode === "cup_disc_ratio"[\s\S]*"Cup\/Disc"/);
});
