import assert from "node:assert/strict";
import { test } from "node:test";
import React, { useState } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { ExamOverviewBoard, UNFORMATTED_FINDING_VALUE, type ExamOverviewProjection } from "../src/components/charting/ExamOverviewBoard";
import { chartEditorInventory } from "../src/components/charting/SpineNav";
import { buildExamOverviewProjection } from "../../mcp/src/clinical-graph/exam-overview-projection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const inventory = chartEditorInventory();
const empty = () => buildExamOverviewProjection({ encounterReference: "Encounter/synthetic-view", patientReference: "Patient/synthetic",
  examScope: "comprehensive", definitions: [], currentObservations: [], priorObservationCandidates: [], assessmentRows: [] });
const recorded = () => ({ ...empty(), findings: [{ observationReference: "Observation/synthetic-iop", findingKey: "intraocular_pressure",
  sectionKey: "tonometry", display: "IOP", laterality: "OD", examination: { state: "examined", sourceEncoding: "observation" },
  interpretation: "unknown", provenance: { state: "current" }, current: { value: { kind: "number", value: 17 }, components: [] } }] } as ExamOverviewProjection);
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === "string" ? child : text(child)).join(" ");
const line = (root: ReactTestInstance, id: string) => root.findAll(node => typeof node.type === "string" && node.props["data-drawn-editor-id"] === id)[0];
const control = (root: ReactTestInstance, action: string, id: string) => root.findByProps({ "data-exam-view-action": action, "data-editor-id": id });
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

async function viewModule() {
  const module = await import("../src/lib/exam-view-state").catch(() => undefined);
  assert.ok(module, "per-encounter exam view state must exist");
  return module;
}

test("S2b2a G10 storage is scoped by encounter and malformed or inaccessible storage opens everything", async () => {
  const { loadExamViewState, saveExamViewState } = await viewModule();
  const store = storage();
  saveExamViewState("one", { collapsed: ["iop"], shelved: ["cover-test"] }, store);
  assert.equal(store.getItem("odos:exam-view:v1:one"), '{"collapsed":["iop"],"shelved":["cover-test"]}');
  assert.deepEqual(loadExamViewState("one", store), { collapsed: ["iop"], shelved: ["cover-test"] });
  assert.deepEqual(loadExamViewState("two", store), { collapsed: [], shelved: [] });
  for (const raw of ["broken json", "null", '{"collapsed":[1],"shelved":[]}', '{"collapsed":[],"shelved":"iop"}']) {
    store.setItem("odos:exam-view:v1:one", raw);
    assert.deepEqual(loadExamViewState("one", store), { collapsed: [], shelved: [] });
  }
  for (const unavailable of [null, { getItem() { throw Error("read denied"); }, setItem() { throw Error("write denied"); } }]) {
    assert.deepEqual(loadExamViewState("one", unavailable), { collapsed: [], shelved: [] });
    assert.doesNotThrow(() => saveExamViewState("one", { collapsed: ["iop"], shelved: [] }, unavailable));
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { throw Error("storage getter denied"); } } });
  try {
    assert.deepEqual(loadExamViewState("one"), { collapsed: [], shelved: [] });
    assert.doesNotThrow(() => saveExamViewState("one", { collapsed: [], shelved: [] }));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

async function harness(projection = recorded(), store: ReturnType<typeof storage> | null = storage(), initial?: { collapsed: string[]; shelved: string[] }) {
  const { loadExamViewState, saveExamViewState, changeExamViewState } = await viewModule();
  const calls = { refresh: 0, groupWrite: 0, open: [] as string[] };
  function Host() {
    const [state, setState] = useState(() => initial ?? loadExamViewState("synthetic-view", store));
    const change = (action: "collapse" | "expand" | "shelve" | "open", id: string) => setState(previous => {
      const next = changeExamViewState(previous, action, id);
      saveExamViewState("synthetic-view", next, store);
      return next;
    });
    return <ExamOverviewBoard projection={projection} editorEntries={inventory} refreshing={false}
      viewState={state} onCollapse={id => change("collapse", id)} onExpand={id => change("expand", id)} onShelve={id => change("shelve", id)}
      onOpenEditor={id => { calls.open.push(id); change("open", id); }}
      onRefresh={() => { calls.refresh++; }} onAddSectionGroup={() => { calls.groupWrite++; }} />;
  }
  return { renderer: create(<Host />), calls, store, Host };
}

test("S2b2a G3 collapsed data stays in order, summarizes values, survives remount and expands", async () => {
  const h = await harness();
  try {
    const row = h.renderer.root.findByProps({ "data-section-key": "pretest" });
    const ids = () => row.findAll(node => typeof node.type === "string" && node.props["data-drawn-editor-id"]).map(node => node.props["data-drawn-editor-id"]);
    const before = ids();
    act(() => control(h.renderer.root, "collapse", "iop").props.onClick());
    assert.deepEqual(ids(), before);
    assert.match(text(line(h.renderer.root, "iop")), /collapsed.*17|17.*collapsed/);
    assert.match(line(h.renderer.root, "iop").findByProps({ "data-testid": "exam-collapsed-line" }).props["aria-label"], /collapsed.*Has findings this visit.*17/);
    assert.equal(line(h.renderer.root, "iop").props["data-holds-data"], "true");
    assert.equal(line(h.renderer.root, "iop").findAllByProps({ "data-testid": "exam-finding-row" }).length, 0);
    h.renderer.unmount();
    h.renderer = create(<h.Host />);
    assert.match(text(line(h.renderer.root, "iop")), /collapsed/);
    act(() => control(h.renderer.root, "expand", "iop").props.onClick());
    assert.equal(line(h.renderer.root, "iop").findAllByProps({ "data-testid": "exam-finding-row" }).length, 1);
  } finally { h.renderer.unmount(); }
});

test("S2b2a G2 G7 view controls never fetch or call chart mutation props; shelf opening restores the line", async () => {
  const h = await harness();
  const fetchBefore = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error("view state made a request"); };
  try {
    act(() => control(h.renderer.root, "collapse", "iop").props.onClick());
    act(() => control(h.renderer.root, "expand", "iop").props.onClick());
    act(() => control(h.renderer.root, "shelve", "cover-test").props.onClick());
    assert.equal(line(h.renderer.root, "cover-test"), undefined);
    const shelf = h.renderer.root.findByProps({ "data-shelf-group": "pretest" });
    const entry = shelf.findByProps({ "data-testid": "exam-editor-entry-row", "data-editor-section-id": "cover-test" });
    assert.equal(requests, 0);
    assert.deepEqual(h.calls, { refresh: 0, groupWrite: 0, open: [] });
    act(() => entry.props.onClick());
    assert.ok(line(h.renderer.root, "cover-test"));
    assert.deepEqual(h.calls.open, ["cover-test"]);
    assert.equal(JSON.parse(h.store!.getItem("odos:exam-view:v1:synthetic-view")!).shelved.length, 0);
  } finally { globalThis.fetch = fetchBefore; h.renderer.unmount(); }
});

test("S2b2a G6 persisted shelving loses to saved data and unknown evidence, even outside scope", async () => {
  for (const id of ["iop", "wearing"]) {
    const p = recorded(); p.examScope = "office-visit"; p.completeness.trace = [];
    const h = await harness(p, storage(), { collapsed: [id], shelved: [id] });
    try {
      assert.ok(line(h.renderer.root, id), `${id} must draw despite persisted shelving`);
      assert.doesNotMatch(text(line(h.renderer.root, id)), /collapsed/);
    } finally { h.renderer.unmount(); }
  }
});

test("S2b2a G10 absent and throwing storage keeps the board open and collapse works in-session", async () => {
  for (const store of [null, { getItem() { throw Error("read denied"); }, setItem() {} },
    { getItem() { return null; }, setItem() { throw Error("full"); } }]) {
    const h = await harness(recorded(), store);
    try {
      assert.doesNotMatch(text(line(h.renderer.root, "iop")), /collapsed/);
      act(() => control(h.renderer.root, "collapse", "iop").props.onClick());
      assert.match(text(line(h.renderer.root, "iop")), /collapsed/);
    } finally { h.renderer.unmount(); }
  }
});

test("S2b2a G3 collapsed empty rows stay drawn, unmapped values use the fallback, and the editor still opens", async () => {
  const p = recorded();
  p.findings[0]!.current = { components: [] };
  const h = await harness(p);
  try {
    act(() => control(h.renderer.root, "collapse", "iop").props.onClick());
    assert.match(text(line(h.renderer.root, "iop")), new RegExp(UNFORMATTED_FINDING_VALUE));
    act(() => line(h.renderer.root, "iop").findByProps({ "data-testid": "exam-collapsed-line" }).props.onClick());
    assert.deepEqual(h.calls.open, ["iop"]);
    assert.equal(line(h.renderer.root, "iop").findAllByProps({ "data-testid": "exam-collapsed-line" }).length, 0);
    act(() => control(h.renderer.root, "collapse", "wearing").props.onClick());
    assert.match(text(line(h.renderer.root, "wearing")), /collapsed.*Open editor to review/);
  } finally { h.renderer.unmount(); }
});

test("S2b2a G2 active empty sheets cannot be shelved; collapsed preferences do not draw an absent line", () => {
  const p = empty(); p.examScope = "office-visit"; p.completeness.trace = [];
  const renderer = create(<ExamOverviewBoard projection={p} editorEntries={inventory} refreshing={false}
    activeEditorId="cover-test" viewState={{ collapsed: ["auto-refraction"], shelved: [] }}
    onOpenEditor={() => {}} onRefresh={() => {}} onShelve={() => {}} />);
  try {
    assert.equal(control(renderer.root, "shelve", "cover-test").props.disabled, true);
    assert.equal(line(renderer.root, "auto-refraction"), undefined);
  } finally { renderer.unmount(); }
});
