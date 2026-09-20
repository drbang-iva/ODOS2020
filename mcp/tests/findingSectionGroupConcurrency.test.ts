import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import {
  FhirFindingSectionGroupStore, FhirEncounterSectionOverrideStore,
  DRY_EYE_WORKUP_SECTION_GROUP, buildEncounterSectionOverrideResource,
  type FindingSectionGroupFhirClient,
} from "../src/clinical-graph/finding-section-group-store.js";
import { handleFindingSectionGroupMutationRequest } from "../src/clinical-graph/finding-section-group-endpoint.js";

class ConditionalFhir implements FindingSectionGroupFhirClient {
  readonly baseUrl = "http://localhost:8103/";
  rows: Basic[] = [];
  async read<T extends Resource>(_type: T["resourceType"], id: string): Promise<T> {
    return structuredClone(this.rows.find(row => row.id === id)) as unknown as T;
  }
  async search<T extends Resource>(_type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    return { resourceType: "Bundle", entry: this.rows.filter(row => matches(row, params)).map(row => ({ resource: structuredClone(row) as unknown as T })) };
  }
  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    const condition = headers?.["If-None-Exist"];
    if (condition) {
      const existing = this.rows.find(row => matches(row, Object.fromEntries(new URLSearchParams(condition))));
      if (existing) return structuredClone(existing) as unknown as T;
    }
    const row = { ...structuredClone(resource), id: `row-${this.rows.length + 1}`, meta: { versionId: "1" } } as unknown as Basic;
    this.rows.push(row);
    return structuredClone(row) as unknown as T;
  }
  async update<T extends Resource>(_type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    const index = this.rows.findIndex(row => row.id === id);
    const current = this.rows[index];
    if (headers?.["If-Match"] !== `W/"${current.meta?.versionId}"`) throw Object.assign(new Error("Precondition failed"), { status: 412 });
    const row = { ...structuredClone(resource), id, meta: { versionId: String(Number(current.meta?.versionId) + 1) } } as unknown as Basic;
    this.rows[index] = row;
    return structuredClone(row) as unknown as T;
  }
}
function matches(row: Basic, params: Record<string, string>) {
  if (params.code && !row.code.coding?.some(c => `${c.system}|${c.code}` === params.code)) return false;
  if (params.subject && row.subject?.reference !== params.subject) return false;
  if (params.identifier && !row.identifier?.some(i => `${i.system}|${i.value}` === params.identifier)) return false;
  return true;
}
const custom = { ...DRY_EYE_WORKUP_SECTION_GROUP, id: "synthetic", groupKey: "synthetic-group" };
const conflict = (error: unknown) => (error as { status?: number }).status === 409;

test("G1 stale Settings caller receives concurrent-edit and cannot overwrite a newer label", async () => {
  const fhir = new ConditionalFhir();
  const store = new FhirFindingSectionGroupStore(fhir);
  await store.create(custom, null);
  await store.save({ ...custom, label: "First editor" }, "1");
  const result = await handleFindingSectionGroupMutationRequest({
    authenticate: async () => ({ staffReference: "Practitioner/synthetic", actorRole: "admin", fhir }),
  }, { authHeader: "synthetic", params: { groupKey: custom.groupKey }, body: { label: "Stale editor", expectedVersion: "1" } });
  assert.deepEqual(result, { status: 409, body: { code: "concurrent-edit", error: "This section group changed concurrently — reload and retry." } });
  assert.equal((await store.list()).find(row => row.groupKey === custom.groupKey)?.label, "First editor");
});

for (const seed of [false, true]) test(`${seed ? "G3" : "G2 G4"} concurrent ${seed ? "first seed overlays" : "catalogue creates"} have one accepted winner`, async () => {
  const fhir = new ConditionalFhir();
  const store = new FhirFindingSectionGroupStore(fhir);
  const write = () => seed ? store.save(DRY_EYE_WORKUP_SECTION_GROUP, null) : store.create(custom, null);
  const results = await Promise.allSettled([write(), write()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1, "exactly one caller must win, even with identical payloads");
  assert.equal(fhir.rows.length, 1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(conflict(rejected.reason));
});

test("G5 concurrent first override writes leave exactly one physical row", async () => {
  const fhir = new ConditionalFhir();
  const store = new FhirEncounterSectionOverrideStore(fhir);
  await Promise.all([store.setGroupKeys("synthetic-encounter", ["first"]), store.setGroupKeys("synthetic-encounter", ["second"])]);
  assert.equal(fhir.rows.length, 1, "a plausible returned group set does not prove absence of leaked rows");
});

test("conditional override creation matches an existing identifier-free legacy row", async () => {
  const fhir = new ConditionalFhir();
  const search = fhir.search.bind(fhir);
  let raced = false;
  fhir.search = async (type, params) => {
    const snapshot = await search(type, params);
    if (!raced) {
      raced = true;
      await fhir.create(buildEncounterSectionOverrideResource({ encounterId: "synthetic-encounter", groupKeys: ["legacy"] }));
    }
    return snapshot;
  };
  await new FhirEncounterSectionOverrideStore(fhir).setGroupKeys("synthetic-encounter", ["new"]);
  assert.equal(fhir.rows.length, 1);
  assert.equal(fhir.rows[0].identifier, undefined);
});

test("catalogue versions expose null seeds and round-trip stored versions", async () => {
  const fhir = new ConditionalFhir();
  const store = new FhirFindingSectionGroupStore(fhir);
  assert.equal((await store.list())[0].versionId, null);
  const saved = await store.save(DRY_EYE_WORKUP_SECTION_GROUP, null);
  assert.equal(saved.versionId, "1");
  assert.equal((await store.list())[0].versionId, "1");
});
