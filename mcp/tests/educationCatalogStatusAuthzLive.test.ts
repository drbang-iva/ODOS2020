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
