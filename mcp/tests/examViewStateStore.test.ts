import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import type { ExamOverviewFhirClient } from "../src/clinical-graph/exam-overview-endpoint.js";
import { FhirEncounterExamScopeStore } from "../src/clinical-graph/exam-scope-store.js";

function database() {
  const rows: Basic[] = [];
  const clients = () => ({
    baseUrl: "http://localhost/",
    async read(_type: string, id: string) {
      return { resourceType: "Encounter", id, status: "in-progress", subject: { reference: "Patient/synthetic" } };
    },
    async search<T extends Resource>(_type: string, params: Record<string, string> = {}): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: rows.filter(r => !params.identifier || r.identifier?.some(i => `${i.system}|${i.value}` === params.identifier)).map(r => ({ resource: structuredClone(r) as unknown as T })) };
    },
    async create(resource: Basic, headers?: Record<string, string>) {
      const identifier = new URLSearchParams(headers?.["If-None-Exist"]).get("identifier");
      const winner = identifier && rows.find(r => r.identifier?.some(i => `${i.system}|${i.value}` === identifier));
      if (winner) return structuredClone(winner);
      const saved = { ...structuredClone(resource), id: `row-${rows.length}`, meta: { versionId: "1" } };
      rows.push(saved);
      return structuredClone(saved);
    },
    async update(_type: string, id: string, resource: Basic, headers?: Record<string, string>) {
      const index = rows.findIndex(r => r.id === id);
      assert.ok(index >= 0);
      if (headers?.["If-Match"] && headers["If-Match"] !== `W/"${rows[index].meta!.versionId}"`) throw Object.assign(new Error("conflict"), { status: 412 });
      rows[index] = { ...structuredClone(resource), meta: { versionId: String(Number(rows[index].meta!.versionId) + 1) } };
      return structuredClone(rows[index]);
    },
  }) as unknown as ExamOverviewFhirClient;
  return { rows, clients };
}
async function moduleUnderTest() {
  const module = await import("../src/clinical-graph/exam-view-state-store.js").catch(() => undefined);
  assert.ok(module, "server encounter view-state store must exist");
  return module;
}

test("S3b3 G1 independent clients share the encounter preference, other encounters stay open", async () => {
  const { FhirEncounterExamViewStateStore: Store } = await moduleUnderTest();
  const db = database(), a = new Store(db.clients()), b = new Store(db.clients());
  await a.set("e1", { collapsed: ["iop"], shelved: ["cover-test"] });
  assert.deepEqual(await b.get("e1"), { collapsed: ["iop"], shelved: ["cover-test"] });
  assert.deepEqual(await b.get("e2"), { collapsed: [], shelved: [] });
  await b.set("e1", { collapsed: ["wearing"], shelved: [] });
  assert.deepEqual(await a.get("e1"), { collapsed: ["wearing"], shelved: [] });
});

test("S3b3 G2 collapse does not bump or change the shape record", async () => {
  const { FhirEncounterExamViewStateStore: Store } = await moduleUnderTest();
  const db = database(), fhir = db.clients(), shape = new FhirEncounterExamScopeStore(fhir);
  await shape.pick("e1", "office-visit", { reference: "Practitioner/synthetic" }, null, []);
  const before = structuredClone(db.rows[0]);
  await new Store(fhir).set("e1", { collapsed: ["iop"], shelved: [] });
  assert.equal(db.rows[0].meta!.versionId, before.meta!.versionId);
  assert.deepEqual(db.rows[0], before);
  assert.equal(db.rows.length, 2);
});

test("S3b3 G7 concurrent first writes leave one physical row, subsequent writes need no expectedVersion", async () => {
  const { FhirEncounterExamViewStateStore: Store } = await moduleUnderTest();
  const db = database(), a = new Store(db.clients()), b = new Store(db.clients());
  await Promise.all([a.set("e1", { collapsed: ["iop"], shelved: [] }), b.set("e1", { collapsed: ["wearing"], shelved: [] })]);
  assert.equal(db.rows.length, 1, "conditional creation must enforce the persisted row count");
  await b.set("e1", { collapsed: [], shelved: ["cover-test"] });
  assert.deepEqual(await a.get("e1"), { collapsed: [], shelved: ["cover-test"] });
});

test("S3b3 store refuses malformed input, foreign rows and corrupt persisted values", async () => {
  const { FhirEncounterExamViewStateStore: Store } = await moduleUnderTest();
  const db = database(), store = new Store(db.clients());
  await assert.rejects(store.set("e1", { collapsed: [1], shelved: [] } as any));
  assert.equal(db.rows.length, 0);
  await store.set("e1", { collapsed: ["iop", "iop"], shelved: [] });
  assert.deepEqual(await store.get("e1"), { collapsed: ["iop"], shelved: [] });
  db.rows[0].subject = { reference: "Encounter/foreign" };
  await assert.rejects(store.get("e1"));
  db.rows[0].subject = { reference: "Encounter/e1" };
  db.rows[0].extension![0].valueString = "broken";
  await assert.rejects(store.get("e1"));
});

test("S3b3 endpoint scopes access through the caller encounter and validates preferences before writes", async () => {
  const module = await import("../src/clinical-graph/exam-view-state-endpoint.js").catch(() => undefined);
  assert.ok(module, "view-state endpoint must exist");
  const db = database(), caller = db.clients();
  let identity: any = { actorRole: "provider", staffReference: "Practitioner/synthetic", fhir: caller };
  const deps = { authenticate: async () => identity, serviceFhir: db.clients() };
  const input = { authHeader: "Bearer synthetic", params: { encounterId: "e1" }, method: "PUT" as const, body: { collapsed: ["iop"], shelved: [] } };
  assert.equal((await module.handleExamViewStateRequest(deps, input)).status, 200);
  assert.deepEqual((await module.handleExamViewStateRequest(deps, { ...input, method: "GET" })).body, input.body);
  assert.equal((await module.handleExamViewStateRequest(deps, { ...input, body: { collapsed: [1], shelved: [] } })).status, 400);
  const before = structuredClone(db.rows);
  caller.read = async () => { throw Object.assign(new Error("forbidden"), { status: 403 }); };
  assert.equal((await module.handleExamViewStateRequest(deps, input)).status, 403);
  assert.deepEqual(db.rows, before);
  identity = null;
  assert.equal((await module.handleExamViewStateRequest(deps, input)).status, 401);
});
