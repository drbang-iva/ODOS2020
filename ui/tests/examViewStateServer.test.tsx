import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("S3b3 G6 rapid toggles coalesce and slow writes retain the final state", async () => {
  const module = await import("../src/lib/exam-view-state");
  assert.equal(typeof module.createExamViewStateWriter, "function", "debounced writer must exist");
  const writes: unknown[] = [];
  const request = (async (_input, init) => {
    const state = JSON.parse(String(init?.body));
    await pause(writes.length ? 5 : 60);
    writes.push(state);
    return new Response(JSON.stringify(state));
  }) as typeof fetch;
  const writer = module.createExamViewStateWriter("e1", request);
  for (let i = 0; i < 7; i++) writer.schedule({ collapsed: [String(i)], shelved: [] });
  await pause(400);
  await writer.flush();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { collapsed: ["6"], shelved: [] });
  writer.schedule({ collapsed: ["older"], shelved: [] });
  const first = writer.flush();
  writer.schedule({ collapsed: ["last"], shelved: [] });
  await Promise.all([first, writer.flush()]);
  assert.deepEqual(writes.at(-1), { collapsed: ["last"], shelved: [] });
});

test("S3b3 G8 server persistence never accesses browser localStorage", async () => {
  const module = await import("../src/lib/exam-view-state");
  let accesses = 0;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { accesses++; throw Error("old storage accessed"); } } });
  const state = { collapsed: ["iop"], shelved: [] };
  const request = (async () => new Response(JSON.stringify(state))) as typeof fetch;
  try {
    await module.saveExamViewState("e1", state, request);
    assert.deepEqual(await module.loadExamViewState("e1", request), state);
    assert.equal(accesses, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("S3b3 stale reads cannot replace a session toggle or leak across encounter navigation", async () => {
  const module = await import("../src/lib/exam-view-state");
  assert.equal(typeof module.useExamViewState, "function", "server view-state hook must exist");
  const pending: Array<(response: Response) => void> = [];
  const request = (() => new Promise<Response>(resolve => pending.push(resolve))) as typeof fetch;
  let current!: ReturnType<typeof module.useExamViewState>;
  function Host({ id }: { id: string }) { current = module.useExamViewState(id, request); return null; }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host id="e1" />); });
  try {
    act(() => current.change("collapse", "iop"));
    await act(async () => { pending.shift()!(new Response(JSON.stringify({ collapsed: [], shelved: ["cover-test"] }))); });
    assert.deepEqual(current.state, { collapsed: ["iop"], shelved: [] });
    await act(async () => { renderer.update(<Host id="e2" />); });
    assert.deepEqual(current.state, { collapsed: [], shelved: [] });
  } finally { act(() => renderer.unmount()); for (const resolve of pending) resolve(new Response("{}")); }
});

test("S3b3 G5 actual chart keeps a failed write in-session without changing its alert count", async () => {
  const { EncounterCharting } = await import("../src/scenes/EncounterCharting");
  const { RoleProvider } = await import("../src/lib/role-context");
  const { fhir } = await import("../src/lib/fhir");
  const { buildExamOverviewProjection } = await import("../../mcp/src/clinical-graph/exam-overview-projection");
  const { ExamOverviewBoard } = await import("../src/components/charting/ExamOverviewBoard");
  const originalFetch = globalThis.fetch, originalRead = fhir.read;
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  const projection = buildExamOverviewProjection({ encounterReference: "Encounter/e1", patientReference: "Patient/synthetic", examScope: "comprehensive", definitions: [], currentObservations: [], priorObservationCandidates: [], assessmentRows: [] });
  let writeAttempts = 0;
  fhir.read = (async () => ({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/synthetic" } })) as typeof fhir.read;
  const json = (body: unknown) => new Response(JSON.stringify(body));
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path.endsWith("/exam-view-state")) {
      if (init?.method === "PUT") { writeAttempts++; throw Error("synthetic write failure"); }
      return json({ collapsed: [], shelved: [] });
    }
    if (path.endsWith("/exam-overview")) return json(projection);
    if (path.endsWith("/exam-scope")) return json({ examScope: "comprehensive", canWrite: false });
    if (path.includes("finding-section-groups")) return json({ canWrite: false, groups: [], overrideGroupKeys: [], effectiveGroupKeys: [] });
    if (path.includes("finding-definitions") || path.includes("procedure-definitions")) return json({ canWrite: false, definitions: [] });
    if (path.includes("eye-growth/visibility")) return json({ defaultVisible: false });
    return json({ resourceType: "Bundle", type: "searchset", entry: [] });
  }) as typeof fetch;
  let renderer!: ReturnType<typeof create>;
  try {
    await act(async () => { renderer = create(<RoleProvider><EncounterCharting patient={{ resourceType: "Patient", id: "synthetic" }} encounterId="e1" /></RoleProvider>); await pause(20); });
    await act(async () => { renderer.root.findAllByType("button").find(b => b.children.join("") === "Overview")!.props.onClick(); await pause(20); });
    const before = renderer.root.findAllByProps({ role: "alert" }).length;
    assert.equal(before, 0);
    await act(async () => { renderer.root.findByType(ExamOverviewBoard).props.onCollapse("wearing"); await pause(400); });
    assert.equal(writeAttempts, 1);
    assert.deepEqual(renderer.root.findByType(ExamOverviewBoard).props.viewState.collapsed, ["wearing"]);
    assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, before);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch; fhir.read = originalRead;
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor); else Reflect.deleteProperty(globalThis, "document");
  }
});
