import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolService } from "../clinical-graph/protocol-service.js";
import { GLAUCOMA_SUSPECT_PROTOCOL_V1 as V1 } from "../clinical-graph/protocol-fixtures.js";
import { PlanAuthoringFhir } from "./helpers/plan-authoring-fhir.js";
import { ensureBuiltInProtocols } from "../clinical-graph/protocol-seeding.js";

function setup() {
  const fhir = new PlanAuthoringFhir();
  const service = new ProtocolService(fhir, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  const old = structuredClone(V1);
  const next = { ...structuredClone(old), version: 2, title: "Next version" };
  const logs: string[] = [];
  const log = (message: string) => { logs.push(message); };
  const seed = () => ensureBuiltInProtocols(service, { protocols: [next], rules: [], log });
  return { fhir, service, old, next, seed, logs };
}
test("seeding advances a legacy system head conditionally and preserves its pinned snapshot", async () => {
  const { fhir, service, old, next, seed } = setup();
  await service.definitions.saveHead(old);
  await seed();
  assert.deepEqual(await service.definitions.get(old.id), next);
  assert.deepEqual(await service.definitions.getSnapshot(old.id, 1), old);
  assert.ok(fhir.writes.some(write => write.headers?.["If-Match"]));
});
for (const state of ["draft", "retired", "staff", "missing-publisher"] as const) {
  test(`seeding preserves a ${state} head`, async () => {
    const { service, old, seed } = setup();
    if (state === "draft") old.draft = { title: "Staff draft", trigger: old.trigger, ownership: old.ownership, categories: [], items: old.items };
    if (state === "retired") old.status = "retired";
    if (state === "staff") old.audit.publishedBy = "Practitioner/staff";
    if (state === "missing-publisher") delete old.audit.publishedBy;
    await service.definitions.saveHead(old);
    await seed();
    assert.deepEqual(await service.definitions.get(old.id), old);
  });
}
test("double boot keeps one new head and immutable snapshots", async () => {
  const { fhir, service, old, next, seed } = setup();
  await service.definitions.saveHead(old);
  await Promise.all([seed(), seed()]);
  assert.deepEqual(await service.definitions.get(old.id), next);
  assert.deepEqual(await service.definitions.getSnapshot(old.id, 1), old);
  assert.equal((await service.definitions.list()).length, 1);
  assert.equal(fhir.rows.filter(row => row.resourceType === "Basic" && row.code?.coding?.some(c => c.code === "odos-protocol-definition-snapshot")).length, 2);
});
test("equal version conflict is logged and never overwritten", async () => {
  const { service, next, seed, logs } = setup();
  const edited = { ...next, title: "Different same version" };
  await service.definitions.save(edited);
  await seed(); await seed();
  assert.deepEqual(await service.definitions.get(next.id), edited);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /conflict/i);
});
test("a concurrent staff edit wins the version-conditional seed", async () => {
  const { fhir, service, old, seed, logs } = setup();
  await service.definitions.saveHead(old);
  fhir.beforeUpdate = async (_resource, headers) => {
    if (!headers?.["If-Match"]) return;
    fhir.beforeUpdate = undefined;
    await service.definitions.saveHead({ ...old, title: "Staff won", audit: { ...old.audit, publishedBy: "Practitioner/staff" } });
  };
  await seed();
  assert.equal((await service.definitions.get(old.id))?.title, "Staff won");
  assert.match(logs.join(" "), /conflict|race/i);
});
