import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { Observation, Provenance } from "@medplum/fhirtypes";
import { buildFindingDefinitionSeeds } from "../../mcp/src/clinical-graph/finding-definition-store.js";
import { customFieldEntries } from "../../mcp/src/clinical-graph/custom-fields.js";
import { handleCustomSectionCaptureRequest, type CustomSectionEndpointDeps } from "../../mcp/src/clinical-graph/custom-section-endpoint.js";
import { OcularHealthSection, applyAnteriorAllNormal, applyPosteriorAllNormal, type EyeCapture, type NegativeAct } from "../src/components/charting/OcularHealthSection";
import type { CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";

const seeds = buildFindingDefinitionSeeds();
const definitions: CustomFindingDefinition[] = seeds.map((definition) => ({
  stableKey: definition.stableKey,
  sectionKey: definition.sectionKey,
  display: definition.display,
  active: definition.active,
  perEye: definition.valueSchema.perEye === true,
  customFields: customFieldEntries(definition, true),
  normalTemplate: definition.normalSemantics?.template as string | undefined,
  allowDeferred: definition.normalSemantics?.allowDeferred === true,
}));
const stainingKey = "dry-eye:conjunctival-staining";
const ocularDefinitions = definitions.filter((definition) => definition.stableKey.startsWith("ocular-health:") || definition.stableKey === stainingKey);
const emptyEye = (): EyeCapture => ({ selections: [], other: "" });

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map((child) => text(child)).join("");
}

test("SWEEP-1 guard 1 REAL SEED: Anterior All Normal posts only requests accepted by the real capture handler", async () => {
  const writes: Array<Observation | Provenance> = [];
  const deps: CustomSectionEndpointDeps = {
    findingDefinitions: () => seeds,
    authenticate: async () => ({
      staffReference: "Practitioner/sweep-test", actorRole: "provider",
      fhir: {
        search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
        create: async (resource) => {
          const saved = { ...resource, id: `sweep-${writes.length + 1}` };
          writes.push(saved);
          return saved;
        },
      },
    }),
  };
  const posts: Array<{ key: string; body: { eyes: Record<string, { negativeAct: NegativeAct }> }; status: number; response: unknown }> = [];
  const fetchImpl = (async (input, init) => {
    if (init?.method !== "POST") return Response.json({ rows: [] });
    const key = decodeURIComponent(String(input).split("/").at(-1)!);
    const body = JSON.parse(String(init.body));
    const result = await handleCustomSectionCaptureRequest(deps, {
      authHeader: undefined, params: { stableKey: key }, body,
    });
    posts.push({ key, body, status: result.status, response: result.body });
    return Response.json(result.body, { status: result.status });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection definitions={ocularDefinitions}
        patientReference="Patient/sweep-test" encounterReference="Encounter/sweep-test"
        onSaved={() => undefined} apiBase="http://synthetic" fetchImpl={fetchImpl} />);
    });
    const button = (label: string) => renderer.root.findAllByType("button").find((node) => text(node) === label)!;
    act(() => button("Anterior All Normal").props.onClick());
    await act(async () => button("Save Ocular Health").props.onClick());
    assert.ok(posts.length > 0);
    assert.deepEqual(posts.filter((post) => post.status !== 200), [], "every posted request must be accepted");
    assert.equal(posts.length, 9);
    assert.ok(posts.every((post) => post.key !== stainingKey));
    for (const post of posts) {
      for (const eye of ["OD", "OS"]) assert.ok(post.body.eyes[eye].negativeAct.optionCodes.length > 0);
    }
    assert.equal(writes.filter((resource) => resource.resourceType === "Observation").length, 18);
    assert.doesNotMatch(text(renderer.root), /Surface Staining failed/);
  } finally { act(() => renderer?.unmount()); }
});

for (const [segment, sweep] of [["anterior", applyAnteriorAllNormal], ["posterior", applyPosteriorAllNormal]] as const) {
  test(`SWEEP-1 guard 2 FIXTURE: unseen ${segment} value-only definition is untouched`, () => {
    const novel = { ...definitions.find((definition) => definition.stableKey === stainingKey)!,
      stableKey: `ocular-health:${segment}:unseen-measurement`, display: "Unseen measurement" };
    assert.ok(novel.customFields.length > 0);
    assert.ok(novel.customFields.every((field) => field.valueType !== "multi-select"));
    const row = { OD: emptyEye(), OS: { ...emptyEye(), grades: { [novel.customFields[0]!.localCode]: "grade-2" } } };
    const captures = { [novel.stableKey]: row };
    const before = structuredClone(captures);
    const result = sweep([...ocularDefinitions, novel], captures);
    assert.strictEqual(result.captures[novel.stableKey], row, "value-only row must not be swept or cloned");
    assert.deepEqual(result.captures[novel.stableKey], before[novel.stableKey]);
    assert.deepEqual(captures, before, "input remains unchanged");
    assert.equal(sweep([novel], {}).captures[novel.stableKey], undefined);
  });
}

test("SWEEP-1 guard 3 REAL SEED: all 14 ordinary structures sweep both eyes with the frozen active scope", () => {
  const ordinary = ocularDefinitions.filter((definition) => definition.stableKey.startsWith("ocular-health:"));
  assert.equal(ordinary.length, 14);
  const anterior = applyAnteriorAllNormal(ocularDefinitions, {});
  const posterior = applyPosteriorAllNormal(ocularDefinitions, {});
  assert.equal(anterior.filled, 18);
  assert.equal(posterior.filled, 10);
  assert.equal(anterior.skipped + posterior.skipped, 0);
  const rows = { ...anterior.captures, ...posterior.captures };
  assert.equal(Object.keys(rows).length, 14);
  for (const definition of ordinary) {
    const expectedScope = definition.customFields.filter((field) => field.valueType === "multi-select")
      .flatMap((field) => (field.options ?? []).filter((option) => option.active).map((option) => option.code));
    assert.ok(expectedScope.length > 0);
    for (const eye of ["OD", "OS"] as const) {
      const capture = rows[definition.stableKey]?.[eye];
      assert.equal(capture?.state, "normal", `${definition.stableKey} ${eye} must sweep`);
      assert.deepEqual(capture.negativeAct?.optionCodes, expectedScope);
      assert.equal(capture.negativeAct?.eye, eye);
      assert.equal(capture.negativeAct?.definitionStableKey, definition.stableKey);
      assert.deepEqual(capture.grades ?? {}, {}, "sweep must not invent measurements");
    }
  }
});

test("SWEEP-1 guard 4 REAL SEED: Surface Staining has only values and remains untouched", () => {
  const staining = ocularDefinitions.find((definition) => definition.stableKey === stainingKey)!;
  assert.ok(staining.customFields.length > 0);
  assert.ok(staining.customFields.every((field) => ["select", "number", "string"].includes(field.valueType)));
  const row = { OD: emptyEye(), OS: emptyEye() };
  const result = applyAnteriorAllNormal(ocularDefinitions, { [stainingKey]: row });
  assert.strictEqual(result.captures[stainingKey], row);
  assert.deepEqual(row, { OD: emptyEye(), OS: emptyEye() });
  assert.equal(applyAnteriorAllNormal(ocularDefinitions, {}).captures[stainingKey], undefined);
});
