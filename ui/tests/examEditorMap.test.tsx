import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { create } from "react-test-renderer";
import { ExamOverviewBoard } from "../src/components/charting/ExamOverviewBoard";
import { chartEditorInventory, SpineNav } from "../src/components/charting/SpineNav";
import { proveEditor, proofEditors, writerKeys } from "../../docs/build-log/followup-s2b2a-collapse/writer-probe.mjs";
import { buildExamOverviewProjection } from "../../mcp/src/clinical-graph/exam-overview-projection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const customSections = [
  { id: "custom:synthetic", label: "Synthetic custom" },
  { id: "dry-eye:synthetic", label: "Synthetic dry-eye" },
  { id: "procedure:synthetic", label: "Synthetic procedure" },
  { id: "aesthetics-consent", label: "Consent" },
] as const;
const ocularHealthSections = [{ id: "ocular-health:anterior:synthetic", label: "Synthetic ocular", segment: "anterior" }] as const;
const inventory = chartEditorInventory({ customSections: [...customSections], ocularHealthSections: [...ocularHealthSections] });
const empty = () => buildExamOverviewProjection({ encounterReference: "Encounter/e1", patientReference: "Patient/p1",
  examScope: "comprehensive", definitions: [], currentObservations: [], priorObservationCandidates: [], assessmentRows: [] });
async function mapModule() {
  const module = await import("../src/lib/exam-editor-map").catch(() => undefined);
  assert.ok(module, "the single editor map must exist");
  return module;
}

test("S2b2a G5 every inventory entry has an explicit evidence decision, including unknown procedures", async () => {
  const { editorDataEvidence } = await mapModule();
  for (const entry of inventory) assert.ok(editorDataEvidence(entry.id), `Missing registry decision: ${entry.id}`);
  assert.equal(editorDataEvidence("procedure:synthetic"), "unknown");
  assert.equal(editorDataEvidence("hpi"), "never-shelvable");
  assert.equal(editorDataEvidence("assessment"), "never-shelvable");
});

for (const editor of proofEditors) test(`S2b2a G1 G8 real save/read/clear and writer pin: ${editor}`, async () => {
  const proof = await proveEditor(editor);
  const { editorForFinding, holdsData, FINDING_EDITOR_MAP } = await mapModule();
  const actualEditor = editor.startsWith("custom:") ? proof.key : editor;
  const entries = chartEditorInventory({
    customSections: [{ id: actualEditor, label: "Synthetic definition", group: editor.startsWith("dry-eye:") ? "OCULAR HEALTH" : undefined }],
    ocularHealthSections: editor.startsWith("ocular-health:") ? [{ id: actualEditor, label: "Synthetic ocular", segment: "anterior" }] : [],
  }).filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index);
  const entry = entries.find(row => row.id === actualEditor)!;
  const finding = proof.saved.findings.find(row => row.findingKey === proof.key)!;
  assert.equal(editorForFinding({ findingKey: proof.key, rows: [finding] }, entries)?.id, actualEditor);
  if (editor in writerKeys) assert.equal(FINDING_EDITOR_MAP[proof.key], editor, `Missing writer pin: ${proof.key} -> ${editor}`);
  assert.equal(holdsData(entry, proof.saved, entries), true);
  if (editor !== "hpi") {
    assert.equal(holdsData(entry, proof.before, entries), false, `${editor} before save`);
    assert.equal(holdsData(entry, proof.after, entries), false, `${editor} after real clear`);
  }
  const renderer = create(<ExamOverviewBoard projection={proof.saved} editorEntries={entries} refreshing={false} onRefresh={() => {}} onOpenEditor={() => {}} />);
  try {
    assert.equal(renderer.root.findAllByProps({ "data-exam-view-action": "collapse", "data-editor-id": actualEditor }).length, 1);
    assert.equal(renderer.root.findAllByProps({ "data-exam-view-action": "shelve", "data-editor-id": actualEditor }).length, 0);
  } finally { renderer.unmount(); }
});

test("S2b2a G4 unregistered, registered unknown, and Other findings fail closed", async () => {
  const { holdsData } = await mapModule();
  const entries = [...inventory, { id: "future-unregistered", label: "Future", group: "PRETEST" }];
  const p = empty();
  for (const id of ["future-unregistered", "wearing", "procedure:synthetic"]) {
    const entry = entries.find(row => row.id === id)!;
    assert.equal(holdsData(entry, p, entries), "unknown");
    const renderer = create(<ExamOverviewBoard projection={p} editorEntries={entries} openedEditorIds={[entry.id]} refreshing={false} onRefresh={() => {}} onOpenEditor={() => {}} />);
    try {
      assert.equal(renderer.root.findAllByProps({ "data-exam-view-action": "shelve", "data-editor-id": id }).length, 0);
      assert.equal(renderer.root.findAllByProps({ "data-exam-view-action": "collapse", "data-editor-id": id }).length, 1);
    } finally { renderer.unmount(); }
  }
  p.findings = [{ observationReference: "Observation/unmapped", findingKey: "unmapped", sectionKey: "pretest:unmapped", display: "Synthetic unmatched",
    laterality: "OD", examination: { state: "examined", sourceEncoding: "observation" }, interpretation: "unknown", provenance: { state: "current" },
    current: { components: [], value: { kind: "string", value: "Recorded other data" } } }];
  const renderer = create(<ExamOverviewBoard projection={p} editorEntries={entries} refreshing={false} onRefresh={() => {}} onOpenEditor={() => {}} />);
  try {
    const pretest = renderer.root.findByProps({ "data-section-key": "pretest" });
    assert.equal(pretest.findAllByProps({ "data-exam-view-action": "shelve" }).length, 0);
    assert.equal(holdsData(entries.find(row => row.id === "cover-test")!, p, entries), "unknown");
  } finally { renderer.unmount(); }
});

test("S2b2a G9 SpineNav renders every entry of the board inventory, including on-demand entries", () => {
  for (const eyeGrowthDefaultVisible of [true, false]) {
    const entries = chartEditorInventory({ customSections: [...customSections], ocularHealthSections: [...ocularHealthSections], eyeGrowthDefaultVisible });
    const renderer = create(<SpineNav active="hpi" statuses={{}} onSelect={() => {}} customSections={[...customSections]}
      ocularHealthSections={[...ocularHealthSections]} eyeGrowthDefaultVisible={eyeGrowthDefaultVisible} />);
    try {
      const renderedLabels = renderer.root.findAllByType("button").map(button => button.findAllByType("span").map(span => span.children.join("")).join(" "));
      for (const entry of entries) assert.ok(renderedLabels.some(label => label === entry.label || label.endsWith(` ${entry.label}`)), `SpineNav missing ${entry.id}`);
    } finally { renderer.unmount(); }
  }
});
