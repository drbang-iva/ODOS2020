import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, Binary, ProjectMembership } from "@medplum/fhirtypes";
import {
  BREAK_GLASS_POLICY_URL,
  DEFAULT_BREAK_GLASS_DURATION_MINUTES,
  assertBreakGlassGrantActive,
  invokeBreakGlass,
} from "../src/authz/breakGlass.js";
import {
  PROJECT_MEMBERSHIP_LIFECYCLE_STATES,
  getProjectMembershipLifecycleState,
  transitionProjectMembershipLifecycle,
} from "../src/authz/membershipLifecycle.js";
import {
  PRACTICE_ROLE_IDS,
  accessPolicyHasNoBusinessActionVocabulary,
  assertAestheticsProviderScope,
  buildMedplumAccessPolicy,
  buildProjectMembershipAccess,
  getRoleDeclaration,
} from "../src/authz/roles.js";
import {
  assertBinaryPatchAllowed,
  parserBinaryHeaders,
  prepareBinaryForParserCreate,
} from "../src/parsers/binarySecurityContext.js";
import {
  createAuthenticatedFhirClient,
  loadRepoEnv,
} from "./integration-helpers.js";
import { createMedplumClient } from "../src/fhir-client.js";

test("v0.5a role registry defines the five practice-scoped roles", () => {
  assert.deepEqual(PRACTICE_ROLE_IDS, [
    "practice-admin",
    "clinician",
    "front-desk",
    "auditor",
    "aesthetics-provider",
  ]);
  for (const roleId of PRACTICE_ROLE_IDS) {
    assert.equal(getRoleDeclaration(roleId).id, roleId);
  }
});

test("AccessPolicy generator emits Medplum interactions, criteria, and writeConstraint without business-action leakage", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("clinician"));

  assert.equal(policy.resourceType, "AccessPolicy");
  assert.ok(accessPolicyHasNoBusinessActionVocabulary(policy));
  assert.equal(JSON.stringify(policy).includes("readonly"), false);

  const patientRule = policy.resource?.find((rule) => rule.resourceType === "Patient");
  assert.deepEqual(patientRule?.interaction, ["read", "search", "history", "vread"]);
  assert.equal(patientRule?.criteria, "Patient?general-practitioner=%provider_profile");

  const observationRule = policy.resource?.find((rule) => rule.resourceType === "Observation");
  assert.ok(observationRule?.interaction?.includes("create"));
  assert.equal(observationRule?.criteria, "Observation?_compartment=%patient_compartment");
  assert.equal(observationRule?.writeConstraint?.[0]?.language, "text/fhirpath");
  assert.match(observationRule?.writeConstraint?.[0]?.expression ?? "", /%before\.status != 'final'/);
});

test("ProjectMembership access builder emits parameterized provider, patient, and state-license values", () => {
  const access = buildProjectMembershipAccess({
    policyReference: "AccessPolicy/osod-aesthetics-provider",
    parameters: {
      providerProfileReference: "Practitioner/provider-1",
      patientCompartmentReference: "Patient/patient-1",
      licenseState: "tx",
      procedureScope: "injectables",
    },
  });

  assert.equal(access[0].policy.reference, "AccessPolicy/osod-aesthetics-provider");
  assert.deepEqual(access[0].parameter, [
    { name: "provider_profile", valueReference: { reference: "Practitioner/provider-1" } },
    { name: "patient_compartment", valueString: "Patient/patient-1" },
    { name: "license_state", valueString: "TX" },
    { name: "procedure_scope", valueString: "injectables" },
  ]);
});

test("aesthetics-provider state scoping rejects out-of-state or out-of-scope procedures", () => {
  assert.doesNotThrow(() =>
    assertAestheticsProviderScope({
      roleId: "aesthetics-provider",
      licensedStates: ["TX", "OK"],
      requestedState: "tx",
      procedureType: "injectables",
      allowedProcedureTypesByState: { TX: ["injectables"] },
    }),
  );

  assert.throws(
    () =>
      assertAestheticsProviderScope({
        roleId: "aesthetics-provider",
        licensedStates: ["TX"],
        requestedState: "CA",
      }),
    /not credentialed for CA/,
  );

  assert.throws(
    () =>
      assertAestheticsProviderScope({
        roleId: "aesthetics-provider",
        licensedStates: ["TX"],
        requestedState: "TX",
        procedureType: "laser",
        allowedProcedureTypesByState: { TX: ["injectables"] },
      }),
    /does not include laser/,
  );
});

test("Binary parser plugin requires securityContext and rejects outside patient compartment", () => {
  const binary: Binary = { resourceType: "Binary", contentType: "image/jpeg", data: "AA==" };

  assert.throws(
    () => prepareBinaryForParserCreate(binary, { source: "parser-plugin" }),
    /Binary\.securityContext is required/,
  );

  assert.throws(
    () =>
      prepareBinaryForParserCreate(binary, {
        source: "raw-upload-header",
        headers: parserBinaryHeaders("Patient/outside"),
        allowedPatientCompartments: ["Patient/inside"],
      }),
    /outside the caller's patient compartment/,
  );
});

test("Binary parser plugin accepts valid raw upload header and blocks securityContext rewrite", () => {
  const prepared = prepareBinaryForParserCreate(
    { resourceType: "Binary", contentType: "image/jpeg", data: "AA==" },
    {
      source: "raw-upload-header",
      headers: parserBinaryHeaders("Patient/patient-1"),
      allowedPatientCompartments: ["Patient/patient-1"],
    },
  );

  assert.equal(prepared.securityContext?.reference, "Patient/patient-1");
  assert.throws(
    () =>
      assertBinaryPatchAllowed({
        operations: [{ op: "remove", path: "/securityContext" }],
      }),
    /securityContext is immutable/,
  );
  assert.throws(
    () =>
      prepareBinaryForParserCreate(
        { resourceType: "Binary", contentType: "image/jpeg", data: "AA==" },
        { source: "agent-direct-fhir", anchorReference: "Patient/patient-1" },
      ),
    /Mandate 8 boundary/,
  );
});

test("MCP FHIR client refuses direct Binary create without parser guard header", async () => {
  const fhir = createMedplumClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    () =>
      fhir.create<Binary>({
        resourceType: "Binary",
        contentType: "image/jpeg",
        data: "AA==",
        securityContext: { reference: "Patient/patient-1" },
      }),
    /Mandate 8 boundary/,
  );
});

test("ProjectMembership lifecycle transitions emit audit rows and placeholder AuditEvent", () => {
  let membership = membershipFixture();
  for (const action of ["invite", "activate", "deactivate", "terminate"] as const) {
    const result = transitionProjectMembershipLifecycle({
      membership,
      action,
      actorReference: "Practitioner/admin",
      actorRole: "practice-admin",
      occurredAt: `2026-04-29T12:0${PROJECT_MEMBERSHIP_LIFECYCLE_STATES.indexOf(resultState(action))}:00.000Z`,
    });
    membership = result.membership;
    assert.equal(getProjectMembershipLifecycleState(membership), resultState(action));
    assert.equal(result.auditRow.actionOutcome, "granted");
    assert.equal(result.auditEvent.resourceType, "AuditEvent");
    assert.equal(result.auditEvent.agent[0].role?.[0]?.coding?.[0]?.code, "practice-admin");
  }
});

test("ProjectMembership role review preserves state and emits a review audit row", () => {
  const active = transitionProjectMembershipLifecycle({
    membership: membershipFixture(),
    action: "activate",
    actorRole: "practice-admin",
  }).membership;
  const review = transitionProjectMembershipLifecycle({
    membership: active,
    action: "role-review",
    actorRole: "practice-admin",
    reviewNote: "Quarterly access review complete.",
  });

  assert.equal(getProjectMembershipLifecycleState(review.membership), "active");
  assert.equal(review.auditRow.eventType, "projectmembership-lifecycle");
  assert.match(review.auditRow.actionReason ?? "", /role-review/);
});

test("break-glass requires human reason, creates time-limited access, and flags admin review", () => {
  const result = invokeBreakGlass({
    actorReference: "Practitioner/doctor-1",
    actorDisplay: "Dr. Example",
    actorRole: "clinician",
    patientReference: "Patient/emergency-1",
    reason: "Emergency on-call care.",
    requestedAt: "2026-04-29T12:00:00.000Z",
    source: "human-ui",
  });

  assert.equal(result.grant.policyUrl, BREAK_GLASS_POLICY_URL);
  assert.equal(result.grant.adminReviewRequired, true);
  assert.equal(result.grant.expiresAt, "2026-04-29T13:00:00.000Z");
  assert.equal(result.auditRow.eventType, "break-glass-invoked");
  assert.equal(result.auditEvent.agent[0].policy?.[0], BREAK_GLASS_POLICY_URL);
  assert.doesNotThrow(() =>
    assertBreakGlassGrantActive(result.grant, "2026-04-29T12:59:00.000Z"),
  );
  assert.throws(
    () => assertBreakGlassGrantActive(result.grant, "2026-04-29T13:00:01.000Z"),
    /expired/,
  );
  assert.equal(DEFAULT_BREAK_GLASS_DURATION_MINUTES, 60);
});

test("break-glass rejects agent self-attestation and blank reason", () => {
  assert.throws(
    () =>
      invokeBreakGlass({
        actorRole: "clinician",
        patientReference: "Patient/emergency-1",
        reason: "Agent-generated reason",
        source: "agent",
      }),
    /Mandate 8 boundary/,
  );

  assert.throws(
    () =>
      invokeBreakGlass({
        actorRole: "clinician",
        patientReference: "Patient/emergency-1",
        reason: " ",
        source: "human-ui",
      }),
    /reason is mandatory/,
  );
});

test("AccessPolicy generator POST round-trip is accepted by Medplum when integration env is available", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum AccessPolicy round-trip.");
    return;
  }

  const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("auditor"));
  policy.name = `OSOD v0.5a Auditor Roundtrip ${Date.now()}`;
  const created = await fhir.create<AccessPolicy>(policy);

  assert.equal(created.resourceType, "AccessPolicy");
  assert.ok(created.id);
  assert.equal(created.resource?.[0]?.interaction?.includes("search"), true);
});

test(
  "v0.5a auditor AccessPolicy enforces compartment isolation when bound via ProjectMembership (closes Mandate 8 fixture caveat)",
  { timeout: 90_000 },
  async (t) => {
    loadRepoEnv();
    const baseUrl = (process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103").replace(/\/$/, "");
    const email = process.env.MEDPLUM_ADMIN_EMAIL;
    const password = process.env.MEDPLUM_ADMIN_PASSWORD;
    if (!email || !password) {
      t.skip(
        "MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for the v0.5a enforcement fixture. " +
          "This is the human-provisioned step per Mandate 8 — the agent does not create credentials, only uses what the human dropped into env vars.",
      );
      return;
    }

    const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });

    // 1. Resolve the admin's project ID from /auth/me — avoids hardcoding any installation-specific IDs.
    const meRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.ok(meRes.ok, `GET /auth/me failed: ${meRes.status}`);
    const me = (await meRes.json()) as { project?: { id?: string } };
    const projectId = me.project?.id;
    assert.ok(projectId, "Could not resolve project id from /auth/me — admin user has no project membership.");

    // 2. Generate a fresh auditor AccessPolicy from the v0.5a generator and POST it as the admin.
    const policy = buildMedplumAccessPolicy(getRoleDeclaration("auditor"));
    policy.name = `OSOD v0.5a Auditor Enforcement ${Date.now()}`;
    const createdPolicy = await fhir.create<AccessPolicy>(policy);
    assert.ok(createdPolicy.id, "AccessPolicy create did not return an id.");

    // 3. Atomically create a ClientApplication + ProjectMembership bound to the AccessPolicy via the
    //    super-admin endpoint. This is the canonical Medplum path that creates the membership for us;
    //    direct FHIR ProjectMembership creation is restricted to specific service paths.
    const adminClientRes = await fetch(`${baseUrl}/admin/projects/${projectId}/client`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `v0.5a-auditor-enforcement-${Date.now()}`,
        description: "v0.5a Mandate 8 enforcement fixture (auto-provisioned by integration test)",
        accessPolicy: { reference: `AccessPolicy/${createdPolicy.id}` },
      }),
    });
    const adminClientBody = await adminClientRes.text();
    assert.ok(
      adminClientRes.ok,
      `POST /admin/projects/${projectId}/client failed: ${adminClientRes.status} ${adminClientBody}`,
    );
    const clientApp = JSON.parse(adminClientBody) as { id: string; secret: string };
    assert.ok(clientApp.id, "Admin client create did not return an id.");
    assert.ok(clientApp.secret, "Admin client create did not return a secret.");

    // 4. OAuth client_credentials grant — acts as the new bound client.
    const tokenRes = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientApp.id,
        client_secret: clientApp.secret,
      }),
    });
    assert.ok(tokenRes.ok, `client_credentials grant failed: ${tokenRes.status}`);
    const { access_token: clientToken } = (await tokenRes.json()) as { access_token: string };
    assert.ok(clientToken, "client_credentials response missing access_token.");

    const auth = { Authorization: `Bearer ${clientToken}` };

    // 5a. POSITIVE: GET AuditEvent — auditor role grants AuditEvent read.
    const auditRes = await fetch(`${baseUrl}/fhir/R4/AuditEvent?_count=1`, { headers: auth });
    assert.equal(auditRes.status, 200, "auditor should be allowed to read AuditEvent.");

    // 5b. POSITIVE: GET Provenance — auditor role grants Provenance read.
    const provRes = await fetch(`${baseUrl}/fhir/R4/Provenance?_count=1`, { headers: auth });
    assert.equal(provRes.status, 200, "auditor should be allowed to read Provenance.");

    // 5c. NEGATIVE: POST Observation — auditor role grants no clinical write capability.
    const obsRes = await fetch(`${baseUrl}/fhir/R4/Observation`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/fhir+json" },
      body: JSON.stringify({
        resourceType: "Observation",
        status: "final",
        code: { text: "v0.5a fixture - should be rejected" },
      }),
    });
    assert.ok(
      obsRes.status >= 400 && obsRes.status < 500,
      `auditor must NOT be allowed to write Observation; got ${obsRes.status}.`,
    );

    // 5d. NEGATIVE: GET Patient — auditor role does not include Patient in its resourceRules.
    const patRes = await fetch(`${baseUrl}/fhir/R4/Patient?_count=1`, { headers: auth });
    assert.ok(
      patRes.status >= 400 && patRes.status < 500,
      `auditor must NOT be allowed to read Patient; got ${patRes.status}.`,
    );
  },
);

function membershipFixture(): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id: "membership-1",
    project: { reference: "Project/project-1" },
    user: { reference: "User/user-1" },
    profile: { reference: "Practitioner/practitioner-1" },
  };
}

function resultState(
  action: "invite" | "activate" | "deactivate" | "terminate",
) {
  switch (action) {
    case "invite":
      return "invited";
    case "activate":
      return "active";
    case "deactivate":
      return "deactivated";
    case "terminate":
      return "terminated";
  }
}
