import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy } from "@medplum/fhirtypes";
import {
  assertLocalMedplumBaseUrl,
  decidePracticeRoleTag,
  reseedPracticeRoleTags,
  type PracticeRoleReseedAdapter,
} from "../../scripts/reseed-practice-role-tags.ts";
import { OSOD_PRACTICE_ROLE_SYSTEM } from "../../mcp/src/authz/roles.ts";
import type { JsonPatchOperation } from "../../mcp/src/fhir-client.ts";

type AccessPolicyTag = NonNullable<NonNullable<AccessPolicy["meta"]>["tag"]>[number];

class FakePracticeRoleReseedAdapter implements PracticeRoleReseedAdapter {
  readonly writes: { id: string; operations: JsonPatchOperation[]; versionId: string }[] = [];
  stalePolicyId?: string;

  constructor(readonly policies: AccessPolicy[]) {}

  async findPoliciesByName(name: string): Promise<AccessPolicy[]> {
    return this.policies.filter((policy) => policy.name === name);
  }

  async patchPolicy(id: string, operations: JsonPatchOperation[], versionId: string): Promise<AccessPolicy> {
    this.writes.push({ id, operations, versionId });
    if (id === this.stalePolicyId) {
      throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
    }
    const policy = this.policies.find((candidate) => candidate.id === id);
    assert.ok(policy);
    assert.equal(policy.meta?.versionId, versionId);
    applyPatch(policy, operations);
    return policy;
  }
}

test("untagged policy is tagged without replacing other meta fields and is idempotent", async () => {
  const policy: AccessPolicy = {
    resourceType: "AccessPolicy",
    id: "clinician-policy",
    name: "OSOD Clinician",
    meta: { versionId: "legacy-version" },
  };
  const adapter = new FakePracticeRoleReseedAdapter([policy]);

  const first = await reseedPracticeRoleTags(adapter);

  assert.equal(first.exitCode, 0);
  assert.equal(adapter.writes.length, 1);
  assert.deepEqual(policy.meta, {
    versionId: "legacy-version",
    tag: [{ system: OSOD_PRACTICE_ROLE_SYSTEM, code: "clinician" }],
  });
  assert.equal(decidePracticeRoleTag(policy.meta?.tag, "clinician").kind, "SKIP");

  const second = await reseedPracticeRoleTags(adapter);
  assert.equal(second.exitCode, 0);
  assert.equal(adapter.writes.length, 1);
  assert.deepEqual(roleCount(second, "clinician"), {
    roleId: "clinician",
    matched: 1,
    tagged: 0,
    alreadyCorrect: 1,
    conflicted: 0,
  });
});

test("already-correct policy is skipped with zero writes", async () => {
  const adapter = new FakePracticeRoleReseedAdapter([
    policyWithTags("front-desk-policy", "OSOD Front Desk", [
      { system: OSOD_PRACTICE_ROLE_SYSTEM, code: "front-desk" },
    ]),
  ]);

  const result = await reseedPracticeRoleTags(adapter);

  assert.equal(result.exitCode, 0);
  assert.equal(adapter.writes.length, 0);
  assert.equal(roleCount(result, "front-desk").alreadyCorrect, 1);
});

test("wrong OSOD role tag is a conflict with no write and a non-zero exit path", async () => {
  const adapter = new FakePracticeRoleReseedAdapter([
    policyWithTags("auditor-policy", "OSOD Auditor", [
      { system: OSOD_PRACTICE_ROLE_SYSTEM, code: "clinician" },
    ]),
  ]);

  const result = await reseedPracticeRoleTags(adapter);

  assert.equal(result.exitCode, 1);
  assert.equal(adapter.writes.length, 0);
  assert.equal(roleCount(result, "auditor").conflicted, 1);
  assert.deepEqual(result.conflicts, [
    {
      roleId: "auditor",
      policyId: "auditor-policy",
      reason: "role-tag",
      conflictingCodes: ["clinician"],
    },
  ]);
  assert.deepEqual(decidePracticeRoleTag(adapter.policies[0]?.meta?.tag, "auditor"), {
    kind: "CONFLICT",
    conflictingCodes: ["clinician"],
  });
});

test("unrelated tag is preserved and the practice-role tag is appended", async () => {
  const unrelatedTag = { system: "https://example.test/tags", code: "preserve-me" };
  const policy = policyWithTags("admin-policy", "OSOD Practice Admin", [unrelatedTag]);
  const adapter = new FakePracticeRoleReseedAdapter([policy]);

  const result = await reseedPracticeRoleTags(adapter);

  assert.equal(result.exitCode, 0);
  assert.equal(adapter.writes.length, 1);
  assert.deepEqual(policy.meta?.tag, [
    unrelatedTag,
    { system: OSOD_PRACTICE_ROLE_SYSTEM, code: "practice-admin" },
  ]);
  assert.deepEqual(adapter.writes[0]?.operations, [
    {
      op: "add",
      path: "/meta/tag/-",
      value: { system: OSOD_PRACTICE_ROLE_SYSTEM, code: "practice-admin" },
    },
  ]);
  assert.equal(adapter.writes[0]?.versionId, "1");
});

test("a stale version is reported as a conflict without applying the patch", async () => {
  const policy: AccessPolicy = {
    resourceType: "AccessPolicy",
    id: "stale-clinician-policy",
    name: "OSOD Clinician",
    meta: { versionId: "7" },
  };
  const adapter = new FakePracticeRoleReseedAdapter([policy]);
  adapter.stalePolicyId = policy.id;

  const result = await reseedPracticeRoleTags(adapter);

  assert.equal(result.exitCode, 1);
  assert.equal(roleCount(result, "clinician").conflicted, 1);
  assert.deepEqual(result.conflicts, [
    { roleId: "clinician", policyId: "stale-clinician-policy", reason: "stale-version" },
  ]);
  assert.equal(policy.meta?.tag, undefined);
});

test("the live migration target must be local or private", () => {
  assert.doesNotThrow(() => assertLocalMedplumBaseUrl("http://localhost:8103"));
  assert.doesNotThrow(() => assertLocalMedplumBaseUrl("https://osod.local"));
  assert.doesNotThrow(() => assertLocalMedplumBaseUrl("http://192.168.1.20:8103"));
  assert.throws(
    () => assertLocalMedplumBaseUrl("https://medplum.example.com"),
    /must target a local or private/,
  );
});

function roleCount(
  result: Awaited<ReturnType<typeof reseedPracticeRoleTags>>,
  roleId: string,
) {
  const count = result.roles.find((role) => role.roleId === roleId);
  assert.ok(count);
  return count;
}

function policyWithTags(id: string, name: string, tag: NonNullable<AccessPolicy["meta"]>["tag"]): AccessPolicy {
  return { resourceType: "AccessPolicy", id, name, meta: { versionId: "1", tag } };
}

function applyPatch(policy: AccessPolicy, operations: JsonPatchOperation[]): void {
  for (const operation of operations) {
    assert.equal(operation.op, "add");
    if (operation.path === "/meta") {
      policy.meta = operation.value as AccessPolicy["meta"];
    } else if (operation.path === "/meta/tag") {
      assert.ok(policy.meta);
      policy.meta.tag = operation.value as NonNullable<AccessPolicy["meta"]>["tag"];
    } else if (operation.path === "/meta/tag/-") {
      assert.ok(policy.meta?.tag);
      policy.meta.tag.push(operation.value as AccessPolicyTag);
    } else {
      assert.fail(`Unexpected patch path ${operation.path}`);
    }
  }
}
