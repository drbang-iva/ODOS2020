import assert from "node:assert/strict";
import test from "node:test";
import { PlanAuthoringFhir, endpointDeps } from "./helpers/plan-authoring-fhir.js";
import { ProtocolService } from "../clinical-graph/protocol-service.js";
import { BUILTIN_PROTOCOLS, GLAUCOMA_SUSPECT_PROTOCOL_V1, GLAUCOMA_SUSPECT_CHARGE_RULES } from "../clinical-graph/protocol-fixtures.js";
import { buildDiagnosisCatalogSeeds } from "../clinical-graph/diagnosis-catalog-seeds.js";
import { handleProtocolApplyRequest, handleProtocolItemAddRequest, handleProtocolOffersRequest } from "../clinical-graph/protocol-endpoint.js";
import { ensureBuiltInProtocols } from "../clinical-graph/protocol-seeding.js";

function setup() {
  const fhir = new PlanAuthoringFhir();
  const service = new ProtocolService(fhir, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  return { fhir, service, deps: endpointDeps(fhir) };
}
async function bodyFor(fhir: PlanAuthoringFhir, protocolId: string, id: string) {
  const protocol = BUILTIN_PROTOCOLS.find(row => row.id === protocolId)!;
  assert.equal(protocol.trigger.kind, "diagnosis");
  const code = protocol.trigger.kind === "diagnosis" ? protocol.trigger.dxKeys[0] : "";
  await fhir.create({ resourceType: "Condition", id, subject: { reference: "Patient/p" }, verificationStatus: { coding: [{ code: "confirmed" }] }, code: { coding: [{ code }] } });
  return { protocolId, patientId: "p", encounterId: "e", diagnosis: { reference: `Condition/${id}`, code, confirmed: true as const } };
}
test("POAG moderate left eye offers exactly its titled glaucoma plan", async () => {
  const { deps } = setup();
  const row = buildDiagnosisCatalogSeeds().find(row => row.icd10Family === "H40.11-moderate")!;
  assert.ok(row);
  const result = await handleProtocolOffersRequest(deps, { authHeader: "test", body: { diagnoses: [{ reference: "Condition/dx", code: row.icd10?.pattern?.left, confirmed: true }] } });
  assert.equal(result.status, 200);
  const protocols = (result.body as { protocols: typeof BUILTIN_PROTOCOLS }).protocols.filter(row => row.id.startsWith("glaucoma-"));
  assert.deepEqual(protocols.map(row => row.id), ["glaucoma-poag"]);
  assert.ok(protocols[0].items.every(item => Boolean(item.title)));
  assert.equal(protocols[0].items.some(item => item.itemType === "education"), false);
});
test("retired stored glaucoma head never returns through fixture fallback", async () => {
  const { service, deps, fhir } = setup();
  const body = await bodyFor(fhir, "glaucoma-oht", "oht");
  await service.definitions.save({ ...structuredClone(BUILTIN_PROTOCOLS.find(row => row.id === body.protocolId)!), status: "retired" });
  const result = await handleProtocolOffersRequest(deps, { authHeader: "test", body: { diagnoses: [body.diagnosis] } });
  assert.equal(result.status, 200);
  assert.equal((result.body as { protocols: typeof BUILTIN_PROTOCOLS }).protocols.some(row => row.id === body.protocolId), false);
});
test("mixed suspect and OHT whole applies share every test and charge", async () => {
  const { service, deps, fhir } = setup();
  for (const [protocolId, id] of [["glaucoma-suspect-initial", "suspect"], ["glaucoma-oht", "oht"]]) {
    const body = await bodyFor(fhir, protocolId, id);
    assert.equal((await handleProtocolApplyRequest(deps, { authHeader: "test", body })).status, 200);
  }
  const orders = (await service.actions.list()).filter(row => row.actionType === "order" && row.state !== "removed");
  const charges = (await service.charges.list()).filter(row => row.state !== "removed");
  assert.equal(orders.length, 5); assert.equal(charges.length, 5);
  assert.equal(new Set(orders.map(row => row.payload.orderableKey)).size, 5);
  assert.equal(new Set(charges.map(row => row.procedureConceptKey)).size, 5);
  assert.ok(orders.every(row => row.linkedDx.includes("Condition/suspect") && row.linkedDx.includes("Condition/oht")));
});
test("v1 photo remains already added after v2 seed without a second order or charge", async () => {
  const { service, deps, fhir } = setup();
  const body = await bodyFor(fhir, "glaucoma-suspect-initial", "suspect");
  await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL_V1);
  for (const rule of GLAUCOMA_SUSPECT_CHARGE_RULES) await service.chargeRules.save(rule);
  const opened = await service.open(body.protocolId, { ...body, actor: "Practitioner/test" });
  await service.commit(opened.application.id, GLAUCOMA_SUSPECT_PROTOCOL_V1.items.map(item => ({ itemKey: item.itemKey, selected: ["order-fundus-photography", "charge-fundus-photography"].includes(item.itemKey) })), [body.diagnosis.reference]);
  await ensureBuiltInProtocols(service);
  assert.equal((await service.definitions.get(body.protocolId))?.version, 2);
  assert.deepEqual(await service.definitions.getSnapshot(body.protocolId, 1), GLAUCOMA_SUSPECT_PROTOCOL_V1);
  const added = await handleProtocolItemAddRequest(deps, { authHeader: "test", body: { ...body, itemKey: "order-fundus-photography" } });
  assert.equal(added.status, 200);
  assert.equal((added.body as { alreadyApplied: boolean }).alreadyApplied, true);
  assert.equal((await service.actions.list()).filter(row => row.actionType === "order").length, 1);
  assert.equal((await service.charges.list()).length, 1);
});
