import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  loadDiagnosisImagingOpen,
  loadEncounterChartView,
  saveDiagnosisImagingOpen,
  saveEncounterChartView,
} from "../src/lib/diagnosis-workspace-preferences";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import {
  conditionMatchesDiagnosisPick,
  diagnosisCatalogKey,
  diagnosisPinMoveDisabled,
  diagnosisRankActionsDisabled,
  diagnosisWorkspaceInstanceKey,
  movePinnedDiagnosis,
  orderedEncounterConditions,
} from "../src/components/charting/DiagnosisWorkspace";
import { DiagnosisImagingRegion } from "../src/components/charting/DiagnosisImagingRegion";

test("diagnosis workspace preferences default safely and round-trip valid selections", () => {
  const storage = memoryStorage();

  assert.equal(loadEncounterChartView(storage), "diagnosis");
  assert.equal(loadDiagnosisImagingOpen(storage), true);

  saveEncounterChartView("structure", storage);
  saveDiagnosisImagingOpen(false, storage);
  assert.equal(loadEncounterChartView(storage), "structure");
  assert.equal(loadDiagnosisImagingOpen(storage), false);

  storage.setItem("odos:encounter-chart-view", "future-view");
  storage.setItem("odos:diagnosis-imaging-open", "maybe");
  assert.equal(loadEncounterChartView(storage), "diagnosis");
  assert.equal(loadDiagnosisImagingOpen(storage), true);
});

test("diagnosis rail follows Encounter.diagnosis rank order without normalizing gaps", () => {
  const conditions = [condition("second", "Second"), condition("first", "First"), condition("unlinked", "Unlinked")];
  const encounter = {
    resourceType: "Encounter",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    diagnosis: [
      { condition: { reference: "Condition/second" }, rank: 8 },
      { condition: { reference: "Condition/first" }, rank: 3 },
    ],
  } satisfies Encounter;

  assert.deepEqual(orderedEncounterConditions(encounter, conditions).map((row) => row.id), ["first", "second"]);
  assert.deepEqual(encounter.diagnosis?.map((row) => row.rank), [8, 3]);
});

test("catalog identity and pin reorder are explicit and stable", () => {
  const row = condition("c1", "Presbyopia");
  row.identifier = [{
    system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
    value: "encounter-1::presbyopia::none",
  }];

  assert.equal(diagnosisCatalogKey(row), "presbyopia");
  assert.deepEqual(movePinnedDiagnosis(["myopia", "presbyopia", "hyperopia"], "presbyopia", -1), [
    "presbyopia", "myopia", "hyperopia",
  ]);
  assert.deepEqual(movePinnedDiagnosis(["myopia"], "myopia", -1), ["myopia"]);
});

test("laterality-required diagnosis identity keeps OD, OS, and OU picks distinct", () => {
  const existingOs = condition("c1", "Myopia");
  existingOs.identifier = [{
    system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
    value: "encounter-1::myopia::left",
  }];
  const row = {
    stableKey: "myopia",
    display: "Myopia",
    lateralityRequired: true,
    pinned: false,
    tallyCount: 0,
  };

  assert.equal(conditionMatchesDiagnosisPick(existingOs, row, "OS"), true);
  assert.equal(conditionMatchesDiagnosisPick(existingOs, row, "OD"), false);
  assert.equal(conditionMatchesDiagnosisPick(existingOs, row, "OU"), false);
  assert.equal(conditionMatchesDiagnosisPick(existingOs, row), false);
});

test("diagnosis workspace remount identity changes at either patient or encounter boundary", () => {
  assert.notEqual(
    diagnosisWorkspaceInstanceKey("Patient/one", "Encounter/one"),
    diagnosisWorkspaceInstanceKey("Patient/two", "Encounter/one"),
  );
  assert.notEqual(
    diagnosisWorkspaceInstanceKey("Patient/one", "Encounter/one"),
    diagnosisWorkspaceInstanceKey("Patient/one", "Encounter/two"),
  );
});

test("diagnosis rank actions are disabled for read-only users and while a write is busy", () => {
  assert.equal(diagnosisRankActionsDisabled(false, undefined), true);
  assert.equal(diagnosisRankActionsDisabled(false, "rank"), true);
  assert.equal(diagnosisRankActionsDisabled(true, "rank"), true);
  assert.equal(diagnosisRankActionsDisabled(true, undefined), false);
});

test("diagnosis pin moves require write access and respect the ordered-list edges", () => {
  assert.equal(diagnosisPinMoveDisabled(false, undefined, 1, 3, -1), true);
  assert.equal(diagnosisPinMoveDisabled(false, undefined, 1, 3, 1), true);
  assert.equal(diagnosisPinMoveDisabled(true, undefined, 1, 3, -1), false);
  assert.equal(diagnosisPinMoveDisabled(true, undefined, 1, 3, 1), false);
  assert.equal(diagnosisPinMoveDisabled(true, undefined, 0, 3, -1), true);
  assert.equal(diagnosisPinMoveDisabled(true, undefined, 2, 3, 1), true);
});

test("imaging hides the prior patient's rows as soon as the patient reference changes", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFirst!: (response: Response) => void;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("Patient%2Fone")) {
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    }
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisImagingRegion patientReference="Patient/one" />);
    });
    await act(async () => {
      resolveFirst(new Response(JSON.stringify({ images: [{
        id: "old-image",
        title: "Prior patient OCT",
        date: "2026-08-09",
        contentState: "missing",
      }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await Promise.resolve();
    });
    assert.match(JSON.stringify(renderer.toJSON()), /Prior patient OCT/);

    act(() => renderer.update(<DiagnosisImagingRegion patientReference="Patient/two" />));
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Prior patient OCT/);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function condition(id: string, display: string): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/p1" },
    code: { text: display },
  };
}
