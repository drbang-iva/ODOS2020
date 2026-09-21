import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
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
  const requests: Array<{ path: string; method: string }> = [];
  const request = (async (input, init) => {
    const path = String(input), method = init?.method ?? "GET";
    requests.push({ path, method });
    if (method === "PUT") values.set(path, String(init?.body));
    return new Response(values.get(path) ?? '{"collapsed":[],"shelved":[]}');
  }) as typeof fetch;
  return { values, requests, request };
};
const endpoint = (id: string) => `/clinical-graph/encounters/${id}/exam-view-state`;
const settleWrites = () => new Promise(resolve => setTimeout(resolve, 350));

async function viewModule() {
  const module = await import("../src/lib/exam-view-state").catch(() => undefined);
  assert.ok(module, "per-encounter exam view state must exist");
  return module;
}

test("S2b2a G10 server state is scoped by encounter and malformed or inaccessible responses open everything", async () => {
  const { loadExamViewState, saveExamViewState } = await viewModule();
  const store = storage();
  await saveExamViewState("one", { collapsed: ["iop"], shelved: ["cover-test"] }, store.request);
  assert.equal(store.values.get(endpoint("one")), '{"collapsed":["iop"],"shelved":["cover-test"]}');
  assert.deepEqual(await loadExamViewState("one", store.request), { collapsed: ["iop"], shelved: ["cover-test"] });
  assert.deepEqual(await loadExamViewState("two", store.request), { collapsed: [], shelved: [] });
  for (const raw of ["broken json", "null", '{"collapsed":[1],"shelved":[]}', '{"collapsed":[],"shelved":"iop"}']) {
    store.values.set(endpoint("one"), raw);
    assert.deepEqual(await loadExamViewState("one", store.request), { collapsed: [], shelved: [] });
  }
  for (const unavailable of [async () => new Response("", { status: 503 }), async () => { throw Error("network denied"); }]) {
    assert.deepEqual(await loadExamViewState("one", unavailable), { collapsed: [], shelved: [] });
    await assert.doesNotReject(saveExamViewState("one", { collapsed: ["iop"], shelved: [] }, unavailable));
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { throw Error("storage getter denied"); } } });
  try {
    store.values.delete(endpoint("one"));
    assert.deepEqual(await loadExamViewState("one", store.request), { collapsed: [], shelved: [] });
    await assert.doesNotReject(saveExamViewState("one", { collapsed: [], shelved: [] }, store.request));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

async function harness(projection = recorded(), store = storage(), initial?: { collapsed: string[]; shelved: string[] }) {
  const { useExamViewState } = await viewModule();
  if (initial) store.values.set(endpoint("synthetic-view"), JSON.stringify(initial));
  const calls = { refresh: 0, groupWrite: 0, open: [] as string[] };
  function Host() {
    const { state, change } = useExamViewState("synthetic-view", store.request);
    return <ExamOverviewBoard projection={projection} editorEntries={inventory} refreshing={false}
      viewState={state} onCollapse={id => change("collapse", id)} onExpand={id => change("expand", id)} onShelve={id => change("shelve", id)}
      onOpenEditor={id => { calls.open.push(id); change("open", id); }}
      onRefresh={() => { calls.refresh++; }} onAddSectionGroup={() => { calls.groupWrite++; }} />;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); });
  return { renderer, calls, store, Host };
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
    await act(async () => { await settleWrites(); h.renderer.unmount(); });
    await act(async () => { h.renderer = create(<h.Host />); });
    assert.match(text(line(h.renderer.root, "iop")), /collapsed/);
    act(() => control(h.renderer.root, "expand", "iop").props.onClick());
    assert.equal(line(h.renderer.root, "iop").findAllByProps({ "data-testid": "exam-finding-row" }).length, 1);
  } finally { h.renderer.unmount(); }
});

test("S2b2a G2 G7 view controls only persist preferences, never call chart mutation props; shelf opening restores the line", async () => {
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
    await act(async () => { await settleWrites(); });
    assert.equal(JSON.parse(h.store.values.get(endpoint("synthetic-view"))!).shelved.length, 0);
    assert.ok(h.store.requests.every(r => r.path === endpoint("synthetic-view") && ["GET", "PUT"].includes(r.method)));
  } finally { globalThis.fetch = fetchBefore; h.renderer.unmount(); }
});

test("S3b3 G3 S2b2a G6 persisted shelving loses to saved data and unknown evidence, even outside scope", async () => {
  for (const id of ["iop", "wearing"]) {
    const p = recorded(); p.examScope = "office-visit"; p.completeness.trace = [];
    const h = await harness(p, storage(), { collapsed: [id], shelved: [id] });
    try {
      assert.ok(line(h.renderer.root, id), `${id} must draw despite persisted shelving`);
      assert.doesNotMatch(text(line(h.renderer.root, id)), /collapsed/);
    } finally { h.renderer.unmount(); }
  }
});

test("S3b3 G4 S2b2a G10 unavailable server keeps the board open and collapse works in-session", async () => {
  for (const request of [async () => new Response("", { status: 503 }), async () => { throw Error("network denied"); },
    async (_input: unknown, init?: RequestInit) => { if (init?.method === "PUT") throw Error("write denied"); return new Response('{"collapsed":[],"shelved":[]}'); }]) {
    const store = { ...storage(), request: request as typeof fetch };
    const h = await harness(recorded(), store);
    try {
      assert.doesNotMatch(text(line(h.renderer.root, "iop")), /collapsed/);
      act(() => control(h.renderer.root, "collapse", "iop").props.onClick());
      assert.match(text(line(h.renderer.root, "iop")), /collapsed/);
      await act(async () => { await settleWrites(); });
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
