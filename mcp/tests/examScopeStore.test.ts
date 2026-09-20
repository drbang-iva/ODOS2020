import assert from "node:assert/strict";
import { test } from "node:test";
import { FhirEncounterExamScopeStore } from "../src/clinical-graph/exam-scope-store.js";
import type { ExamOverviewFhirClient } from "../src/clinical-graph/exam-overview-endpoint.js";
import type { Basic } from "@medplum/fhirtypes";

function harness() {
  let saved: Basic | undefined;
  let version = 0;
  const calls: Array<{ method: string; headers: Record<string, string> | undefined }> = [];
  const fhir = {
    baseUrl: "http://localhost/",
    async search() { return { resourceType: "Bundle", type: "searchset", entry: saved ? [{ resource: structuredClone(saved) }] : [] }; },
    async create(resource: Basic, headers?: Record<string, string>) {
      calls.push({ method: "create", headers });
      if (!saved) saved = { ...structuredClone(resource), id: "scope", meta: { versionId: String(++version) } };
      return structuredClone(saved);
    },
    async update(_type: string, _id: string, resource: Basic, headers?: Record<string, string>) {
      calls.push({ method: "update", headers });
      if (headers?.["If-Match"] !== `W/"${version}"`) throw Object.assign(new Error("version conflict"), { status: 412 });
      saved = { ...structuredClone(resource), meta: { versionId: String(++version) } };
      return structuredClone(saved);
    },
  } as unknown as ExamOverviewFhirClient;
  return { fhir, calls, store: new FhirEncounterExamScopeStore(fhir), saved: () => saved! };
}

test("S2a scope store guards first creation and versioned edits", async () => {
  const h = harness();
  assert.deepEqual(await h.store.get("e1"), { examScope: "comprehensive" });
  await h.store.set("e1", "office-visit", { reference: "Practitioner/doc" }, null);
  assert.ok(h.calls[0].headers?.["If-None-Exist"]?.startsWith("identifier="));
  const saved = await h.store.get("e1");
  assert.equal(saved.versionId, "1");
  await h.store.set("e1", "comprehensive", { reference: "Practitioner/doc2" }, "1");
  assert.deepEqual(h.calls[1].headers, { "If-Match": 'W/"1"' });
  await assert.rejects(h.store.set("e1", "office-visit", { reference: "Practitioner/doc" }, "1"), /concurrently/);
  assert.equal((await h.store.get("e1")).setBy?.reference, "Practitioner/doc2");
});

test("S2a concurrent first selections keep one record and refuse the loser", async () => {
  const h = harness();
  const results = await Promise.allSettled([
    h.store.set("e1", "office-visit", { reference: "Practitioner/doc" }, null),
    h.store.set("e1", "comprehensive", { reference: "Practitioner/doc2" }, null),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal((await h.store.get("e1")).examScope, "office-visit");
});

test("S2a stored unknown scope is retained; corrupt and foreign records do not silently default", async () => {
  const h = harness();
  await h.store.set("e1", "office-visit", { reference: "Practitioner/doc" }, null);
  const extension = h.saved().extension![0];
  const value = JSON.parse(extension.valueString!);
  extension.valueString = JSON.stringify({ ...value, examScope: "future-scope" });
  assert.equal((await h.store.get("e1")).examScope, "future-scope");
  extension.valueString = "not-json";
  await assert.rejects(h.store.get("e1"));
  h.saved().subject = { reference: "Encounter/foreign" };
  await assert.rejects(h.store.get("e1"), /does not belong/);
});
