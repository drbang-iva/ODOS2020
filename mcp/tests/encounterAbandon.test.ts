import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Bundle, Encounter, Resource } from "@medplum/fhirtypes";
import express from "express";
import { handleEncounterAbandonRequest, type EncounterAbandonEndpointDeps, type EncounterAbandonFhirClient } from "../src/clinical-graph/encounter-abandon-endpoint.js";
import { registerEncounterAbandonRoutes } from "../src/clinical-graph/encounter-abandon-routes.js";
import { buildProtocolBasic, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";
import { MIGRATION_TAG_SYSTEM, MIGRATION_TAG_CODE } from "../src/legacy-import/access-policy.js";

const kinds = ["Observation", "Condition", "Procedure", "DiagnosticReport", "DocumentReference", "Media", "QuestionnaireResponse", "ServiceRequest", "MedicationRequest", "MedicationStatement", "MedicationAdministration", "DeviceRequest", "CarePlan", "ChargeItem", "ChargeProposal", "PlanActionInstance"] as const;
function fixture(status: Encounter["status"] = "in-progress") {
  const encounter: Encounter = { resourceType: "Encounter", id: "e1", meta: { versionId: "7" }, status, class: { code: "AMB" }, subject: { reference: "Patient/p1" } };
  const rows: Resource[] = [], transactions: Bundle[] = [], searches: string[] = [];
  let reads = 0;
  const fhir = {
    baseUrl: "http://localhost:18103/",
    read: async () => { reads++; return structuredClone(encounter); },
    search: async (kind: string, params: Record<string, string>) => {
      searches.push(kind);
      if (kind !== "Basic") assert.equal(params[["MedicationStatement", "MedicationAdministration", "ChargeItem"].includes(kind) ? "context" : "encounter"], "Encounter/e1");
      return { resourceType: "Bundle", type: "searchset", entry: rows.filter(row => row.resourceType === kind && (kind !== "Basic" || (row as any).code.coding.some((c: any) => params.code.endsWith(`|${c.code}`)))).map(resource => ({ resource })) };
    },
    create: async () => { assert.fail("no separate writes"); },
    update: async () => { assert.fail("no separate writes"); },
    executeTransaction: async (bundle: Bundle) => {
      transactions.push(bundle);
      const binary = bundle.entry?.[0]?.resource as any;
      const ops = JSON.parse(Buffer.from(binary.data, "base64").toString());
      for (const op of ops) if (op.path === "/status") encounter.status = op.value;
      return { resourceType: "Bundle", type: "transaction-response", entry: bundle.entry?.map(entry => ({ response: { status: entry.request?.method === "POST" ? "201 Created" : "200 OK" } })) };
    },
  } as unknown as EncounterAbandonFhirClient;
  const staff = { staffReference: "Practitioner/staff-only", actorRole: "staff" as const, fhir };
  const deps: EncounterAbandonEndpointDeps = { authenticate: async () => staff, now: () => "2026-09-23T14:00:00Z" };
  return { encounter, rows, transactions, searches, fhir, deps, reads: () => reads };
}
const request = { authHeader: "Bearer synthetic", params: { encounterId: "e1" } };
function dependency(kind: typeof kinds[number], state?: string): Resource {
  if (kind === "ChargeProposal" || kind === "PlanActionInstance") return buildProtocolBasic({ id: `synthetic-${kind}`, encounterId: "e1", state: state ?? (kind === "ChargeProposal" ? "staged" : "selected"), actionType: "order" }, kind === "ChargeProposal" ? PROTOCOL_BASIC_CODES.chargeProposal : PROTOCOL_BASIC_CODES.planActionInstance);
  return { resourceType: kind, id: "content", status: state ?? "active", ...(kind === "Condition" ? { verificationStatus: { coding: [{ code: state ?? "confirmed" }] } } : {}) } as Resource;
}

test("A1 empty unfinished staff visit cancels with version guard and caller Provenance", async () => {
  const f = fixture();
  assert.equal((await handleEncounterAbandonRequest(f.deps, request)).status, 200);
  assert.equal(f.encounter.status, "cancelled");
  assert.equal(f.transactions.length, 1);
  const entries = f.transactions[0].entry!;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].request, { method: "PATCH", url: "Encounter/e1", ifMatch: 'W/"7"' });
  const binary = entries[0].resource as any;
  assert.equal(binary.contentType, "application/json-patch+json");
  assert.deepEqual(JSON.parse(Buffer.from(binary.data, "base64").toString()), [{ op: "replace", path: "/status", value: "cancelled" }, { op: "add", path: "/reasonCode", value: [{ text: "abandoned" }] }]);
  const provenance = entries[1].resource as any;
  assert.equal(provenance.resourceType, "Provenance");
  assert.deepEqual(provenance.target, [{ reference: "Encounter/e1" }, { reference: "Patient/p1" }]);
  assert.equal(provenance.agent[0].onBehalfOf.reference, "Practitioner/staff-only");
});
for (const kind of kinds) test(`A2 ${kind} refuses at the handler with zero writes`, async () => {
  const f = fixture(); f.rows.push(dependency(kind));
  const result = await handleEncounterAbandonRequest(f.deps, request);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { code: "encounter-has-content", content: [{ kind, count: 1 }] });
  assert.equal(f.transactions.length, 0);
  assert.equal(f.encounter.status, "in-progress");
});
test("A3 removed charge proposal does not block", async () => {
  const f = fixture(); f.rows.push(dependency("ChargeProposal", "removed"));
  assert.equal((await handleEncounterAbandonRequest(f.deps, request)).status, 200);
});
test("A4 finished provider visit refuses with zero writes", async () => {
  const f = fixture("finished");
  f.deps.authenticate = async () => ({ staffReference: "Practitioner/provider-only", actorRole: "provider", fhir: f.fhir });
  assert.deepEqual(await handleEncounterAbandonRequest(f.deps, request), { status: 409, body: { code: "encounter-signed" } });
  assert.equal(f.transactions.length, 0); assert.equal(f.searches.length, 0);
});
for (const status of ["cancelled", "entered-in-error"] as const) test(`A5 ${status} refuses`, async () => {
  const f = fixture(status);
  assert.deepEqual(await handleEncounterAbandonRequest(f.deps, request), { status: 409, body: { code: "encounter-closed" } });
  assert.equal(f.transactions.length, 0);
});
test("A6 migrated refuses", async () => {
  const f = fixture(); f.encounter.meta!.tag = [{ system: MIGRATION_TAG_SYSTEM, code: MIGRATION_TAG_CODE }];
  assert.deepEqual(await handleEncounterAbandonRequest(f.deps, request), { status: 409, body: { code: "encounter-migrated" } });
  assert.equal(f.transactions.length, 0);
});
test("A7 revoked chart.write refuses before dependency reads", async () => {
  const f = fixture(); f.deps.authenticate = async () => ({ staffReference: "Practitioner/staff-only", actorRole: "staff", businessActions: [], fhir: f.fhir });
  assert.equal((await handleEncounterAbandonRequest(f.deps, request)).status, 403);
  assert.equal(f.reads(), 0); assert.equal(f.searches.length, 0); assert.equal(f.transactions.length, 0);
});
for (const kind of kinds.filter(k => !["ChargeProposal", "PlanActionInstance"].includes(k))) test(`retracted ${kind} does not block`, async () => {
  const f = fixture(); f.rows.push(dependency(kind, "entered-in-error"));
  assert.equal((await handleEncounterAbandonRequest(f.deps, request)).status, 200);
});
for (const state of ["accepted", "overridden", "finalized"] as const) test(`${state} charge proposal refuses`, async () => {
  const f = fixture(); f.rows.push(dependency("ChargeProposal", state));
  assert.equal((await handleEncounterAbandonRequest(f.deps, request)).status, 409); assert.equal(f.transactions.length, 0);
});
for (const state of ["removed", "cancelled"] as const) test(`${state} plan action does not block`, async () => {
  const f = fixture(); f.rows.push(dependency("PlanActionInstance", state));
  assert.equal((await handleEncounterAbandonRequest(f.deps, request)).status, 200);
});
test("authentication and missing Encounter refuse without writes", async () => {
  const f = fixture(); f.deps.authenticate = async () => null;
  assert.equal((await handleEncounterAbandonRequest(f.deps, request)).status, 401);
  assert.equal(f.reads(), 0);
  f.deps.authenticate = async () => ({ staffReference: "Practitioner/staff-only", actorRole: "staff", fhir: f.fhir });
  f.fhir.read = async () => { throw new Error("not found"); };
  assert.equal((await handleEncounterAbandonRequest(f.deps, request)).status, 404);
  assert.equal(f.transactions.length, 0);
});
for (const kind of ["ChargeItem", "ChargeProposal"] as const) test(`money guard ${kind} runs through the registered HTTP handler`, async () => {
  const f = fixture(); f.rows.push(dependency(kind));
  const app = express(); registerEncounterAbandonRoutes(app, async () => {}, async () => f.deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/clinical-graph/encounters/e1/abandon`, { method: "POST", headers: { Authorization: request.authHeader } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: "encounter-has-content", content: [{ kind, count: 1 }] });
    assert.equal(f.transactions.length, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
