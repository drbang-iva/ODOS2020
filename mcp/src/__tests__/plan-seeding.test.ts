import { resolveDiagnosisDxKeys } from "../clinical-graph/diagnosis-dx-key-resolver.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolService } from "../clinical-graph/protocol-service.js";
import { GLAUCOMA_SUSPECT_PROTOCOL_V1 as V1, GLAUCOMA_SUSPECT_CHARGE_RULES } from "../clinical-graph/protocol-fixtures.js";
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

test("a staff draft winning the seed race can still publish the next version", async () => {
  const { fhir, service, old, seed } = setup();
  await service.definitions.saveHead(old);
  fhir.beforeUpdate = async (_resource, headers) => {
    if (!headers?.["If-Match"]) return;
    fhir.beforeUpdate = undefined;
    await service.saveDraft(old.id, { title: "Staff draft", trigger: old.trigger, ownership: old.ownership, categories: [], items: old.items.filter(item => item.itemType === "follow-up") });
  };
  await seed();
  const published = await service.publish(old.id, "Practitioner/staff", { findingKeys: new Set(), procedureKeys: new Set() });
  assert.equal(published.version, 2);
  assert.equal(published.title, "Staff draft");
  assert.equal(published.audit.publishedBy, "Practitioner/staff");
  assert.deepEqual(await service.definitions.getSnapshot(old.id, 2), published);
});

test("an interrupted new snapshot is repaired by a later identical seed", async () => {
  const { fhir, service, old, next, seed } = setup();
  await service.definitions.saveHead(old);
  const create = fhir.create.bind(fhir);
  let fail = true;
  fhir.create = async (resource, headers) => {
    if (fail && headers?.["If-None-Exist"]?.endsWith(`${old.id}@v2`)) {
      fail = false;
      throw new Error("Synthetic snapshot write interruption");
    }
    return create(resource, headers);
  };
  await seed();
  assert.deepEqual(await service.definitions.get(old.id), next);
  assert.deepEqual(await service.definitions.getSnapshot(old.id, 1), old);
  await seed();
  await service.definitions.saveHead({ ...next, status: "retired", title: "Different head after repair" });
  assert.deepEqual(await service.definitions.getSnapshot(old.id, 2), next);
});

test("a conflicting future snapshot refuses the head upgrade", async () => {
  const { service, old, next, seed, logs } = setup();
  await service.definitions.saveHead(old);
  await service.definitions.saveSnapshot({ ...next, title: "Already reserved content" });
  await seed();
  assert.deepEqual(await service.definitions.get(old.id), old);
  assert.match(logs.join(" "), /snapshot conflict/);
});

test("concurrent absent boots create one head", async () => {
  const { service, next, seed } = setup();
  await Promise.all([seed(), seed()]);
  assert.deepEqual(await service.definitions.list(), [next]);
  assert.deepEqual(await service.definitions.getSnapshot(next.id, 2), next);
});

for (const mutation of ["draft", "retire"] as const) {
  test(`authoring ${mutation} preserves the published version after interrupted snapshot creation`, async () => {
    const { fhir, service, old, next, seed } = setup();
    await service.definitions.saveHead(old);
    const create = fhir.create.bind(fhir);
    let fail = true;
    fhir.create = async (resource, headers) => {
      if (fail && headers?.["If-None-Exist"]?.endsWith(`${old.id}@v2`)) { fail = false; throw new Error("Snapshot interrupted"); }
      return create(resource, headers);
    };
    await seed();
    if (mutation === "draft") {
      await service.saveDraft(old.id, { title: "Staff draft", trigger: next.trigger, ownership: next.ownership, categories: [], items: next.items.filter(item => item.itemType === "follow-up") });
    } else await service.retire(old.id);
    await seed();
    assert.deepEqual(await service.definitions.getSnapshot(old.id, 2), next);
  });
}

test("rule upgrades preserve the version already recorded on a charge evaluation", async () => {
  const { service, old } = setup();
  await service.definitions.save(old);
  for (const rule of GLAUCOMA_SUSPECT_CHARGE_RULES) await service.chargeRules.save(rule);
  const dx = resolveDiagnosisDxKeys("H40.00-");
  assert.equal(dx.status, "resolved");
  if (dx.status !== "resolved") return;
  await service.addItem(old.id, "order-gonioscopy", { patientId: "p", encounterId: "e", actor: "Practitioner/test", diagnosis: { reference: "Condition/dx", code: dx.dxKeys[0], confirmed: true } });
  const before = await service.charges.list();
  assert.equal(before.length, 1);
  assert.equal(before[0].coverageEvaluations[0].ruleVersion, 1);
  await ensureBuiltInProtocols(service, { protocols: [], rules: GLAUCOMA_SUSPECT_CHARGE_RULES.map(rule => ({ ...rule, version: 2 })) });
  assert.ok((await service.chargeRules.list()).every(rule => rule.version === 2));
  assert.deepEqual(await service.charges.list(), before);
});
