import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadDiagnosisImagingOpen,
  loadEncounterChartView,
  saveDiagnosisImagingOpen,
  saveEncounterChartView,
} from "../src/lib/diagnosis-workspace-preferences";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import {
  diagnosisCatalogKey,
  movePinnedDiagnosis,
  orderedEncounterConditions,
} from "../src/components/charting/DiagnosisWorkspace";

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
