import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { StructureDefinition } from "@medplum/fhirtypes";
import { buildHistoryItemReview } from "../src/clinical-graph/history-answer-observation.js";

for (const [suffix, type, max] of [["method", "code", "1"], ["target", "string", "*"]] as const) {
  test(`emitted review ${suffix} resolves to a registered R4 Observation extension`, async () => {
    const act = buildHistoryItemReview({ patientReference: "Patient/test", encounterReference: "Encounter/test", actorReference: "Practitioner/test",
      recordedAt: "2026-09-04T12:00:00Z", gestureId: "00000000-0000-4000-8000-000000000001", sectionKey: "social-history", method: "individual",
      targets: [{ sectionKey: "social-history", sectionId: "tobacco" }, { sectionKey: "social-history", sectionId: "occupation" }] });
    const url = `https://odos2020.com/fhir/StructureDefinition/odos-history-review-${suffix}`;
    const emitted = act.extension!.filter(e => e.url === url);
    assert.equal(emitted.length, suffix === "target" ? 2 : 1);
    const directory = resolve(import.meta.dirname, "../../data/canonical-extensions");
    const registry = JSON.parse(await readFile(resolve(directory, "registry.json"), "utf8"));
    assert.equal(registry.extensions.filter((e: any) => e.url === url && e.status === "active").length, 1, "Emitted extension must have exactly one active registry entry");
    const definition = JSON.parse(await readFile(resolve(directory, `${url.split("/").at(-1)}.json`), "utf8")) as StructureDefinition;
    assert.equal(definition.resourceType, "StructureDefinition");
    assert.equal(definition.url, url);
    assert.equal(definition.fhirVersion, "4.0.1");
    assert.equal(definition.type, "Extension");
    assert.equal(definition.baseDefinition, "http://hl7.org/fhir/StructureDefinition/Extension");
    assert.deepEqual(definition.context, [{ type: "element", expression: "Observation" }]);
    const elements = definition.differential!.element!;
    assert.equal(elements.find(e => e.id === "Extension")?.max, max);
    assert.equal(elements.find(e => e.id === "Extension.extension")?.max, "0");
    assert.equal(elements.find(e => e.id === "Extension.url")?.fixedUri, url);
    const value = elements.find(e => e.id === "Extension.value[x]")!;
    assert.equal(value.min, 1); assert.equal(value.max, "1"); assert.deepEqual(value.type, [{ code: type }]);
    for (const extension of emitted) assert.equal(typeof (type === "code" ? extension.valueCode : extension.valueString), "string");
  });
}
