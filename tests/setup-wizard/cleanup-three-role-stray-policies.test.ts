import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, ProjectMembership } from "@medplum/fhirtypes";
import {
  executeThreeRoleStrayPolicyCleanup,
  type ThreeRoleStrayPolicyCleanupAdapter,
} from "../../scripts/cleanup-three-role-stray-policies.ts";

const PROJECT = "super-admin";

test("stray-policy cleanup dry-run selects exact canonical names and performs zero deletes", async () => {
  const fixture = cleanupFixture({
    policies: [
      policy("provider", "ODOS Provider"),
      policy("staff", "ODOS Staff"),
      policy("admin", "ODOS Admin / Manager"),
      policy("unrelated", "Keep Me"),
    ],
  });

  const result = await executeThreeRoleStrayPolicyCleanup(fixture.adapter, { projectId: PROJECT });

  assert.equal(result.mode, "dry-run");
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["provider", "staff", "admin"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.name), [
    "ODOS Provider",
    "ODOS Staff",
    "ODOS Admin / Manager",
  ]);
  assert.deepEqual(fixture.deletes, []);
});

test("stray-policy cleanup exact ids remain bounded to the project-scoped policy set", async () => {
  const fixture = cleanupFixture({
    policies: [policy("provider", "Renamed Provider"), policy("staff", "ODOS Staff")],
  });

  const result = await executeThreeRoleStrayPolicyCleanup(fixture.adapter, {
    projectId: PROJECT,
    policyIds: ["provider"],
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["provider"]);
  await assert.rejects(
    () => executeThreeRoleStrayPolicyCleanup(fixture.adapter, {
      projectId: PROJECT,
      policyIds: ["outside-project"],
    }),
    /AccessPolicy\/outside-project was not found in project super-admin/,
  );
});

test("stray-policy cleanup refuses every delete when any membership references a candidate", async () => {
  const fixture = cleanupFixture({
    policies: [policy("provider", "ODOS Provider"), policy("staff", "ODOS Staff")],
    memberships: [
      membership("modern", { access: [{ policy: { reference: "AccessPolicy/provider" } }] }),
      membership("legacy", { accessPolicy: { reference: "AccessPolicy/staff" } }),
    ],
  });

  const dryRun = await executeThreeRoleStrayPolicyCleanup(fixture.adapter, { projectId: PROJECT });
  assert.deepEqual(dryRun.candidates.map((candidate) => ({
    id: candidate.id,
    references: candidate.membershipReferences,
  })), [
    { id: "provider", references: ["ProjectMembership/modern"] },
    { id: "staff", references: ["ProjectMembership/legacy"] },
  ]);

  await assert.rejects(
    () => executeThreeRoleStrayPolicyCleanup(fixture.adapter, { projectId: PROJECT, apply: true }),
    /refused.*AccessPolicy\/provider.*ProjectMembership\/modern.*AccessPolicy\/staff.*ProjectMembership\/legacy/i,
  );
  assert.deepEqual(fixture.deletes, []);
});

test("stray-policy cleanup apply deletes only the reviewed unreferenced candidates", async () => {
  const fixture = cleanupFixture({
    policies: [policy("provider", "ODOS Provider"), policy("staff", "ODOS Staff")],
  });

  const result = await executeThreeRoleStrayPolicyCleanup(fixture.adapter, {
    projectId: PROJECT,
    policyIds: ["staff"],
    apply: true,
  });

  assert.equal(result.mode, "apply");
  assert.equal(result.policiesDeleted, 1);
  assert.deepEqual(fixture.deletes, [{ id: "staff", versionId: "1" }]);
});

function cleanupFixture(input: {
  policies: AccessPolicy[];
  memberships?: ProjectMembership[];
}) {
  const deletes: Array<{ id: string; versionId: string }> = [];
  const adapter: ThreeRoleStrayPolicyCleanupAdapter = {
    readProjectPolicies: async (projectId) => {
      assert.equal(projectId, PROJECT);
      return structuredClone(input.policies);
    },
    readAllMemberships: async () => structuredClone(input.memberships ?? []),
    deletePolicy: async (id, versionId) => {
      deletes.push({ id, versionId });
    },
  };
  return { adapter, deletes };
}

function policy(id: string, name: string): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    id,
    name,
    meta: { versionId: "1" },
  };
}

function membership(id: string, overrides: Partial<ProjectMembership>): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id,
    project: { reference: "Project/any-project" },
    profile: { reference: "Practitioner/synthetic" },
    ...overrides,
  };
}
