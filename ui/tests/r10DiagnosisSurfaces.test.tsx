import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { EncounterFindingOverlay } from "../src/components/charting/EncounterFindingOverlay";
import { DiagnosisPicker } from "../src/components/charting/DiagnosisPicker";
import "./r10A3ReleaseScenarios.test";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (node: any): string => typeof node === "string" ? node : (node.children ?? []).map(text).join("");

test("W49 overlay shows Findings unavailable for typed and rejected loads", async () => {
  for (const reject of [false, true]) {
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<EncounterFindingOverlay encounterReference="Encounter/e1" sectionKey="ocular-health" loadPayload={async () => {
          if (reject) throw new Error("synthetic unavailable");
          return { result: "unavailable", kind: "upstream", error: "synthetic unavailable" };
        }} />);
        await flush();
      });
      assert.match(JSON.stringify(renderer.toJSON()), /Findings unavailable/);
    } finally { act(() => renderer?.unmount()); }
  }
});
for (const definition of ["ocular_health", "cup_disc_ratio"]) {
  test(`W51 default legacy ${definition} pick omits supportingFacts`, async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
    const requests: any[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("diagnosis-candidates")) return Response.json({ findings: [{ findingInstanceId: "finding-1", findingDefinitionKey: definition, observationReference: "Observation/finding-1", candidates: [{ diagnosisKey: "synthetic", display: "Synthetic diagnosis", codingStatus: "provisional", priority: true, source: "rule", supportingFacts: [{ rowKey: "fact-1", key: { eye: "OD" }, baseline: { kind: "canonical", reference: "Observation/finding-1", versionId: "1" } }] }] }] });
      if (url.includes("diagnosis-catalog")) return Response.json({ canWriteDiagnosis: true, diagnoses: [] });
      if (url.includes("diagnosis-picks")) { requests.push(JSON.parse(String(init?.body))); return Response.json({ result: "pick", conditionStep: "applied", link: "not-applicable", condition: { resourceType: "Condition", id: "c1" } }); }
      throw new Error(`Unexpected ${url}`);
    };
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<DiagnosisPicker encounterReference="Encounter/e1" findingDefinitionKey={definition} observationReferences={["Observation/finding-1"]} />); await flush(); });
      act(() => renderer.root.findAllByType("button").find((node) => text(node).includes("dx ▾"))!.props.onClick());
      await act(async () => { await renderer.root.findAllByType("button").find((node) => text(node) === "Possible")!.props.onClick(); });
      assert.equal(requests.length, 1);
      assert.equal("supportingFacts" in requests[0], false);
      assert.equal("commandId" in requests[0], false);
    } finally {
      act(() => renderer?.unmount()); globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  });
}
test("Legacy picker preserves candidate load failure text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "synthetic unavailable" }, { status: 502 });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<DiagnosisPicker encounterReference="Encounter/e1" />); await flush(); });
    assert.match(JSON.stringify(renderer.toJSON()), /synthetic unavailable/);
  } finally { act(() => renderer?.unmount()); globalThis.fetch = originalFetch; }
});

test("W49 encounter scene preserves unavailable unassigned count", async () => {
  const { EncounterCharting } = await import("../src/scenes/EncounterCharting");
  const { RoleProvider } = await import("../src/lib/role-context");
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => undefined;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/findings")) return Response.json({ result: "unavailable", kind: "upstream", error: "Synthetic unavailable" }, { status: 502 });
    return Response.json({ error: "Synthetic unrelated route" }, { status: 503 });
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<RoleProvider><EncounterCharting patient={{ resourceType: "Patient", id: "p1" }} encounterId="e1" /></RoleProvider>); await flush(); });
    assert.match(JSON.stringify(renderer.toJSON()), /Unassigned unavailable/);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /0 unassigned/);
  } finally { act(() => renderer?.unmount()); globalThis.fetch = originalFetch; console.error = originalError; }
});
