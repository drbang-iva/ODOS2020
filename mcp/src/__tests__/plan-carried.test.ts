import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { PlanAuthoringFhir, endpointDeps } from "./helpers/plan-authoring-fhir.js";
import { ProtocolService } from "../clinical-graph/protocol-service.js";
import { GLAUCOMA_SUSPECT_PROTOCOL_V1 as V1 } from "../clinical-graph/protocol-fixtures.js";
import { handleProtocolApplyRequest, handleProtocolUnapplyRequest, handleProtocolFollowUpConfirmRequest } from "../clinical-graph/protocol-endpoint.js";
import type { Resource, ServiceRequest } from "@medplum/fhirtypes";

function payload(resource: Resource) {
  return resource.resourceType === "Basic" && resource.extension?.[0]?.valueString ? JSON.parse(resource.extension[0].valueString) : undefined;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(itemKey = "rto-6mo") {
  const fhir = new PlanAuthoringFhir();
  const service = new ProtocolService(fhir, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  const protocol = { ...structuredClone(V1), id: "carried-test", items: V1.items.filter(item => item.itemKey === itemKey) };
  await service.definitions.save(protocol);
  await fhir.create({ resourceType: "Condition", id: "dx", subject: { reference: "Patient/p" }, verificationStatus: { coding: [{ code: "confirmed" }] }, code: { coding: [{ code: "H40.003" }] } });
  const deps = endpointDeps(fhir);
  const body = { protocolId: protocol.id, patientId: "p", encounterId: "e", diagnosis: { reference: "Condition/dx", code: "H40.003", confirmed: true } };
  const apply = (protocolId = protocol.id) => handleProtocolApplyRequest(deps, { authHeader: "test", body: { ...body, protocolId } });
  const undo = (applicationId: string) => handleProtocolUnapplyRequest(deps, { authHeader: "test", params: { applicationId } });
  const confirm = (actionId: string, body: unknown = {}) => handleProtocolFollowUpConfirmRequest(deps, { authHeader: "test", params: { encounterId: "e", actionId }, body });
  return { fhir, service, protocol, apply, undo, confirm };
}

test("carried apply maps the losing whole-apply commit race to 409", async () => {
  const h = await fixture();
  const results = await Promise.all([h.apply(), h.apply()]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await h.service.applications.list()).filter(a => a.confirmed).length, 1);
});

test("carried unapply maps a conditional application save conflict to 409", async () => {
  const h = await fixture();
  await h.apply();
  const app = (await h.service.applications.list())[0];
  h.fhir.beforeUpdate = async resource => {
    if (payload(resource)?.undoState === "unapplied") {
      h.fhir.beforeUpdate = undefined;
      const row = h.fhir.rows.find(row => row.id === resource.id)!;
      row.meta!.versionId = String(Number(row.meta!.versionId) + 1);
    }
  };
  assert.equal((await h.undo(app.id)).status, 409);
  assert.equal((await h.service.applications.get(app.id))?.undoState, "active");
});

test("carried confirm checks liveness after the encounter lock and returns 404", async () => {
  const h = await fixture();
  await h.apply();
  const action = (await h.service.actions.list())[0];
  const entered = deferred(); const release = deferred();
  h.fhir.beforeUpdate = async resource => {
    if (payload(resource)?.undoState === "unapplied") {
      entered.resolve(); await release.promise;
      h.fhir.beforeUpdate = undefined;
    }
  };
  const app = (await h.service.applications.list())[0];
  const undoing = h.undo(app.id);
  await entered.promise;
  const confirming = h.confirm(action.id);
  await setImmediate();
  release.resolve();
  assert.equal((await undoing).status, 200);
  assert.equal((await confirming).status, 404);
  assert.equal((await h.service.actions.get(action.id))?.state, "removed");
});

for (const interval of [4, 6]) test(`carried undo preserves clinician resolution at ${interval} months`, async () => {
  const h = await fixture();
  await h.apply();
  const poag = { ...structuredClone(h.protocol), id: "second-plan", items: h.protocol.items.map(item => ({ ...item, payload: { ...item.payload, interval: 3 } })) };
  await h.service.definitions.save(poag); await h.apply(poag.id);
  const action = (await h.service.actions.list()).find(a => a.state !== "removed")!;
  assert.equal(action.payload.needsConfirmation, true);
  assert.equal((await h.confirm(action.id, { interval, unit: "months" })).status, 200);
  const app = (await h.service.applications.list()).find(a => a.protocolId === poag.id)!;
  assert.equal((await h.undo(app.id)).status, 200);
  const after = (await h.service.actions.get(action.id))!;
  assert.equal(after.payload.interval, interval);
  assert.equal(after.payload.needsConfirmation, false);
  if (interval === 6) assert.equal(after.payload.alternatives, undefined);
  else assert.equal((after.payload.alternatives as Array<{applicationId: string}>).some(a => a.applicationId === app.id), false);
});

for (const [itemKey, type] of [["order-gonioscopy", "ServiceRequest"], ["counsel-suspect", "CarePlan"], ["cd-ratio", "Observation"]] as const) {
  test(`carried ${type} rollback reports a newer version conflict without overwriting it`, async () => {
    const h = await fixture(itemKey); await h.apply();
    const app = (await h.service.applications.list())[0];
    let newer: Resource | undefined;
    h.fhir.beforeUpdate = async resource => {
      const row = payload(resource);
      if (row?.state === "removed" && (row.materializedFhirRef || row.observationReference)) {
        h.fhir.beforeUpdate = undefined;
        const reference = row.materializedFhirRef ?? row.observationReference;
        const [kind, id] = reference.split("/");
        const projection = await h.fhir.read(kind, id);
        newer = await h.fhir.update(kind, id, { ...projection, language: "fr" });
        throw new Error("Synthetic Basic removal failure");
      }
    };
    await assert.rejects(h.undo(app.id), /rollback.*412|412.*rollback/i);
    assert.ok(newer);
    assert.deepEqual(await h.fhir.read(type, newer.id!), newer);
  });
}

for (const missingVersion of [false, true]) test(`carried rollback ${missingVersion ? "refuses missing revoke version" : "restores the captured version conditionally"}`, async () => {
  const h = await fixture("order-gonioscopy"); await h.apply();
  const app = (await h.service.applications.list())[0];
  const original = structuredClone(h.fhir.rows.find(r => r.resourceType === "ServiceRequest")!);
  const update = h.fhir.update;
  h.fhir.update = async (...args) => {
    const result = await update(...args);
    if (missingVersion && result.resourceType === "ServiceRequest" && result.status === "revoked") delete result.meta?.versionId;
    return result;
  };
  h.fhir.beforeUpdate = async resource => {
    if (payload(resource)?.state === "removed") {
      h.fhir.beforeUpdate = undefined;
      throw new Error("Synthetic Basic removal failure");
    }
  };
  await assert.rejects(h.undo(app.id), missingVersion ? /rollback refused.*no versionId/ : /Synthetic Basic removal failure/);
  const after = await h.fhir.read<ServiceRequest>("ServiceRequest", original.id!);
  if (missingVersion) {
    assert.equal(after.status, "revoked");
    assert.equal(after.meta?.versionId, "2");
  } else {
    assert.deepEqual({ ...after, meta: undefined }, { ...original, meta: undefined });
    assert.equal(after.meta?.versionId, "3");
    assert.equal([...h.fhir.writes].reverse().find(w => w.resource.id === original.id)?.headers?.["If-Match"], 'W/"2"');
    assert.equal((await h.service.applications.get(app.id))?.undoState, "active");
  }
});
