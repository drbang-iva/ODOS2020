import type { ProtocolDefinition } from "../clinical-graph/protocol-types.js";
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
  fhir.rows.push({ resourceType: "Encounter", id: "e", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p" } });
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
  assert.ok(row.icd10 && "pattern" in row.icd10);
  const result = await handleProtocolOffersRequest(deps, { authHeader: "test", body: { diagnoses: [{ reference: "Condition/dx", code: row.icd10?.pattern?.left, confirmed: true }] } });
  assert.equal(result.status, 200);
  const protocols = (result.body as { protocols: ProtocolDefinition[] }).protocols.filter(row => row.id.startsWith("glaucoma-"));
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
  assert.equal((result.body as { protocols: ProtocolDefinition[] }).protocols.some(row => row.id === body.protocolId), false);
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

for (const mode of ["tap", "whole"] as const) test(`fixback warm ${mode} seeds only its built-in and rules`, async () => {
  const { fhir, service, deps } = setup();
  const body = await bodyFor(fhir, "glaucoma-suspect-initial", "suspect");
  await ensureBuiltInProtocols(service);
  const searches: Array<Record<string, string> | undefined> = [];
  fhir.afterSearch = async params => { searches.push(params); };
  const result = mode === "tap"
    ? await handleProtocolItemAddRequest(deps, { authHeader: "test", body: { ...body, itemKey: "order-fundus-photography" } })
    : await handleProtocolApplyRequest(deps, { authHeader: "test", body });
  assert.equal(result.status, 200);
  const guardDefinitionQuery = { code: "https://odos2020.com/fhir/CodeSystem/odos-finding-definition|odos-finding-definition", _count: "200" };
  const guardEncounterQuery = { encounter: "Encounter/e", _count: "200" };
  const guardSearches = searches.filter(p => p?.code === guardDefinitionQuery.code || p?.encounter === "Encounter/e");
  assert.deepEqual(guardSearches, Array.from({ length: mode === "tap" ? 3 : 10 }, () =>
    [guardDefinitionQuery, guardEncounterQuery, guardEncounterQuery]).flat());
  const protocolSearches = searches.filter(p => !(guardSearches as typeof searches).includes(p));
  const ruleSearches = protocolSearches.filter(p => p?.code?.endsWith("odos-procedure-charge-rule"));
  const definitionSearches = protocolSearches.filter(p => /odos-protocol-definition/.test(p?.code ?? ""));
  assert.equal(definitionSearches.length, mode === "tap" ? 4 : 5);
  assert.ok(protocolSearches.length <= (mode === "tap" ? 24 : 52));
  assert.deepEqual(protocolSearches.slice(0, mode === "tap" ? 7 : 8).map(p => p?.code?.split("|").at(-1)), [...(mode === "whole" ? ["odos-protocol-definition"] : []), "odos-protocol-definition", "odos-protocol-definition-snapshot", ...Array(5).fill("odos-procedure-charge-rule")]);
  assert.ok(ruleSearches.length <= (mode === "tap" ? 6 : 10));
});
test("fixback first apply seeds only requested head and its five rules", async () => {
  const { fhir, service, deps } = setup();
  const body = await bodyFor(fhir, "glaucoma-suspect-initial", "suspect");
  assert.equal((await handleProtocolApplyRequest(deps, { authHeader: "test", body })).status, 200);
  assert.deepEqual((await service.definitions.list()).map(p => p.id), [body.protocolId]);
  assert.equal((await service.chargeRules.list()).length, 5);
});
