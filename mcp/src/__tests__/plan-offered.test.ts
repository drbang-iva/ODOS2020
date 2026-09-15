import assert from "node:assert/strict";
import test from "node:test";
import { PlanAuthoringFhir, endpointDeps } from "./helpers/plan-authoring-fhir.js";
import { ProtocolService } from "../clinical-graph/protocol-service.js";
import { DRY_EYE_IPL_INIT_PROTOCOL } from "../clinical-graph/protocol-fixtures.js";
import { FhirProcedureDefinitionStore, DRY_EYE_PROCEDURE_STABLE_KEYS } from "../clinical-graph/procedure-definition-store.js";
import { handleProtocolApplyRequest, handleProtocolItemAddRequest, handleProtocolOffersRequest } from "../clinical-graph/protocol-endpoint.js";
import { isPlanItemOffered } from "../clinical-graph/plan-item-offered.js";
import type { ProtocolDefinition } from "../clinical-graph/protocol-types.js";

async function setup(active: boolean) {
  const fhir = new PlanAuthoringFhir();
  const store = new FhirProcedureDefinitionStore(fhir);
  const definition = (await store.list()).find(row => row.stableKey === DRY_EYE_PROCEDURE_STABLE_KEYS.ipl)!;
  await store.save({ ...definition, active });
  const service = new ProtocolService(fhir, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  const protocol = structuredClone(DRY_EYE_IPL_INIT_PROTOCOL);
  protocol.id = "offered-test";
  protocol.items[0].procedureDefinitionKey = DRY_EYE_PROCEDURE_STABLE_KEYS.ipl;
  await service.definitions.save(protocol);
  await fhir.create({ resourceType: "Condition", id: "dx", subject: { reference: "Patient/p" }, verificationStatus: { coding: [{ code: "confirmed" }] }, code: { coding: [{ code: "H16.223" }] } });
  const body = { protocolId: protocol.id, patientId: "p", encounterId: "e", diagnosis: { reference: "Condition/dx", code: "H16.223", confirmed: true } };
  return { fhir, service, protocol, body, deps: endpointDeps(fhir), definition };
}
test("offered uses the explicit procedure link and active switch", async () => {
  const { protocol, definition } = await setup(false);
  assert.equal(isPlanItemOffered(protocol.items[0], new Map([[definition.stableKey, { ...definition, active: false }]])), false);
  assert.equal(isPlanItemOffered(protocol.items[0], new Map()), false);
  assert.equal(isPlanItemOffered(protocol.items[0], new Map([[definition.stableKey, definition]])), true);
  assert.equal(isPlanItemOffered(protocol.items[1], new Map()), true);
});
test("unoffered whole apply opts out series and its package before series resolution; item add refuses", async () => {
  const { fhir, deps, body } = await setup(false);
  const result = await handleProtocolApplyRequest(deps, { authHeader: "test", body });
  assert.equal(result.status, 200);
  const saved = result.body as { application: { dispositions: unknown[]; dedupResolutions: unknown[] }; actions: unknown[]; charges: unknown[] };
  assert.deepEqual(saved.application.dispositions, [ { itemKey: "series-ipl", outcome: "opted-out" }, { itemKey: "charge-ipl-package", outcome: "opted-out" } ]);
  assert.deepEqual(saved.application.dedupResolutions, [ { itemKey: "series-ipl", reason: "not-offered" }, { itemKey: "charge-ipl-package", reason: "not-offered" } ]);
  assert.equal(saved.actions.length, 0); assert.equal(saved.charges.length, 0);
  assert.equal(fhir.rows.filter(row => row.resourceType === "CarePlan").length, 0);
  const added = await handleProtocolItemAddRequest(deps, { authHeader: "test", body: { ...body, itemKey: "series-ipl" } });
  assert.equal(added.status, 409);
});
test("offers annotate every item and reload current offered definitions", async () => {
  const { deps, body, definition, fhir } = await setup(false);
  const request = { authHeader: "test", body: { diagnoses: [body.diagnosis] } };
  let result = await handleProtocolOffersRequest(deps, request);
  let protocol = (result.body as { protocols: Array<ProtocolDefinition & { items: Array<{ offered: boolean }> }> }).protocols.find(p => p.id === body.protocolId)!;
  assert.equal(protocol.items[0].offered, false);
  assert.equal(protocol.items[1].offered, true);
  await new FhirProcedureDefinitionStore(fhir).save({ ...definition, active: true });
  result = await handleProtocolOffersRequest(deps, request);
  protocol = (result.body as { protocols: Array<ProtocolDefinition & { items: Array<{ offered: boolean }> }> }).protocols.find(p => p.id === body.protocolId)!;
  assert.equal(protocol.items[0].offered, true);
});
test("offered series without active configuration keeps 400", async () => {
  const { fhir, deps, body } = await setup(true);
  const configuredDeps = { ...deps, serviceFhir: fhir as never };
  assert.equal((await handleProtocolApplyRequest(configuredDeps, { authHeader: "test", body })).status, 400);
  assert.equal((await handleProtocolItemAddRequest(configuredDeps, { authHeader: "test", body: { ...body, itemKey: "series-ipl" } })).status, 400);
});
