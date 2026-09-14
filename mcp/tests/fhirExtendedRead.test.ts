import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient, Task } from "@medplum/fhirtypes";
import { createMedplumClient, type FhirAuditRecorder } from "../src/fhir-client.js";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";

function fixture() {
  const rows: OdosAuditEventRecord[] = [];
  const denied: OdosAuditEventRecord[] = [];
  const audit: FhirAuditRecorder = {
    async record(row, operation) { rows.push(row); return operation(); },
    async recordDenied(row) { denied.push(row); },
  };
  return {
    rows, denied,
    client: createMedplumClient({ baseUrl: "http://medplum.test", accessToken: "synthetic-service-token", audit, auditContext: { actorId: "service", actorRole: "system" } }),
  };
}

test("extended read requests author and project metadata while ordinary reads keep their header behavior", async () => {
  const { client, rows } = fixture();
  const requests: Array<{ url: string; extended: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const header = new Headers(init?.headers);
    requests.push({ url: String(input), extended: header.get("X-Medplum") });
    assert.equal(header.get("Authorization"), "Bearer synthetic-service-token");
    return Response.json({ resourceType: "Task", id: "operation", intent: "order", status: "in-progress", meta: header.get("X-Medplum") === "extended" ? { project: "practice", author: { reference: "ClientApplication/service" } } : {} });
  };
  try {
    const extended = await client.readExtended<Task>("Task", "operation");
    const ordinary = await client.read<Task>("Task", "operation");
    assert.equal(extended.meta?.author?.reference, "ClientApplication/service");
    assert.equal(extended.meta?.project, "practice");
    assert.equal(ordinary.meta?.author, undefined);
    assert.deepEqual(requests, [
      { url: "http://medplum.test/fhir/R4/Task/operation", extended: "extended" },
      { url: "http://medplum.test/fhir/R4/Task/operation", extended: null },
    ]);
    assert.deepEqual(rows.map(({ eventType, resourceType, resourceId, actorId }) => ({ eventType, resourceType, resourceId, actorId })), [
      { eventType: "read", resourceType: "Task", resourceId: "operation", actorId: "service" },
      { eventType: "read", resourceType: "Task", resourceId: "operation", actorId: "service" },
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test("extended read denial retains patient audit attribution and safe error context", async () => {
  const { client, rows, denied } = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" });
  try {
    await assert.rejects(client.readExtended<Patient>("Patient", "patient-sensitive"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /FHIR GET \/fhir\/R4\/Patient\/:id \[Patient\] 403 Forbidden/);
      assert.doesNotMatch(error.message, /patient-sensitive|synthetic-service-token/);
      return true;
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].patientId, "patient-sensitive");
    assert.equal(denied.length, 1);
    assert.equal(denied[0].eventType, "denied");
    assert.equal(denied[0].patientId, "patient-sensitive");
  } finally { globalThis.fetch = originalFetch; }
});

test("authenticated profile reference comes from the current session for client and practitioner identities", async () => {
  const { client } = fixture();
  const originalFetch = globalThis.fetch;
  let profile = { resourceType: "ClientApplication", id: "service" };
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://medplum.test/auth/me");
    return Response.json({ project: { id: "practice" }, profile });
  };
  try {
    assert.equal(await client.getAuthenticatedProfileReference(), "ClientApplication/service");
    profile = { resourceType: "Practitioner", id: "service-practitioner" };
    assert.equal(await client.getAuthenticatedProfileReference(), "Practitioner/service-practitioner");
    assert.equal(await client.getActiveProjectId(), "practice");
  } finally { globalThis.fetch = originalFetch; }
});

test("authenticated profile reference refuses malformed or absent identities", async () => {
  const { client } = fixture();
  const originalFetch = globalThis.fetch;
  try {
    for (const profile of [undefined, null, {}, { resourceType: "ClientApplication" }, { resourceType: "ClientApplication", id: "wrong/id" }, { resourceType: "not/a/type", id: "service" }, { resourceType: "ClientApplication", id: 42 }]) {
      globalThis.fetch = async () => Response.json({ project: { id: "practice" }, profile });
      await assert.rejects(client.getAuthenticatedProfileReference(), /no valid authenticated Medplum profile/);
    }
    globalThis.fetch = async () => Response.json(null);
    await assert.rejects(client.getAuthenticatedProfileReference(), /no valid authenticated Medplum profile/);
  } finally { globalThis.fetch = originalFetch; }
});
