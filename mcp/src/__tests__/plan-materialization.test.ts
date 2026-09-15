import assert from "node:assert/strict";
import test from "node:test";
import { PlanAuthoringFhir, endpointDeps } from "./helpers/plan-authoring-fhir.js";
import { ProtocolService } from "../clinical-graph/protocol-service.js";
import { GLAUCOMA_SUSPECT_PROTOCOL_V1 as V1 } from "../clinical-graph/protocol-fixtures.js";
import { handleProtocolApplyRequest } from "../clinical-graph/protocol-endpoint.js";

test("plan order focus and counseling narrative reach FHIR projections", async () => {
  const fhir = new PlanAuthoringFhir();
  const service = new ProtocolService(fhir, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  const protocol = { ...structuredClone(V1), id: "projection-test", items: [
    { itemKey: "photo", itemType: "order" as const, title: "Optic nerve photos", defaultSelected: true, lateralityMode: "OU-always" as const, payload: { orderableKey: "fundus-photography", focus: "optic nerve" } },
    { itemKey: "counsel", itemType: "counseling" as const, title: "Counseling", defaultSelected: true, lateralityMode: "OU-always" as const, payload: { topicKey: "discussion", narrativeTemplate: "Synthetic counseling narrative." } },
  ] };
  await service.definitions.save(protocol);
  await fhir.create({ resourceType: "Condition", id: "dx", subject: { reference: "Patient/p" }, verificationStatus: { coding: [{ code: "confirmed" }] }, code: { coding: [{ code: "H40.003" }] } });
  const result = await handleProtocolApplyRequest(endpointDeps(fhir), { authHeader: "test", body: { protocolId: protocol.id, patientId: "p", encounterId: "e", diagnosis: { reference: "Condition/dx", code: "H40.003", confirmed: true } } });
  assert.equal(result.status, 200);
  const order = fhir.rows.find(row => row.resourceType === "ServiceRequest");
  assert.equal(order?.resourceType, "ServiceRequest");
  if (order?.resourceType !== "ServiceRequest") return;
  assert.deepEqual(order.bodySite, [{ text: "optic nerve" }]);
  assert.deepEqual(order.orderDetail, [{ text: "optic nerve" }]);
  const counseling = fhir.rows.find(row => row.resourceType === "CarePlan");
  assert.equal(counseling?.resourceType === "CarePlan" && counseling.description, "Synthetic counseling narrative.");
});

test("real education is recorded with the catalog title and truthful delivery note", async () => {
  const fhir = new PlanAuthoringFhir();
  const service = new ProtocolService(fhir, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  const protocol = { ...structuredClone(V1), id: "education-projection-test", items: [
    { itemKey: "handout", itemType: "education" as const, defaultSelected: true, lateralityMode: "OU-always" as const, payload: { assetRef: "synthetic-real-handout" } },
  ] };
  await service.definitions.save(protocol);
  await fhir.create({ resourceType: "Condition", id: "dx", subject: { reference: "Patient/p" }, verificationStatus: { coding: [{ code: "confirmed" }] }, code: { coding: [{ code: "H40.003" }] } });
  const entry = { id: "synthetic-real-handout", version: 1, title: "Synthetic real catalog title", kind: "handout" as const, audience: "patient" as const, dxCodes: [], channels: ["print" as const], laneHint: "clinical" as const, consentClass: "transactional" as const, urls: { print: "https://synthetic.example/handout" } };
  const result = await handleProtocolApplyRequest({ ...endpointDeps(fhir), educationCatalog: { placeholderUrlHost: "education.invalid", list: () => [entry], get: id => id === entry.id ? entry : undefined } }, { authHeader: "test", body: { protocolId: protocol.id, patientId: "p", encounterId: "e", diagnosis: { reference: "Condition/dx", code: "H40.003", confirmed: true } } });
  assert.equal(result.status, 200);
  const education = fhir.rows.find(row => row.resourceType === "CarePlan");
  assert.equal(education?.resourceType === "CarePlan" && education.title, entry.title);
  assert.deepEqual(education?.resourceType === "CarePlan" && education.note, [{ text: "Handout recorded; delivery is not yet tracked" }]);
  assert.doesNotMatch(JSON.stringify(education), /given/);
});
