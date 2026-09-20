import assert from "node:assert/strict";
import { test } from "node:test";
import React, { useState } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { ExamOverviewBoard, type ExamOverviewProjection } from "../src/components/charting/ExamOverviewBoard";
import { chartEditorInventory } from "../src/components/charting/SpineNav";
import { changeExamViewState } from "../src/lib/exam-view-state";
import { buildExamOverviewProjection } from "../../mcp/src/clinical-graph/exam-overview-projection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const inventory = chartEditorInventory();
const beforeSave = () => buildExamOverviewProjection({
  encounterReference: "Encounter/eval-stale", patientReference: "Patient/eval", examScope: "comprehensive",
  definitions: [], currentObservations: [], priorObservationCandidates: [], assessmentRows: [],
});
const afterSave = () => ({ ...beforeSave(), findings: [{
  observationReference: "Observation/eval-iop", findingKey: "intraocular_pressure", sectionKey: "tonometry",
  display: "IOP", laterality: "OD", examination: { state: "examined", sourceEncoding: "observation" },
  interpretation: "unknown", provenance: { state: "current" },
  current: { value: { kind: "number", value: 17 }, components: [] },
}] } as ExamOverviewProjection);
const line = (root: ReactTestInstance, id: string) => root.findAll(node => typeof node.type === "string" && node.props["data-drawn-editor-id"] === id);
const controls = (root: ReactTestInstance, action: string, id: string) => root.findAllByProps({ "data-exam-view-action": action, "data-editor-id": id });

test("S2b2a G-FB1 a session-saved IOP stays drawn and collapse-only on a racing projection, then data wins after refresh", () => {
  const props = { editorEntries: inventory, refreshing: false, openedEditorIds: ["iop"], savedEditorIds: ["iop"],
    onOpenEditor() {}, onRefresh() {}, onCollapse() {}, onShelve() {} };
  const renderer = create(<ExamOverviewBoard {...props} projection={beforeSave()} viewState={{ collapsed: [], shelved: [] }} />);
  try {
    assert.equal(controls(renderer.root, "collapse", "iop").length, 1);
    assert.equal(controls(renderer.root, "shelve", "iop").length, 0);
    assert.equal(line(renderer.root, "iop").length, 1);
    assert.equal(line(renderer.root, "iop")[0]!.props["data-holds-data"], "unknown");
    act(() => renderer.update(<ExamOverviewBoard {...props} projection={beforeSave()} viewState={{ collapsed: [], shelved: ["iop"] }} />));
    assert.equal(line(renderer.root, "iop").length, 1, "a persisted shelf mark must not hide the session's saved IOP");
    assert.equal(renderer.root.findAllByProps({ "data-testid": "exam-editor-entry-row", "data-editor-section-id": "iop" }).length, 0);
    act(() => renderer.update(<ExamOverviewBoard {...props} projection={afterSave()} viewState={{ collapsed: [], shelved: ["iop"] }} />));
    assert.equal(line(renderer.root, "iop").length, 1, "after a refresh the line is drawn: data wins");
    assert.equal(line(renderer.root, "iop")[0]!.props["data-holds-data"], "true");
  } finally { renderer.unmount(); }
});

test("S2b2a G-FB3 a never-saved proven-empty line still shelves and returns", () => {
  function Host() {
    const [viewState, setViewState] = useState({ collapsed: [] as string[], shelved: [] as string[] });
    return <ExamOverviewBoard projection={beforeSave()} editorEntries={inventory} refreshing={false}
      savedEditorIds={["iop"]} viewState={viewState} onRefresh={() => {}}
      onShelve={id => setViewState(state => changeExamViewState(state, "shelve", id))}
      onOpenEditor={id => setViewState(state => changeExamViewState(state, "open", id))} />;
  }
  const renderer = create(<Host />);
  try {
    const control = controls(renderer.root, "shelve", "cover-test")[0];
    assert.ok(control, "never-saved cover-test must still offer to shelf");
    assert.equal(control.props.disabled, false);
    act(() => control.props.onClick());
    assert.equal(line(renderer.root, "cover-test").length, 0);
    const entry = renderer.root.findByProps({ "data-testid": "exam-editor-entry-row", "data-editor-section-id": "cover-test" });
    act(() => entry.props.onClick());
    assert.equal(line(renderer.root, "cover-test").length, 1);
  } finally { renderer.unmount(); }
});

test("S2b2a G-FB4 persisted shelf marks still lose to projected data and registry unknown", () => {
  for (const id of ["iop", "wearing"]) {
    const renderer = create(<ExamOverviewBoard projection={afterSave()} editorEntries={inventory} refreshing={false}
      savedEditorIds={[]} viewState={{ collapsed: [id], shelved: [id] }} onOpenEditor={() => {}} onRefresh={() => {}} />);
    try {
      assert.equal(line(renderer.root, id).length, 1, `${id} must remain drawn`);
      assert.equal(line(renderer.root, id)[0]!.findAllByProps({ "data-testid": "exam-collapsed-line" }).length, 0);
    } finally { renderer.unmount(); }
  }
});
