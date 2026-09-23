import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Appointment, Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import express from "express";
import { createLiveAuthorizationClients } from "./integration-helpers.js";
import { TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";
import { authenticateStaffRoute } from "../src/payments/payment-endpoint.js";
import { registerEncounterAbandonRoutes } from "../src/clinical-graph/encounter-abandon-routes.js";
import { searchAll } from "../src/fhir-search.js";
import { startOrOpenEncounterForAppointment } from "../../ui/src/lib/encounter-bundles.js";

interface Fixture {
  patientId: string;
  identities: Record<"staff" | "provider", { token: string; profile: string; policy: string }>;
}
const fixturePath = process.env.ODOS_S0_ABANDON_FIXTURE;
async function live() {
  assert.equal(process.env.MEDPLUM_BASE_URL, "http://localhost:18103/");
  const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as Fixture;
  const baseUrl = process.env.MEDPLUM_BASE_URL!;
  const { seederFhir, callerFhir } = await createLiveAuthorizationClients({ baseUrl, email: process.env.MEDPLUM_ADMIN_EMAIL!, password: process.env.MEDPLUM_ADMIN_PASSWORD! });
  const caller = async (role: "staff" | "provider") => {
    const identity = await authenticateStaffRoute({ baseUrl, authHeader: `Bearer ${fixture.identities[role].token}`, serviceClient: callerFhir, audit: TEST_FHIR_AUDIT_RECORDER });
    assert.ok(identity);
    assert.deepEqual(identity.roles, [role], "permission evidence requires a single-role human");
    assert.equal(identity.staffReference, fixture.identities[role].profile);
    assert.match(identity.staffReference, /^Practitioner\//);
    return identity;
  };
  const encounter = (status: Encounter["status"]) => seederFhir.create<Encounter>({ resourceType: "Encounter", status, class: { code: "AMB" }, subject: { reference: `Patient/${fixture.patientId}` } });
  return { fixture, baseUrl, seederFhir, callerFhir, caller, encounter };
}

test("A8 real provider policy refuses signed cancellation and preserves the unsigned raw PATCH limit", { skip: !fixturePath }, async () => {
  const l = await live(); await l.caller("provider");
  const patch = async (id: string) => fetch(`${l.baseUrl}fhir/R4/Encounter/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${l.fixture.identities.provider.token}`, "Content-Type": "application/json-patch+json" }, body: JSON.stringify([{ op: "replace", path: "/status", value: "cancelled" }]) });
  const signed = await l.encounter("finished");
  const refused = await patch(signed.id!);
  assert.equal(refused.status, 403, "provider raw signed cancellation must be refused by installed policy");
  assert.equal((await l.seederFhir.read<Encounter>("Encounter", signed.id!)).status, "finished");
  const unfinished = await l.encounter("in-progress");
  const allowed = await patch(unfinished.id!);
  assert.equal(allowed.status, 200, "unsigned raw cancellation remains the stated limit");
  assert.equal((await l.seederFhir.read<Encounter>("Encounter", unfinished.id!)).status, "cancelled");
});

test("A12 live staff Start-exam walkout succeeds; finding and signed visits refuse through HTTP", { skip: !fixturePath }, async () => {
  const l = await live(); const staff = await l.caller("staff"); await l.caller("provider");
  const app = express();
  registerEncounterAbandonRoutes(app, async () => {}, async () => ({ authenticate: authHeader => authenticateStaffRoute({ baseUrl: l.baseUrl, authHeader, serviceClient: l.callerFhir, audit: TEST_FHIR_AUDIT_RECORDER }) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const abandon = (id: string, role: "staff" | "provider") => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/clinical-graph/encounters/${id}/abandon`, { method: "POST", headers: { Authorization: `Bearer ${l.fixture.identities[role].token}` } });
  try {
    const appointment = await staff.fhir.create<Appointment>({ resourceType: "Appointment", status: "checked-in", start: "2026-09-23T14:00:00Z", end: "2026-09-23T14:30:00Z", participant: [{ actor: { reference: `Patient/${l.fixture.patientId}` }, status: "accepted" }] });
    const { encounterId } = await startOrOpenEncounterForAppointment(appointment, { client: { search: staff.fhir.search, executeTransaction: (bundle, source) => staff.fhir.executeTransaction(bundle, { "X-ODOS-Source": `ui/${source}` }) } });
    assert.equal((await staff.fhir.read<Encounter>("Encounter", encounterId)).status, "in-progress");
    const empty = await abandon(encounterId, "staff");
    assert.equal(empty.status, 200, "fresh check-in -> Start exam must have no blocking dependencies");
    const closed = await staff.fhir.read<Encounter>("Encounter", encounterId);
    assert.equal(closed.status, "cancelled"); assert.deepEqual(closed.reasonCode, [{ text: "abandoned" }]);
    const provenance = await searchAll<Provenance>(staff.fhir, "Provenance", { target: `Encounter/${encounterId}` });
    assert.ok(provenance.some(row => row.agent.some(agent => agent.onBehalfOf?.reference === staff.staffReference && agent.who.display === "ODOS UI abandon_encounter")));
    const examined = await l.encounter("in-progress");
    await l.seederFhir.create<Observation>({ resourceType: "Observation", status: "preliminary", code: { text: "Synthetic S0 finding" }, subject: { reference: `Patient/${l.fixture.patientId}` }, encounter: { reference: `Encounter/${examined.id}` } });
    const before = await staff.fhir.read<Encounter>("Encounter", examined.id!);
    const content = await abandon(examined.id!, "staff");
    assert.equal(content.status, 409);
    assert.deepEqual(await content.json(), { code: "encounter-has-content", content: [{ kind: "Observation", count: 1 }] });
    assert.deepEqual(await staff.fhir.read<Encounter>("Encounter", examined.id!), before);
    const signed = await l.encounter("finished");
    const signedResponse = await abandon(signed.id!, "provider");
    assert.equal(signedResponse.status, 409); assert.deepEqual(await signedResponse.json(), { code: "encounter-signed" });
    assert.equal((await l.seederFhir.read<Encounter>("Encounter", signed.id!)).status, "finished");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
