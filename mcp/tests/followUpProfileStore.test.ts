import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import {
  FhirFollowUpProfileStore, FOLLOW_UP_PROFILE_SEEDS, FOLLOW_UP_PROFILE_IDENTIFIER_SYSTEM,
  buildFollowUpProfileResource, parseFollowUpProfileResource, type FollowUpProfileFhirClient,
} from "../src/clinical-graph/follow-up-profile-store.js";

class MemoryFhir implements FollowUpProfileFhirClient {
  baseUrl = "http://synthetic.test/fhir/R4";
  rows: Basic[] = [];
  headers: Record<string, string>[] = [];
  async read<T extends Resource>(_type: T["resourceType"], id: string): Promise<T> { return structuredClone(this.rows.find(r => r.id === id)) as T; }
  async search<T extends Resource>(_type: T["resourceType"]): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: this.rows.map(resource => ({ resource: structuredClone(resource) as T })) };
  }
  async create<T extends Resource>(resource: T, headers: Record<string, string> = {}): Promise<T> {
    this.headers.push(headers);
    const existing = this.rows.find(r => r.identifier?.[0]?.value === (resource as Basic).identifier?.[0]?.value);
    if (headers["If-None-Exist"] && existing) return structuredClone(existing) as T;
    const result = { ...resource, id: `profile-${this.rows.length + 1}`, meta: { versionId: "1" } } as Basic;
    this.rows.push(result);
    return structuredClone(result) as T;
  }
  async update<T extends Resource>(_type: T["resourceType"], id: string, resource: T, headers: Record<string, string> = {}): Promise<T> {
    this.headers.push(headers);
    const index = this.rows.findIndex(r => r.id === id);
    const current = this.rows[index]!;
    if (headers["If-Match"] !== `W/"${current.meta!.versionId}"`) throw Object.assign(new Error("precondition"), { status: 412 });
    this.rows[index] = { ...resource, id, meta: { versionId: String(Number(current.meta!.versionId) + 1) } } as Basic;
    return structuredClone(this.rows[index]) as T;
  }
}

const profile = () => structuredClone(FOLLOW_UP_PROFILE_SEEDS[0]!);
const concurrent = (error: unknown) => (error as { status?: number }).status === 409;

test("G4 stored practice overlay wins even when shipped seed changes", async () => {
  const fhir = new MemoryFhir();
  const original = profile();
  const store = new FhirFollowUpProfileStore(fhir, [original]);
  const edited = { ...original, label: "Practice choice", active: false };
  await store.save(edited, null);
  const upgraded = new FhirFollowUpProfileStore(fhir, [{ ...original, label: "New shipped label", version: 2 }]);
  assert.equal((await upgraded.list())[0]!.label, "Practice choice");
  assert.equal((await upgraded.list())[0]!.active, false);
  await store.create({ ...original, profileKey: "practice-copy", label: "Practice copy" }, null);
  assert.equal((await upgraded.list()).length, 2);
  assert.equal(original.label, FOLLOW_UP_PROFILE_SEEDS[0]!.label);
});

test("G5a stale caller version is refused before a write", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirFollowUpProfileStore(fhir);
  const first = await store.save(profile(), null);
  const second = await store.save({ ...first.profile, label: "Other editor" }, first.versionId);
  const writes = fhir.headers.length;
  await assert.rejects(store.save({ ...first.profile, label: "Stale edit" }, first.versionId), concurrent);
  assert.equal(fhir.headers.length, writes);
  assert.equal((await store.list())[0]!.label, second.profile.label);
});

test("G5b concurrent creates of one profile key have exactly one winner", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirFollowUpProfileStore(fhir);
  const copy = { ...profile(), profileKey: "same-new-key" };
  const results = await Promise.allSettled([store.create(copy, null), store.create(copy, null)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected" && concurrent(r.reason)).length, 1);
  assert.equal(fhir.rows.length, 1);
  assert.equal(fhir.headers[0]!["If-None-Exist"], `identifier=${encodeURIComponent(`${FOLLOW_UP_PROFILE_IDENTIFIER_SYSTEM}|same-new-key`)}`);
});

test("G5c concurrent first seed overlays have exactly one winner", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirFollowUpProfileStore(fhir);
  const results = await Promise.allSettled([store.save(profile(), null), store.save(profile(), null)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected" && concurrent(r.reason)).length, 1);
  assert.equal(fhir.rows.length, 1);
  assert.ok(fhir.headers.every(h => h["If-None-Exist"]));
});

test("profile Basic round trip refuses identity mismatch and MDM fields", () => {
  const resource = buildFollowUpProfileResource(profile(), "write-token");
  assert.deepEqual(parseFollowUpProfileResource(resource).profile, profile());
  assert.throws(() => parseFollowUpProfileResource({ ...resource, identifier: [{ system: FOLLOW_UP_PROFILE_IDENTIFIER_SYSTEM, value: "wrong" }] }));
  assert.throws(() => buildFollowUpProfileResource({ ...profile(), mdmSuggestion: "stable" } as ReturnType<typeof profile>, "write-token"));
});

test("duplicate stored profile keys fail instead of silently picking a winner", async () => {
  const fhir = new MemoryFhir();
  fhir.rows = [1, 2].map(n => ({ ...buildFollowUpProfileResource(profile(), String(n)), id: String(n), meta: { versionId: "1" } }));
  await assert.rejects(new FhirFollowUpProfileStore(fhir).list(), /Duplicate/);
});
