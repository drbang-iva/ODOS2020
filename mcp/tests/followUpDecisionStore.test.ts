import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import type { ExamOverviewFhirClient } from "../src/clinical-graph/exam-overview-endpoint.js";

const actorA = { reference: "Practitioner/a", display: "Tech A" };
const actorB = { reference: "Practitioner/b", display: "Doctor B" };
const command = (focus: string) => ({ orderable: "photos", focus, decision: "not-today" as const });
class DecisionFhir implements ExamOverviewFhirClient {
  baseUrl = "http://localhost/";
  records: Basic[] = [];
  attempts = 0;
  rejected = 0;
  conflictAlways = false;
  beforeWrite?: () => Promise<void>;
  async read<T extends Resource>(): Promise<T> { throw new Error("Decision store must search, not read"); }
  async search<T extends Resource>(_type: T["resourceType"], params: Record<string,string> = {}): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: this.records.filter(r => r.identifier?.some(i => `${i.system}|${i.value}` === params.identifier)).map(r => ({ resource: structuredClone(r) as unknown as T })) };
  }
  async intervene() { const hook = this.beforeWrite; this.beforeWrite = undefined; await hook?.(); }
  async create<T extends Resource>(resource: T, headers?: Record<string,string>): Promise<T> {
    this.attempts++; await this.intervene();
    if (this.conflictAlways) { this.rejected++; throw Object.assign(new Error("race"), { status: 409 }); }
    const candidate = resource as Basic;
    const existing = this.records.find(r => r.identifier?.[0]?.value === candidate.identifier?.[0]?.value);
    if (existing && headers?.["If-None-Exist"] === `identifier=${encodeURIComponent(`${candidate.identifier![0].system}|${candidate.identifier![0].value}`)}`) return structuredClone(existing) as unknown as T;
    const saved = { ...structuredClone(candidate), id: `decision-${this.records.length}`, meta: { versionId: "1" } };
    this.records.push(saved); return structuredClone(saved) as unknown as T;
  }
  async update<T extends Resource>(_type: T["resourceType"], id: string, resource: T, headers?: Record<string,string>): Promise<T> {
    this.attempts++; await this.intervene();
    const index = this.records.findIndex(r => r.id === id); assert.notEqual(index, -1);
    const prior = this.records[index];
    if (this.conflictAlways || (headers?.["If-Match"] !== undefined && headers["If-Match"] !== `W/"${prior.meta!.versionId}"`)) {
      this.rejected++; throw Object.assign(new Error("stale version"), { status: 412 });
    }
    const saved = { ...structuredClone(resource as Basic), meta: { versionId: String(Number(prior.meta!.versionId) + 1) } };
    this.records[index] = saved; return structuredClone(saved) as unknown as T;
  }
}
async function store(fhir: DecisionFhir) {
  const module = await import("../src/clinical-graph/follow-up-decision-store.js");
  assert.equal(typeof module.FhirFollowUpDecisionStore, "function");
  return new module.FhirFollowUpDecisionStore(fhir);
}

test("S3c2b G2 decision identity includes focus and Put back deletes only its key", async () => {
  const fhir = new DecisionFhir(), decisions = await store(fhir);
  assert.deepEqual(await decisions.get("e1"), {});
  await decisions.apply("e1", command("optic nerve"), actorA);
  await decisions.apply("e1", command("retina"), actorB);
  const before = await decisions.get("e1");
  assert.deepEqual(Object.keys(before).sort(), ["photos|optic nerve", "photos|retina"]);
  assert.equal(before["photos|optic nerve"].by.reference, actorA.reference);
  assert.ok(Number.isFinite(Date.parse(before["photos|optic nerve"].at)));
  await decisions.apply("e1", { ...command("optic nerve"), decision: "put-back" }, actorB);
  assert.deepEqual(await decisions.get("e1"), { "photos|retina": before["photos|retina"] });
  assert.equal(fhir.records.length, 1);
});

test("S3c2b G5 stale If-Match is refused then fresh reapply preserves both people", async () => {
  const fhir = new DecisionFhir(), decisions = await store(fhir);
  await decisions.apply("e1", command("seed"), actorA);
  fhir.beforeWrite = async () => { await decisions.apply("e1", command("retina"), actorB); };
  await decisions.apply("e1", command("optic nerve"), actorA);
  const result = await decisions.get("e1");
  assert.deepEqual(Object.keys(result).sort(), ["photos|optic nerve", "photos|retina", "photos|seed"]);
  assert.equal(result["photos|retina"].by.reference, actorB.reference);
  assert.equal(fhir.rejected, 1);
});

test("S3c2b G6 retry stops after exactly three conflicting writes", async () => {
  for (const existing of [false, true]) {
    const fhir = new DecisionFhir(), decisions = await store(fhir);
    if (existing) await decisions.apply("e1", command("seed"), actorA);
    fhir.attempts = 0; fhir.conflictAlways = true;
    await assert.rejects(decisions.apply("e1", command("optic nerve"), actorA), (error: any) => error.status === 409 && error.code === "concurrent-edit");
    assert.equal(fhir.attempts, 3);
  }
});

test("S3c2b G7 conditional create loser confirms token and preserves first writer", async () => {
  const fhir = new DecisionFhir(), decisions = await store(fhir);
  fhir.beforeWrite = async () => { await decisions.apply("e1", command("retina"), actorB); };
  await decisions.apply("e1", command("optic nerve"), actorA);
  const result = await decisions.get("e1");
  assert.equal(fhir.records.length, 1);
  assert.deepEqual(Object.keys(result).sort(), ["photos|optic nerve", "photos|retina"]);
  assert.equal(result["photos|retina"].by.reference, actorB.reference);
  assert.equal(result["photos|optic nerve"].by.reference, actorA.reference);
});

test("S3c2b retry preserves an already-recorded same-key decision and actor", async () => {
  const fhir = new DecisionFhir(), decisions = await store(fhir);
  fhir.beforeWrite = async () => { await decisions.apply("e1", command("optic nerve"), actorB); };
  await decisions.apply("e1", command("optic nerve"), actorA);
  assert.equal((await decisions.get("e1"))["photos|optic nerve"].by.reference, actorB.reference);
  const attempts = fhir.attempts;
  await decisions.apply("e1", command("optic nerve"), actorA);
  assert.equal(fhir.attempts, attempts);
});
