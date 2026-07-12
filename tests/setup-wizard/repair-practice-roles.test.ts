import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, ProjectMembership } from "@medplum/fhirtypes";
import {
  membershipPolicyReferences,
  repairPracticeRoles,
  type PracticeRoleRepairAdapter,
} from "../../scripts/repair-practice-roles.ts";
import {
  OSOD_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
} from "../../mcp/src/authz/roles.ts";
import type { JsonPatchOperation } from "../../mcp/src/fhir-client.ts";

class FakeRepairAdapter implements PracticeRoleRepairAdapter {
  readonly policies: AccessPolicy[];
  readonly membership: ProjectMembership;
  policyWrites = 0;
  membershipWrites = 0;

  constructor(input: { policies?: AccessPolicy[]; membership?: ProjectMembership } = {}) {
    this.policies = input.policies ?? [];
    this.membership = input.membership ?? membership();
  }

  async findPoliciesByName(name: string): Promise<AccessPolicy[]> {
    return this.policies.filter((policy) => policy.name === name);
  }

  async createPolicy(policy: AccessPolicy): Promise<AccessPolicy> {
    const created = { ...structuredClone(policy), id: `policy-${this.policies.length + 1}`, meta: { ...policy.meta, versionId: "1" } };
    this.policies.push(created);
    this.policyWrites += 1;
    return created;
  }

  async patchPolicy(id: string, operations: JsonPatchOperation[], versionId: string): Promise<AccessPolicy> {
    const policy = this.policies.find((candidate) => candidate.id === id);
    assert.ok(policy);
    assert.equal(policy.meta?.versionId, versionId);
    applyPatch(policy, operations);
    policy.meta = { ...policy.meta, versionId: String(Number(versionId) + 1) };
    this.policyWrites += 1;
    return policy;
  }

  async currentIdentity() {
    return {
      profileReference: "Practitioner/dev-admin",
      projectReference: "Project/local-practice",
      membershipReference: "ProjectMembership/dev-membership",
    };
  }

  async findMemberships(): Promise<ProjectMembership[]> {
    return [this.membership];
  }

  async readMembership(): Promise<ProjectMembership> {
    return this.membership;
  }

  async patchMembership(id: string, operations: JsonPatchOperation[], versionId: string): Promise<ProjectMembership> {
    assert.equal(id, this.membership.id);
    assert.equal(versionId, this.membership.meta?.versionId);
    applyPatch(this.membership, operations);
    this.membership.meta = { ...this.membership.meta, versionId: String(Number(versionId) + 1) };
    this.membershipWrites += 1;
    return this.membership;
  }
}

test("missing role policies are created and front-desk is appended to the dev membership", async () => {
  const adapter = new FakeRepairAdapter({
    membership: membership({ accessPolicy: { reference: "AccessPolicy/keep-legacy" } }),
  });

  const result = await repairPracticeRoles(adapter);

  assert.deepEqual(result.createdPolicies, PRACTICE_ROLE_IDS);
  assert.deepEqual(result.membershipGrants, { "front-desk": "ADDED", "practice-admin": "ADDED" });
  assert.equal(result.membershipReference, "ProjectMembership/dev-membership");
  assert.equal(adapter.policyWrites, 5);
  assert.equal(adapter.membershipWrites, 1);
  assert.equal(adapter.policies.length, 5);
  for (const roleId of PRACTICE_ROLE_IDS) {
    assert.ok(adapter.policies.some((policy) => policy.meta?.tag?.some((tag) =>
      tag.system === OSOD_PRACTICE_ROLE_SYSTEM && tag.code === roleId,
    )));
  }
  assert.deepEqual(membershipPolicyReferences(adapter.membership), [
    "AccessPolicy/keep-legacy",
    "AccessPolicy/policy-3",
    "AccessPolicy/policy-1",
  ]);
});

test("a second repair is a zero-write idempotent no-op", async () => {
  const adapter = new FakeRepairAdapter();
  await repairPracticeRoles(adapter);
  const policyWrites = adapter.policyWrites;
  const membershipWrites = adapter.membershipWrites;

  const result = await repairPracticeRoles(adapter);

  assert.deepEqual(result.createdPolicies, []);
  assert.deepEqual(result.taggedPolicies, []);
  assert.deepEqual(result.existingPolicies, PRACTICE_ROLE_IDS);
  assert.deepEqual(result.membershipGrants, { "front-desk": "EXISTING", "practice-admin": "EXISTING" });
  assert.equal(adapter.policyWrites, policyWrites);
  assert.equal(adapter.membershipWrites, membershipWrites);
});

test("one untagged canonical policy is tagged without replacing unrelated metadata", async () => {
  const adapter = new FakeRepairAdapter({
    policies: [{
      resourceType: "AccessPolicy",
      id: "admin-policy",
      name: "OSOD Practice Admin",
      meta: { versionId: "7", tag: [{ system: "https://example.test", code: "keep" }] },
    }],
  });

  const result = await repairPracticeRoles(adapter);

  assert.deepEqual(result.taggedPolicies, ["practice-admin"]);
  assert.deepEqual(adapter.policies[0]?.meta?.tag, [
    { system: "https://example.test", code: "keep" },
    { system: OSOD_PRACTICE_ROLE_SYSTEM, code: "practice-admin" },
  ]);
});

test("duplicate canonical policies stop repair before membership mutation", async () => {
  const adapter = new FakeRepairAdapter({ policies: [policy("a", "practice-admin"), policy("b", "practice-admin")] });

  await assert.rejects(() => repairPracticeRoles(adapter), /2 exact matches; repair stopped without guessing/);
  assert.equal(adapter.membershipWrites, 0);
});

test("a wrong OSOD role tag stops repair without overwriting it", async () => {
  const wrong = policy("wrong", "practice-admin");
  wrong.meta!.tag = [{ system: OSOD_PRACTICE_ROLE_SYSTEM, code: "clinician" }];
  const adapter = new FakeRepairAdapter({ policies: [wrong] });

  await assert.rejects(() => repairPracticeRoles(adapter), /conflicting practice-role code/);
  assert.deepEqual(wrong.meta.tag, [{ system: OSOD_PRACTICE_ROLE_SYSTEM, code: "clinician" }]);
  assert.equal(adapter.membershipWrites, 0);
});

function membership(overrides: Partial<ProjectMembership> = {}): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id: "dev-membership",
    meta: { versionId: "1" },
    active: true,
    project: { reference: "Project/local-practice" },
    user: { reference: "User/dev-admin" },
    profile: { reference: "Practitioner/dev-admin" },
    admin: true,
    ...overrides,
  };
}

function policy(id: string, roleId: "practice-admin" | "clinician"): AccessPolicy {
  const display = roleId === "practice-admin" ? "Practice Admin" : "Clinician";
  return {
    resourceType: "AccessPolicy",
    id,
    name: `OSOD ${display}`,
    meta: { versionId: "1", tag: [{ system: OSOD_PRACTICE_ROLE_SYSTEM, code: roleId }] },
  };
}

function applyPatch(target: AccessPolicy | ProjectMembership, operations: JsonPatchOperation[]): void {
  for (const operation of operations) {
    assert.equal(operation.op, "add");
    if (operation.path === "/meta/tag/-") {
      assert.ok(target.meta?.tag);
      target.meta.tag.push(operation.value as NonNullable<AccessPolicy["meta"]>["tag"][number]);
    } else if (operation.path === "/access") {
      (target as ProjectMembership).access = operation.value as ProjectMembership["access"];
    } else if (operation.path === "/access/-") {
      assert.ok((target as ProjectMembership).access);
      (target as ProjectMembership).access!.push(operation.value as NonNullable<ProjectMembership["access"]>[number]);
    } else if (operation.path === "/access/0") {
      assert.ok((target as ProjectMembership).access);
      (target as ProjectMembership).access!.splice(0, 0, operation.value as NonNullable<ProjectMembership["access"]>[number]);
    } else {
      assert.fail(`Unexpected patch path ${operation.path}`);
    }
  }
}
