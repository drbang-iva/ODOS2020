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
