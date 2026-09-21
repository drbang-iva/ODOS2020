import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { FhirEncounterExamScopeStore } from "../src/clinical-graph/exam-scope-store.js";
import { FhirFollowUpProfileStore } from "../src/clinical-graph/follow-up-profile-store.js";
import type { ExamOverviewFhirClient } from "../src/clinical-graph/exam-overview-endpoint.js";

class ShapeFhir implements ExamOverviewFhirClient {
  readonly baseUrl = "http://localhost/";
  rows: Basic[] = [];
  mismatch = false;
  async read<T extends Resource>(_type: T["resourceType"], id: string): Promise<T> { return structuredClone(this.rows.find(r => r.id === id)) as T; }
  async search<T extends Resource>(_type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const rows = this.rows.filter(r => {
      if (params.identifier) return r.identifier?.some(i => `${i.system}|${i.value}` === params.identifier);
      if (params.code) return r.code.coding?.some(c => `${c.system}|${c.code}` === params.code);
      return true;
    });
    return { resourceType: "Bundle", type: "searchset", entry: rows.map(r => ({ resource: structuredClone(r) as unknown as T })) };
  }
  async create<T extends Basic>(resource: T, headers?: Record<string, string>): Promise<T> {
    if (headers?.["If-None-Exist"]) {
      const identifier = new URLSearchParams(headers["If-None-Exist"]).get("identifier");
      const winner = this.rows.find(r => r.identifier?.some(i => `${i.system}|${i.value}` === identifier));
      if (winner) return structuredClone(winner) as T;
    }
    const saved = { ...structuredClone(resource), id: `row-${this.rows.length}`, meta: { versionId: "1" } };
    if (this.mismatch) {
      const ext = saved.extension![0];
      ext.valueString = JSON.stringify({ ...JSON.parse(ext.valueString!), writeToken: "different-writer" });
    }
    this.rows.push(saved);
    return structuredClone(saved);
  }
  async update<T extends Basic>(type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    const index = this.rows.findIndex(r => r.id === id);
    assert.equal(type, "Basic");
    if (headers?.["If-Match"] !== `W/"${this.rows[index].meta!.versionId}"`) throw Object.assign(new Error("conflict"), { status: 412 });
    this.rows[index] = { ...structuredClone(resource), meta: { versionId: String(Number(this.rows[index].meta!.versionId) + 1) } };
    return structuredClone(this.rows[index]) as T;
  }
}
const actor = { reference: "Practitioner/synthetic" };

test("S3b1 G4 conditional concurrent creates leave exactly one persisted row", async () => {
  const fhir = new ShapeFhir();
  const store = new FhirEncounterExamScopeStore(fhir);
  const result = await Promise.allSettled([store.set("e1", "office-visit", actor, null), store.set("e1", "office-visit", actor, null)]);
  assert.equal(fhir.rows.length, 1);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
});

test("S3b1 G4 write-token mismatch refuses identical persisted field values", async () => {
  const fhir = new ShapeFhir(); fhir.mismatch = true;
  await assert.rejects(new FhirEncounterExamScopeStore(fhir).set("e1", "office-visit", actor, null), /concurrently/);
});

test("S3b1 G5 untouched seed records numeric revision and explicit null versionId", async () => {
  const fhir = new ShapeFhir();
  const seed = (await new FhirFollowUpProfileStore(fhir).list()).find(p => p.profileKey === "glaucoma")!;
  assert.equal(seed.versionId, null);
  const store = new FhirEncounterExamScopeStore(fhir);
  const shaped = await store.shapeIfAbsent("e1", actor, async () => [seed]);
  assert.deepEqual(shaped.profilesApplied, [{ profileKey: "glaucoma", version: seed.version, versionId: null }]);
  const json = JSON.parse(fhir.rows[0].extension![0].valueString!);
  assert.deepEqual(json.profilesApplied, [{ profileKey: "glaucoma", version: seed.version, versionId: null }]);
  assert.deepEqual(json.sectionsOpen, seed.sectionsOpen.map(s => s.key));
});

test("S3b1 G1 profile edit and retirement never reshape a stored visit, scope edits preserve shape", async () => {
  const fhir = new ShapeFhir(); const profiles = new FhirFollowUpProfileStore(fhir);
  const seed = (await profiles.list()).find(p => p.profileKey === "glaucoma")!;
  const { versionId: _, ...profile } = seed;
  await profiles.save(profile, null);
  const store = new FhirEncounterExamScopeStore(fhir);
  const resolve = async () => (await profiles.list()).filter(p => p.profileKey === "glaucoma" && p.active);
  const first = await store.shapeIfAbsent("e1", actor, resolve);
  assert.deepEqual(first.profilesApplied, [{ profileKey: "glaucoma", version: 1, versionId: "1" }]);
  await profiles.save({ ...profile, version: 2, sectionsOpen: [{ key: "hpi" }, { key: "assessment" }] }, "1");
  assert.deepEqual(await store.shapeIfAbsent("e1", actor, resolve), first);
  const next = await store.shapeIfAbsent("e2", actor, resolve);
  assert.deepEqual(next.sectionsOpen, ["hpi", "assessment"]);
  await profiles.save({ ...profile, version: 3, active: false }, "2");
  assert.deepEqual(await store.shapeIfAbsent("e1", actor, resolve), first);
  const edited = await store.set("e1", "office-visit", actor, first.versionId!);
  assert.deepEqual(edited.sectionsOpen, first.sectionsOpen);
  assert.deepEqual(edited.profilesApplied, first.profilesApplied);
  assert.equal(edited.shapedAt, first.shapedAt);
});

test("S3b2 G1 explicit shape survives automatic shaping at the store boundary", async () => {
  const fhir = new ShapeFhir(); const store = new FhirEncounterExamScopeStore(fhir);
  const seed = (await new FhirFollowUpProfileStore(fhir).list())[0];
  const explicit = await store.pick("e1", "office-visit", actor, null, [seed]);
  assert.equal(explicit.source, "explicit");
  let resolved = false;
  const next = await store.shapeIfAbsent("e1", actor, async () => { resolved = true; return []; });
  assert.deepEqual(next, explicit);
  assert.equal(resolved, false);
});

test("S3b2 G2 explicit replaces derived and explicit, with independent chooser and time", async () => {
  const fhir = new ShapeFhir(); const store = new FhirEncounterExamScopeStore(fhir);
  const seed = (await new FhirFollowUpProfileStore(fhir).list())[0];
  const derived = await store.shapeIfAbsent("e1", actor, async () => [seed]);
  assert.equal(derived.source, "derived");
  const explicit = await store.pick("e1", "office-visit", actor, derived.versionId!, []);
  assert.equal(explicit.source, "explicit");
  assert.deepEqual(explicit.chosenBy, actor);
  assert.ok(Number.isFinite(Date.parse(explicit.chosenAt!)));
  assert.deepEqual(explicit.sectionsOpen, []);
  const scopeOnly = await store.set("e1", "comprehensive", { reference: "Practitioner/other" }, explicit.versionId!);
  assert.deepEqual(scopeOnly.chosenBy, actor);
  assert.equal(scopeOnly.chosenAt, explicit.chosenAt);
  const repicked = await store.pick("e1", "office-visit", actor, scopeOnly.versionId!, [seed]);
  assert.equal(repicked.source, "explicit");
  assert.deepEqual(repicked.sectionsOpen, seed.sectionsOpen.map(section => section.key));
  await assert.rejects(store.pick("e1", "office-visit", actor, derived.versionId!, []), /concurrently/);
});

test("S3b2 G3 profile edits do not reshape either source", async () => {
  const fhir = new ShapeFhir(); const profiles = new FhirFollowUpProfileStore(fhir);
  const seed = (await profiles.list())[0]; const { versionId: _, ...profile } = seed;
  const store = new FhirEncounterExamScopeStore(fhir);
  await store.shapeIfAbsent("derived", actor, async () => [seed]);
  await store.pick("explicit", "office-visit", actor, null, [seed]);
  const before = await Promise.all([store.get("derived"), store.get("explicit")]);
  await profiles.save({ ...profile, version: 2, sectionsOpen: [{ key: "hpi" }, { key: "assessment" }] }, null);
  for (const [index, id] of ["derived", "explicit"].entries()) {
    assert.deepEqual(await store.shapeIfAbsent(id, actor, () => profiles.list()), before[index]);
    assert.deepEqual(await store.get(id), before[index]);
  }
});

test("S3b2 G4 stored S3b1 shape without source reads derived without rewriting", async () => {
  const fhir = new ShapeFhir(); const store = new FhirEncounterExamScopeStore(fhir);
  const shaped = await store.shapeIfAbsent("e1", actor, async () => []);
  const value = JSON.parse(fhir.rows[0].extension![0].valueString!);
  delete value.source;
  fhir.rows[0].extension![0].valueString = JSON.stringify(value);
  const before = structuredClone(fhir.rows);
  assert.deepEqual(await store.get("e1"), { ...shaped, source: "derived" });
  assert.deepEqual(await store.shapeIfAbsent("e1", actor, async () => { throw new Error("must not resolve"); }), { ...shaped, source: "derived" });
  assert.deepEqual(fhir.rows, before);
});

test("S3b2 explicit conditional create and token confirmation retain one winner", async () => {
  const fhir = new ShapeFhir(); const store = new FhirEncounterExamScopeStore(fhir);
  const results = await Promise.allSettled([store.pick("e1", "office-visit", actor, null, []), store.pick("e1", "comprehensive", actor, null, [])]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(fhir.rows.length, 1);
  fhir.mismatch = true;
  await assert.rejects(store.pick("e2", "office-visit", actor, null, []), /concurrently/);
});
