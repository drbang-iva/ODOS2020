import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, ProjectMembership } from "@medplum/fhirtypes";
import {
  grantPracticeRoles,
  reconcileMembershipAccess,
  type PracticeRoleGrantDependencies,
} from "../src/authz/role-grants.js";
import type { PracticeRoleId } from "../src/authz/roles.js";
import type { JsonPatchOperation } from "../src/fhir-client.js";

function fixture(input: {
  email?: string;
  membership?: ProjectMembership;
  serviceIdentityEmail?: string;
} = {}) {
  const membership = input.membership ?? baseMembership();
  let auditCount = 0;
  let patchCount = 0;
  const policies = new Map<PracticeRoleId, AccessPolicy>([
    ["staff", { resourceType: "AccessPolicy", id: "desk" }],
    ["admin", { resourceType: "AccessPolicy", id: "admin" }],
    ["provider", { resourceType: "AccessPolicy", id: "clinical" }],
  ]);
  const deps: PracticeRoleGrantDependencies = {
    serviceIdentityEmail: input.serviceIdentityEmail,
    resolveTarget: async () => ({ email: input.email ?? "human@example.test", membership }),
    resolvePolicy: async (role) => policies.get(role)!,
    patchMembership: async (_id, operations) => {
      patchCount += 1;
      applyPatch(membership, operations);
      return membership;
    },
    recordMembershipChange: async (_target, operation) => {
      auditCount += 1;
      return operation();
    },
  };
  return { deps, membership, counts: () => ({ auditCount, patchCount }) };
}

test("grantPracticeRoles orders bare roles, preserves unique access, and clears legacy accessPolicy", async () => {
  const { deps, membership, counts } = fixture({
    membership: baseMembership({
      accessPolicy: { reference: "AccessPolicy/clinical" },
      access: [
        { policy: { reference: "AccessPolicy/desk" } },
        { policy: { reference: "AccessPolicy/clinical" }, parameter: [{ name: "provider_profile", valueReference: { reference: "Practitioner/p1" } }] },
        { policy: { reference: "AccessPolicy/desk" } },
        { policy: { reference: "AccessPolicy/unrelated" } },
      ],
    }),
  });

  const result = await grantPracticeRoles(
    { target: "human@example.test", roles: ["staff", "provider", "staff"], primaryRole: "provider" },
    deps,
  );

  assert.deepEqual(result.roles, ["provider", "staff"]);
  assert.deepEqual(membership.access?.map((access) => access.policy.reference), [
    "AccessPolicy/clinical",
    "AccessPolicy/desk",
    "AccessPolicy/clinical",
    "AccessPolicy/unrelated",
  ]);
  assert.equal(membership.access?.[0]?.parameter, undefined);
  assert.deepEqual(membership.access?.[2]?.parameter, [
    { name: "provider_profile", valueReference: { reference: "Practitioner/p1" } },
  ]);
  assert.equal(membership.accessPolicy, undefined);
  assert.deepEqual(counts(), { auditCount: 1, patchCount: 1 });
});

test("reconcileMembershipAccess preserves distinct parameterized patient grants after ordered bare roles", () => {
  const membership = baseMembership({
    access: [
      { policy: { reference: "AccessPolicy/desk" } },
      { policy: { reference: "AccessPolicy/admin" } },
      { policy: { reference: "AccessPolicy/clinical" } },
      {
        policy: { reference: "AccessPolicy/clinical" },
        parameter: [
          { name: "provider_profile", valueReference: { reference: "Practitioner/p1" } },
          { name: "patient_compartment", valueString: "Patient/patient-1" },
        ],
      },
      {
        policy: { reference: "AccessPolicy/clinical" },
        parameter: [
          { name: "provider_profile", valueReference: { reference: "Practitioner/p1" } },
          { name: "patient_compartment", valueString: "Patient/patient-2" },
        ],
      },
    ],
  });

  applyPatch(membership, reconcileMembershipAccess(membership, [
    "AccessPolicy/admin",
    "AccessPolicy/clinical",
    "AccessPolicy/desk",
  ]));

  assert.deepEqual(membership.access, [
    { policy: { reference: "AccessPolicy/admin" } },
    { policy: { reference: "AccessPolicy/clinical" } },
    { policy: { reference: "AccessPolicy/desk" } },
    {
      policy: { reference: "AccessPolicy/clinical" },
      parameter: [
        { name: "provider_profile", valueReference: { reference: "Practitioner/p1" } },
        { name: "patient_compartment", valueString: "Patient/patient-1" },
      ],
    },
    {
      policy: { reference: "AccessPolicy/clinical" },
      parameter: [
        { name: "provider_profile", valueReference: { reference: "Practitioner/p1" } },
        { name: "patient_compartment", valueString: "Patient/patient-2" },
      ],
    },
  ]);
});

test("grantPracticeRoles is a zero-write no-op when membership access is already exact", async () => {
  const { deps, counts } = fixture({
    membership: baseMembership({ access: [{ policy: { reference: "AccessPolicy/clinical" } }] }),
  });
  const result = await grantPracticeRoles(
    { target: "Practitioner/p1", roles: ["provider"], primaryRole: "provider" },
    deps,
  );
  assert.equal(result.changed, false);
  assert.deepEqual(counts(), { auditCount: 0, patchCount: 0 });
});

test("grantPracticeRoles rejects a policy owned by a different project", async () => {
  const { deps, counts } = fixture();
  deps.resolvePolicy = async () => ({
    resourceType: "AccessPolicy",
    id: "other-project-policy",
    meta: { project: "other-project" },
  });
  await assert.rejects(
    grantPracticeRoles(
      { target: "human@example.test", roles: ["provider"], primaryRole: "provider" },
      deps,
    ),
    /belongs to Project\/other-project, not Project\/p1/,
  );
  assert.deepEqual(counts(), { auditCount: 0, patchCount: 0 });
});

test("grantPracticeRoles refuses the configured service identity unless explicitly overridden", async () => {
  const denied = fixture({ email: "service@example.test", serviceIdentityEmail: "SERVICE@example.test" });
  await assert.rejects(
    grantPracticeRoles(
      { target: "service@example.test", roles: ["provider"], primaryRole: "provider" },
      denied.deps,
    ),
    /Refusing practice-role grants to configured service identity/,
  );
  assert.deepEqual(denied.counts(), { auditCount: 0, patchCount: 0 });

  const allowed = fixture({ email: "service@example.test", serviceIdentityEmail: "service@example.test" });
  const result = await grantPracticeRoles(
    {
      target: "service@example.test",
      roles: ["provider"],
      primaryRole: "provider",
      allowServiceIdentity: true,
    },
    allowed.deps,
  );
  assert.equal(result.changed, true);
});

function baseMembership(overrides: Partial<ProjectMembership> = {}): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id: "membership-1",
    meta: { versionId: "1" },
    active: true,
    project: { reference: "Project/p1" },
    user: { reference: "User/u1" },
    profile: { reference: "Practitioner/p1" },
    ...overrides,
  };
}

function applyPatch(membership: ProjectMembership, operations: JsonPatchOperation[]): void {
  for (const operation of operations) {
    if (operation.path === "/access") {
      membership.access = operation.value as ProjectMembership["access"];
    } else if (operation.path === "/accessPolicy") {
      delete membership.accessPolicy;
    } else {
      assert.fail(`Unexpected patch path ${operation.path}`);
    }
  }
}
