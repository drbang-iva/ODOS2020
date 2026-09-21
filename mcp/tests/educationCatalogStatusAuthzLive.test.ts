import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AccessPolicy, Bundle, ProjectMembership } from "@medplum/fhirtypes";
import type { MedplumClient } from "../src/fhir-client.js";
import { test } from "node:test";
import express from "express";
import { registerCommsApiRoutes, type CommsApiRouteDeps } from "../src/comms/comms-api.js";
import { createEducationCatalogFromEnv } from "../src/comms/visionforge-education-catalog.js";
import { authenticateStaffRoute } from "../src/payments/payment-endpoint.js";
import { createLiveAuthorizationClients, requireMedplumAdmin } from "./integration-helpers.js";
import { TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";

test("catalog staff routes use real Medplum canonical authorization and reject anonymous requests", async t => {
  const credentials = requireMedplumAdmin(t, "educationCatalogStatusAuthzLive");
  if (!credentials) return;
  const baseUrl = process.env.MEDPLUM_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8103";
  const { callerFhir, callerAccessToken } = await createLiveAuthorizationClients({ baseUrl, ...credentials });
  const meResponse = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${callerAccessToken}` } });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json() as { project?: { id?: string }; membership?: { id?: string } };
  assert.ok(me.project?.id && me.membership?.id);
  // The operator seeder is deliberately denied ProjectMembership FHIR reads. Read the
  // caller's actual stored membership from Medplum, then let the real resolver classify it.
  const serviceClient = {
    async search(resourceType: string, query: { profile?: string }): Promise<Bundle<ProjectMembership>> {
      assert.equal(resourceType, "ProjectMembership");
      const response = await fetch(`${baseUrl}/admin/projects/${me.project!.id}/members/${me.membership!.id}`, {
        headers: { Authorization: `Bearer ${callerAccessToken}` },
      });
      assert.equal(response.status, 200);
      const membership = await response.json() as ProjectMembership;
      assert.equal(membership.profile.reference, query.profile);
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: membership }] };
    },
    read: (resourceType: string, id: string) => callerFhir.read<AccessPolicy>(resourceType, id),
  } as Pick<MedplumClient, "search" | "read">;
  const authenticate = (authHeader: string | undefined) => authenticateStaffRoute({ baseUrl, authHeader,
    serviceClient, audit: TEST_FHIR_AUDIT_RECORDER });
  const staff = await authenticate(`Bearer ${callerAccessToken}`);
  assert.ok(staff, "real staff token resolves through the synced canonical policy");
  assert.ok(["admin", "provider", "staff"].includes(staff.actorRole));
  for (const action of ["communications.read", "communications.content.read", "communications.send"] as const) {
    assert.ok(staff.businessActions.includes(action), "P14 communications actions are baseline and non-revocable");
  }
  const catalog = createEducationCatalogFromEnv({});
  const app = express(); app.use(express.json());
  const unused = () => { throw new Error("Catalog status routes must not access patient content or dispatch"); };
  registerCommsApiRoutes(app, { authenticateService: async () => {}, authenticate,
    fhir: callerFhir, educationCatalog: catalog, educationCatalogControl: catalog,
    dispatch: new Proxy({}, { get: unused }), trackedLinkStore: new Proxy({}, { get: unused }),
    publicBaseUrl: "https://synthetic.example.test", practiceName: "Synthetic O1",
    audit: TEST_FHIR_AUDIT_RECORDER,
  } as CommsApiRouteDeps);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [path, method] of [["status", "GET"], ["refresh", "POST"]]) {
    for (const authenticated of [true, false]) await t.test(`${path} ${authenticated ? "canonical staff 200" : "unauthenticated 401"}`, async () => {
      const response = await fetch(`${origin}/communications/education/catalog/${path}`, { method,
        headers: authenticated ? { Authorization: `Bearer ${callerAccessToken}` } : {} });
      const body = await response.text();
      assert.equal(response.status, authenticated ? 200 : 401, body);
      if (authenticated) assert.equal(JSON.parse(body).state, "seed-placeholder");
      for (const value of [callerAccessToken, process.env.VISIONFORGE_SEAM_TOKEN, process.env.VISIONFORGE_BASE_URL, baseUrl].filter(Boolean)) {
        assert.equal(body.includes(value!), false, "response does not expose credentials or backend URLs");
      }
      assert.doesNotMatch(body, /education\.invalid|"items"|"token"|"baseUrl"/);
    });
  }
});

test("H live staff decision refuses address-suppressed household through service boolean reader", async t => {
  const credentials = requireMedplumAdmin(t, "emailUnsubscribeAuthzLive");
  if (!credentials) return;
  const baseUrl = process.env.MEDPLUM_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8103";
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Unsubscribe proof requires local synthetic Medplum");
  const { randomUUID, generateKeyPairSync } = await import("node:crypto");
  const { createRoleClient, cleanupReferences } = await import("./liveRoleClient.js");
  const { createMedplumClient } = await import("../src/fhir-client.js");
  const { TEST_FHIR_AUDIT_CONTEXT } = await import("./fhirAuditTestStub.js");
  const { createFhirEmailUnsubscribeStore, createEmailAddressSuppressionReader, issueUnsubscribeToken, registerEmailUnsubscribeRoutes, readEmailAddressSuppression } = await import("../src/comms/email-unsubscribe.js");
  const { createCommsDispatch, commsAdapterRegistrationsFromEnv } = await import("../src/comms/comms-config.js");
  const { ODOS_PRACTICE_ROLE_SYSTEM } = await import("../src/authz/roles.js");
  const { seederFhir, seederAccessToken, callerFhir, callerAccessToken } = await createLiveAuthorizationClients({ baseUrl, ...credentials });
  const projectId = await callerFhir.getActiveProjectId();
  const practitionerReference = await callerFhir.getAuthenticatedProfileReference();
  const cleanup: string[] = [];
  const track = <T extends import("@medplum/fhirtypes").Resource>(resource: T): T => { assert.ok(resource.id); cleanup.push(`${resource.resourceType}/${resource.id}`); return resource; };
  t.after(async () => {
    for (const reference of cleanup.filter(r => r.startsWith("ProjectMembership/"))) {
      const response = await fetch(`${baseUrl}/admin/projects/${projectId}/members/${reference.split("/")[1]}`, { method: "DELETE", headers: { Authorization: `Bearer ${callerAccessToken}` } });
      assert.ok([200, 204, 404, 410].includes(response.status));
    }
    await cleanupReferences(baseUrl, seederAccessToken, cleanup.filter(r => !r.startsWith("ProjectMembership/")));
  });
  const runId = randomUUID();
  const email = `household-${runId}@example.invalid`;
  const a = track(await seederFhir.create({ resourceType: "Patient", telecom: [{ system: "email", value: email }] } as import("@medplum/fhirtypes").Patient));
  const b = track(await seederFhir.create({ resourceType: "Patient", telecom: [{ system: "email", value: email }] } as import("@medplum/fhirtypes").Patient));
  const policies = await callerFhir.search<AccessPolicy>("AccessPolicy", { _count: "100" });
  const policy = policies.entry?.map(e => e.resource).find(p => p?.meta?.tag?.some(tag => tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === "staff"));
  assert.ok(policy?.id);
  const { token: staffToken } = await createRoleClient({ baseUrl, roleId: "staff", policyReference: `AccessPolicy/${policy.id}`, patientReference: `Patient/${b.id}`, practitionerReference, projectId, runId, adminToken: callerAccessToken, track });
  const staffFhir = createMedplumClient({ baseUrl, accessToken: staffToken, audit: TEST_FHIR_AUDIT_RECORDER, auditContext: TEST_FHIR_AUDIT_CONTEXT });
  const registrations = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_EMAIL_PROVIDER: "google-workspace", GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "sender@synthetic-project.iam.gserviceaccount.com",
    GOOGLE_WORKSPACE_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    GOOGLE_WORKSPACE_DELEGATED_USER: "care@synthetic.example", GOOGLE_WORKSPACE_DOMAIN: "synthetic.example", GOOGLE_WORKSPACE_FROM_ADDRESS: "care@synthetic.example", GOOGLE_WORKSPACE_PLAN_CONFIRMED: "true",
    ODOS_PRACTICE_NAME: "Synthetic Eye Care", ODOS_PRACTICE_POSTAL_ADDRESS: "100 Example Street, Test City, NY 10001", ODOS_PRACTICE_PHONE: "+12025550101",
  });
  const dispatch = createCommsDispatch(registrations, { isEmailAddressSuppressed: createEmailAddressSuppressionReader(seederFhir), now: () => new Date("2026-09-20T15:00:00Z"), fetchImpl: async () => { throw new Error("Unsubscribe decision must not invoke vendor"); } });
  const adapter = dispatch.getAdapterForRole("email", staffFhir);
  const request = { patientReference: `Patient/${b.id}`, toAddress: email, campaignType: "clinical-education", subject: "Synthetic", body: "Synthetic", suppression: { consentClass: "marketing" as const } };
  assert.equal(await adapter.preflightSuppression!(request, "email"), undefined);
  const trackedFhir = { ...seederFhir, create: async <T extends import("@medplum/fhirtypes").Resource>(resource: T, headers?: Record<string, string>) => track(await seederFhir.create(resource, headers)) };
  const store = createFhirEmailUnsubscribeStore(trackedFhir);
  const issued = await issueUnsubscribeToken({ store, email, patientReference: `Patient/${a.id}`, publicBaseUrl: "https://practice.invalid" });
  const app = express(); app.use(express.urlencoded({ extended: false }));
  registerEmailUnsubscribeRoutes(app, { store, fhir: seederFhir });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/comms/u/${issued.token}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(response.status, 200); await response.text();
  assert.ok(await readEmailAddressSuppression(seederFhir, email));
  assert.equal(await readEmailAddressSuppression(staffFhir, email), undefined, "real staff policy filters the address receipt out");
  assert.deepEqual(await adapter.preflightSuppression!(request, "email"), { outcome: "suppressed", reason: "patient-opt-out" });
  t.diagnostic("Real staff Basic search: empty; service boolean: true; household decision: suppressed; vendor calls: 0.");
  await t.test("C live simultaneous first revocations retain exactly one suppression receipt", async () => {
    const raceEmail = `race-${runId}@example.invalid`;
    const raceToken = await issueUnsubscribeToken({ store, email: raceEmail, patientReference: `Patient/${a.id}`, publicBaseUrl: "https://practice.invalid" });
    const replies = await Promise.all(Array.from({ length: 8 }, async () => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/comms/u/${raceToken.token}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
      await response.text(); return response.status;
    }));
    assert.deepEqual(replies, Array(8).fill(200));
    const found = await seederFhir.search<import("@medplum/fhirtypes").Basic>("Basic", { identifier: `https://odos2020.com/fhir/NamingSystem/email-marketing-suppression-address|${raceEmail}` });
    for (const entry of found.entry ?? []) if (entry.resource) track(entry.resource);
    assert.equal(found.entry?.length, 1);
    const receipt = await readEmailAddressSuppression(seederFhir, raceEmail);
    const replay = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/comms/u/${raceToken.token}`, { method: "POST" });
    assert.equal(replay.status, 200); await replay.text();
    assert.deepEqual(await readEmailAddressSuppression(seederFhir, raceEmail), receipt);
    t.diagnostic("Eight concurrent live first POSTs: 200; address receipts: 1; replay timestamp unchanged.");
  });
});
