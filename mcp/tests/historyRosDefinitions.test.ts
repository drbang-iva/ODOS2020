import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildHistoryItemRetraction } from "../src/clinical-graph/history-answer-observation.js";

for (const field of ["code", "valueCodeableConcept"] as const) test(`retraction ${field} has a registered canonical application code definition`, async () => {
  const act = buildHistoryItemRetraction({ patientReference: "Patient/test", encounterReference: "Encounter/test", actorReference: "Practitioner/test",
    recordedAt: "2026-09-05T12:00:00Z", gestureId: "00000000-0000-4000-8000-000000000001", sectionKey: "review-of-systems",
    targets: [{ sectionKey: "review-of-systems", sectionId: "systems", optionCode: "eye-pain" }], retracts: "Observation/original" });
  const coding = act[field]!.coding![0];
  const directory = resolve(import.meta.dirname, "../../data/terminology");
  const registry = JSON.parse(await readFile(resolve(directory, "history-review-registry.json"), "utf8"));
  const entries = registry.codeSystems.filter((row: any) => row.url === coding.system && row.status === "active");
  assert.equal(entries.length, 1, "Emitted code system must be registered exactly once");
  const definition = JSON.parse(await readFile(resolve(directory, entries[0].file), "utf8"));
  assert.equal(definition.resourceType, "CodeSystem"); assert.equal(definition.url, coding.system);
  assert.equal(definition.status, "active"); assert.equal(definition.content, "complete");
  const concept = definition.concept.find((row: any) => row.code === coding.code);
  assert.ok(concept?.definition); assert.equal(concept.display, coding.display);
});
