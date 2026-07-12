import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomFindingSection } from "../src/components/charting/CustomFindingSection";
import { CustomSectionEditor } from "../src/components/charting/CustomSectionEditor";
import {
  OcularHealthSection,
  applyAnteriorAllNormal,
  copyEyeCapture,
} from "../src/components/charting/OcularHealthSection";
import { SpineNav } from "../src/components/charting/SpineNav";
import { sectionStatus } from "../src/components/charting/types";

test("SpineNav is unchanged for an empty custom registry and safely appends missing-status custom sections", () => {
  const before = renderToStaticMarkup(<SpineNav active="va" statuses={{}} onSelect={() => undefined} />);
  const emptyRegistry = renderToStaticMarkup(<SpineNav active="va" statuses={{}} onSelect={() => undefined} customSections={[]} />);
  assert.equal(emptyRegistry, before);
  assert.equal((before.match(/<button/g) ?? []).length, 14);
  assert.match(before, /ASSESSMENT &amp; PLAN/);
  assert.ok(before.indexOf("Assessment") < before.indexOf("Plan · Prescriptions"));

  const custom = renderToStaticMarkup(
    <SpineNav
      active="custom:skin-carotenoid-score-scs00000"
      statuses={{}}
      onSelect={() => undefined}
      customSections={[{ id: "custom:skin-carotenoid-score-scs00000", label: "Skin Carotenoid Score" }]}
      onAddSection={() => undefined}
    />,
  );
  assert.match(custom, /Skin Carotenoid Score/);
  assert.match(custom, /\+ Add section/);
  assert.equal((custom.match(/<button/g) ?? []).length, 16);
  assert.deepEqual(sectionStatus({}, "custom:missing"), { completed: false });
});

test("SpineNav groups the traditional spine and appends custom sections after every built-in group", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="va"
      statuses={{}}
      onSelect={() => undefined}
      customSections={[{ id: "custom:tear-pattern-eye00000", label: "Tear Pattern" }]}
    />,
  );
  const labels = [
    "PRETEST",
    "Wearing (WRx)",
    "Auto-Refraction / Auto-K",
    "Visual Acuity",
    "IOP",
    "REFRACTION",
    "Refraction History",
    "CONTACT LENSES",
    "Soft Contact Lenses",
    "Specialty Contact Lens",
    "Ortho-K",
    "Myopia Management",
    "OCULAR HEALTH",
    "Cup/Disc",
    "Dry Eye",
    "ASSESSMENT &amp; PLAN",
    "Assessment",
    "Plan · Prescriptions",
    "Tear Pattern",
  ];
  let previousIndex = -1;
  for (const label of labels) {
    const index = html.indexOf(label);
    assert.ok(index > previousIndex, `${label} should follow the prior spine entry`);
    previousIndex = index;
  }
});

test("ongoing Dry Eye and Myopia summaries stay visible without a completed dot", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="dry-eye"
      statuses={{
        "dry-eye": { completed: false, summary: "OSDI 34" },
        "myopia-management": { completed: false, summary: "OD axial length 24.12 mm" },
      }}
      onSelect={() => undefined}
    />,
  );
  assert.match(html, /OSDI 34/);
  assert.match(html, /OD axial length 24\.12 mm/);
  assert.doesNotMatch(html, /bg-emerald-400/);

  for (const file of ["DryEyeSection.tsx", "MyopiaManagementSection.tsx"]) {
    const source = readFileSync(new URL(`../src/components/charting/${file}`, import.meta.url), "utf8");
    const markSaved = source.slice(source.indexOf("function markSaved"));
    assert.match(markSaved, /completed: false/);
  }
});

test("the generic renderer shows ordered fields, OD and OS columns, automatic notes, and history", () => {
  const html = renderToStaticMarkup(
    <CustomFindingSection
      definition={{
        stableKey: "custom:tear-pattern-eye00000",
        sectionKey: "custom:tear-pattern-eye00000",
        display: "Tear Pattern",
        active: true,
        perEye: true,
        customFields: [{
          localCode: "CUSTOM_PATTERN_12345678",
          display: "Pattern",
          valueType: "select",
          options: [{ code: "stable", display: "Stable", active: true }],
          order: 0,
          active: true,
        }],
      }}
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );
  assert.match(html, /Tear Pattern/);
  assert.match(html, />OD</);
  assert.match(html, />OS</);
  assert.match(html, /Pattern/);
  assert.match(html, /Stable/);
  assert.match(html, /Other \/ notes/);
  assert.match(html, /History/);
});

test("the shared section editor composes fields through the shipped custom-field editor affordance", () => {
  const html = renderToStaticMarkup(<CustomSectionEditor onCancel={() => undefined} onSave={() => undefined} />);
  assert.match(html, /Create chart section/);
  assert.match(html, /Chart OD and OS independently/);
  assert.match(html, /\+ Add field/);
  assert.match(html, /Create section/);
});

test("the anterior renderer exposes explicit all-normal, bilateral copy, deferred, priority, nesting, and Other controls", () => {
  const html = renderToStaticMarkup(
    <OcularHealthSection
      definitions={[{
        stableKey: "ocular-health:anterior:lids-lashes",
        sectionKey: "ocular-health:anterior:lids-lashes",
        display: "Lids & Lashes",
        active: true,
        perEye: true,
        normalTemplate: "Normal lids.",
        allowDeferred: true,
        customFields: [{
          localCode: "CUSTOM_ABNORMAL_FINDINGS_02",
          display: "Abnormal findings",
          valueType: "multi-select",
          options: [
            { code: "demodex", display: "Demodex", active: true, priority: true },
            { code: "demodex::collarettes", display: "Collarettes", active: true, parentCode: "demodex", priority: true },
            { code: "ptosis", display: "Ptosis", active: true },
          ],
          order: 0,
          active: true,
        }],
      }]}
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );
  assert.match(html, /Anterior All Normal/);
  assert.match(html, /Nothing defaults to normal/);
  assert.match(html, /Copy to OS/);
  assert.match(html, /Copy to OD/);
  assert.match(html, /Not performed \/ deferred/);
  assert.equal((html.match(/>Other</g) ?? []).length, 2);
  const source = readFileSync(new URL("../src/components/charting/OcularHealthSection.tsx", import.meta.url), "utf8");
  assert.match(source, /More findings/);
  assert.match(source, /parentCode/);
});

test("SpineNav nests definition-store anterior structures without moving Cup Disc or Dry Eye", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="ocular-health:anterior:cornea"
      statuses={{}}
      onSelect={() => undefined}
      ocularHealthSections={[
        { id: "ocular-health:anterior:periocular-adnexa", label: "Periocular Adnexa" },
        { id: "ocular-health:anterior:cornea", label: "Cornea" },
      ]}
    />,
  );
  assert.ok(html.indexOf("ANTERIOR SEGMENT") < html.indexOf("Periocular Adnexa"));
  assert.ok(html.indexOf("Periocular Adnexa") < html.indexOf("Cornea"));
  assert.ok(html.indexOf("Cornea") < html.indexOf("Cup/Disc"));
  assert.ok(html.indexOf("Cup/Disc") < html.indexOf("Dry Eye"));
});

test("all-normal skips touched structures and copy-to-eye produces an independently editable clone", () => {
  const captures = {
    "ocular-health:anterior:cornea": {
      OD: { state: "abnormal" as const, selections: ["staining"], other: "" },
      OS: { selections: [], other: "" },
    },
    "ocular-health:anterior:lens": {
      OD: { selections: [], other: "" },
      OS: { selections: [], other: "" },
    },
  };
  const result = applyAnteriorAllNormal([
    { stableKey: "ocular-health:anterior:cornea" },
    { stableKey: "ocular-health:anterior:lens" },
  ], captures);
  assert.equal(result.filled, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.captures["ocular-health:anterior:cornea"]?.OD.state, "abnormal");
  assert.equal(result.captures["ocular-health:anterior:lens"]?.OD.state, "normal");
  assert.equal(result.captures["ocular-health:anterior:lens"]?.OS.state, "normal");

  const source = { state: "abnormal" as const, selections: ["demodex", "demodex::collarettes"], other: "trace" };
  const copied = copyEyeCapture(source);
  copied.selections.push("ptosis");
  assert.deepEqual(source.selections, ["demodex", "demodex::collarettes"]);
  assert.equal(copied.state, "abnormal");
  assert.equal(copied.other, "trace");
});

test("EncounterCharting keeps exactly the 14 shipped built-in render branches plus one custom branch", () => {
  const source = readFileSync(new URL("../src/scenes/EncounterCharting.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/activeSection === "/g) ?? []).length, 14);
  assert.equal((source.match(/activeSection\.startsWith\("custom:"\)/g) ?? []).length, 2);
  assert.match(source, /Custom section catalog unavailable; charting built-ins only\./);
});
