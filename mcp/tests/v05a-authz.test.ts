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
    assert.equal(result.auditRow.outcome, "success");
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
  assert.equal(review.auditRow.eventType, "membership.role-review");
  assert.equal(review.auditRow.details?.reviewNote, "Quarterly access review complete.");
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
  assert.equal(result.auditRow.eventType, "break-glass.granted");
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
