import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { ExamOverviewBoard, ExamCompletenessControl, type ExamOverviewProjection } from "../src/components/charting/ExamOverviewBoard";
import { chartEditorInventory } from "../src/components/charting/SpineNav";
import { buildExamOverviewProjection } from "../../mcp/src/clinical-graph/exam-overview-projection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const inventory = chartEditorInventory({ ocularHealthSections: [
  { id: "ocular-health:anterior:cornea", label: "Cornea", segment: "anterior" },
  { id: "ocular-health:posterior:macula", label: "Macula", segment: "posterior" },
] });
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === "string" ? child : text(child)).join(" ");
const projection = (examScope = "office-visit") => buildExamOverviewProjection({
  encounterReference: "Encounter/shelf", patientReference: "Patient/synthetic", examScope,
  definitions: [], currentObservations: [], priorObservationCandidates: [], assessmentRows: [],
});
const props = (p: ExamOverviewProjection) => ({ projection: p, editorEntries: inventory, refreshing: false, onOpenEditor() {}, onRefresh() {} });

for (const scope of ["office-visit", "comprehensive"]) test(`S2b1 G1 G2 shelf and drawn lines partition the whole inventory: ${scope}`, () => {
  const renderer = create(<ExamOverviewBoard {...props(projection(scope))} />);
  try {
    const shelf = renderer.root.findByProps({ "data-testid": "exam-shelf" });
    assert.equal(shelf.type, "nav");
    assert.equal(shelf.findAllByType("details").length, 0);
    assert.equal(renderer.root.findAllByProps({ "data-testid": "chart-another-finding" }).length, 0);
    const shelfIds = shelf.findAllByProps({ "data-testid": "exam-editor-entry-row" }).map(row => row.props["data-editor-section-id"]);
    const drawnIds = renderer.root.findAll(node => typeof node.type === "string" && node.props["data-drawn-editor-id"]).map(row => row.props["data-drawn-editor-id"]);
    assert.deepEqual([...shelfIds, ...drawnIds].sort(), inventory.map(entry => entry.id).sort());
    assert.equal(new Set([...shelfIds, ...drawnIds]).size, inventory.length);
    assert.deepEqual(shelf.findAllByType("h3").map(text), ["Tests & imaging", "Pretest", "Refraction", "Contact Lenses", "Ocular Health", "Section groups"]);
    assert.ok(shelfIds.includes("imaging"));
  } finally { renderer.unmount(); }
});

test("S2b1 G2 shelf exists even with no remaining inventory", () => {
  const renderer = create(<ExamOverviewBoard {...props(projection())} editorEntries={[]} />);
  try { assert.equal(renderer.root.findAllByProps({ "data-testid": "exam-shelf" }).length, 1); }
  finally { renderer.unmount(); }
});

test("S2b1 G5 content-pinned groups retain the pin wording without a removal affordance", () => {
  const renderer = create(<ExamOverviewBoard {...props(projection())} pinnedSectionGroups={[
    { id: "dry-eye", groupKey: "dry-eye-workup", label: "Dry Eye Workup", sectionKeyPrefixes: ["dry-eye:"], active: true },
  ]} />);
  try {
    const shelf = renderer.root.findByProps({ "data-testid": "exam-shelf" });
    assert.match(text(shelf), /Dry Eye Workup\s+· Has findings this visit/);
    assert.equal(shelf.findAllByType("button").filter(button => /Remove/.test(text(button))).length, 0);
  } finally { renderer.unmount(); }
});

test("S2b1 G6 unmatched findings keep value eye and date in their row, including an unknown section", () => {
  const p = projection();
  p.findings = [
    { observationReference: "Observation/unmapped", findingKey: "unmapped", sectionKey: "ocular-health:posterior:unmapped", display: "Synthetic finding", laterality: "OD", examination: { state: "examined", sourceEncoding: "observation" }, interpretation: "unknown", provenance: { state: "current" }, current: { recordedAt: "2026-09-19T12:00:00Z", value: { kind: "string", value: "visible synthetic value" }, components: [] } },
    { observationReference: "Observation/unknown", findingKey: "unknown", sectionKey: "custom:unknown", display: "Unknown section finding", laterality: "OU", examination: { state: "examined", sourceEncoding: "observation" }, interpretation: "unknown", provenance: { state: "current" }, current: { recordedAt: "2026-09-19T12:00:00Z", value: { kind: "number", value: 42 }, components: [] } },
  ];
  const renderer = create(<ExamOverviewBoard {...props(p)} />);
  try {
    const ocular = renderer.root.findByProps({ "data-section-key": "ocular-health" });
    assert.match(text(ocular), /Other findings.*Synthetic finding.*visible synthetic value.*OD.*2026-09-19/);
    assert.match(text(renderer.root), /Other findings.*Unknown section finding.*42.*OU.*2026-09-19/);
    assert.equal(ocular.findAllByProps({ "data-testid": "exam-finding-editor" }).length, 0);
  } finally { renderer.unmount(); }
});

test("S2b1 G7 both carried states are drawn and unreasserted retains its count", () => {
  const p = projection();
  p.findings = (["carried-reasserted", "carried-unreasserted"] as const).map((state, i) => ({
    observationReference: `Observation/carried-${i}`, findingKey: "intraocular_pressure", sectionKey: "tonometry", display: "IOP", laterality: i ? "OS" : "OD", examination: { state: "examined", sourceEncoding: "observation" }, interpretation: "normal", provenance: { state, sourceDate: "2026-09-01" }, current: { recordedAt: "2026-09-19T12:00:00Z", value: { kind: "number", value: 15 + i }, components: [] },
  }));
  p.completeness.trace.push({ sectionKey: "pretest", label: "Pretest", state: "partial", resolved: false, carriedUnreassertedCount: 1 });
  const renderer = create(<><ExamOverviewBoard {...props(p)} /><ExamCompletenessControl completeness={p.completeness} /></>);
  try {
    const line = renderer.root.findByProps({ "data-drawn-editor-id": "iop" });
    assert.match(text(line), /same as 2026-09-01 · confirmed today/);
    assert.match(text(line), /carried, not reasserted/);
    assert.match(text(line), /15/); assert.match(text(line), /16/);
    const carried = line.findByProps({ "data-provenance-state": "carried-unreasserted" });
    assert.match(carried.props.className, /is-carried-unreasserted/);
    act(() => renderer.root.findByProps({ "data-testid": "exam-completeness-trigger" }).props.onClick());
    assert.match(text(renderer.root), /1\s+carried, not reasserted/);
  } finally { renderer.unmount(); }
});

test("S2b1 G8 scope determines drawn lines regardless of scheduling category", () => {
  const rowKeys: Record<string, string[]> = {};
  for (const scope of ["office-visit", "comprehensive"]) for (const category of ["exams", "medical"]) {
    const p = { ...projection(scope), visitTypeCategoryId: category };
    const renderer = create(<ExamOverviewBoard {...props(p)} />);
    try {
      const keys = renderer.root.findAllByProps({ "data-testid": "exam-overview-section" }).map(row => row.props["data-section-key"]);
      assert.deepEqual(keys, scope === "office-visit" ? ["history", "assessment"] : ["history", "pretest", "refraction", "contact-lenses", "ocular-health", "assessment"]);
      rowKeys[`${scope}-${category}`] = keys;
    } finally { renderer.unmount(); }
  }
  assert.deepEqual(rowKeys["office-visit-exams"], rowKeys["office-visit-medical"]);
});
