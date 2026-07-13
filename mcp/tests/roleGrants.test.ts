import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, ProjectMembership } from "@medplum/fhirtypes";
import {
  grantPracticeRoles,
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
    ["front-desk", { resourceType: "AccessPolicy", id: "desk" }],
    ["practice-admin", { resourceType: "AccessPolicy", id: "admin" }],
    ["clinician", { resourceType: "AccessPolicy", id: "clinical" }],
    ["auditor", { resourceType: "AccessPolicy", id: "audit" }],
    ["aesthetics-provider", { resourceType: "AccessPolicy", id: "aesthetics" }],
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

test("grantPracticeRoles reconciles exact deduped access with the primary role first and clears legacy accessPolicy", async () => {
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
    { target: "human@example.test", roles: ["front-desk", "clinician", "front-desk"], primaryRole: "clinician" },
    deps,
  );

  assert.deepEqual(result.roles, ["clinician", "front-desk"]);
  assert.deepEqual(membership.access?.map((access) => access.policy.reference), [
    "AccessPolicy/clinical",
    "AccessPolicy/desk",
  ]);
  assert.equal(membership.access?.[0]?.parameter?.[0]?.name, "provider_profile");
  assert.equal(membership.accessPolicy, undefined);
  assert.deepEqual(counts(), { auditCount: 1, patchCount: 1 });
});

test("grantPracticeRoles is a zero-write no-op when membership access is already exact", async () => {
  const { deps, counts } = fixture({
    membership: baseMembership({ access: [{ policy: { reference: "AccessPolicy/clinical" } }] }),
  });
  const result = await grantPracticeRoles(
    { target: "Practitioner/p1", roles: ["clinician"], primaryRole: "clinician" },
    deps,
  );
  assert.equal(result.changed, false);
  assert.deepEqual(counts(), { auditCount: 0, patchCount: 0 });
});

test("grantPracticeRoles refuses the configured service identity unless explicitly overridden", async () => {
  const denied = fixture({ email: "service@example.test", serviceIdentityEmail: "SERVICE@example.test" });
  await assert.rejects(
    grantPracticeRoles(
      { target: "service@example.test", roles: ["clinician"], primaryRole: "clinician" },
      denied.deps,
    ),
    /Refusing practice-role grants to configured service identity/,
  );
  assert.deepEqual(denied.counts(), { auditCount: 0, patchCount: 0 });

  const allowed = fixture({ email: "service@example.test", serviceIdentityEmail: "service@example.test" });
  const result = await grantPracticeRoles(
    {
      target: "service@example.test",
      roles: ["clinician"],
      primaryRole: "clinician",
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
