import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy } from "@medplum/fhirtypes";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../../mcp/src/authz/roles.js";
import type { JsonPatchOperation, MedplumClient } from "../../mcp/src/fhir-client.js";
import {
  LivePracticeRolePolicyRuleSyncAdapter,
  formatPracticeRolePolicyRuleSync,
  requiredPracticeRolePolicyRuleSyncProjectId,
  syncPracticeRolePolicyRules,
  type PracticeRolePolicyRuleSyncAdapter,
} from "../../scripts/sync-practice-role-policy-rules.js";

const PROJECT_ID = "practice-1";

class FakePolicyRuleSyncAdapter implements PracticeRolePolicyRuleSyncAdapter {
  readonly policies: AccessPolicy[];
  readonly events: string[];
  readonly patchRequests: {
    id: string;
    operations: JsonPatchOperation[];
    versionId: string;
  }[] = [];
  stalePolicyId?: string;

  constructor(policies = canonicalPolicies(), events: string[] = []) {
    this.policies = structuredClone(policies);
    this.events = events;
  }

  async readPolicies(projectId: string): Promise<AccessPolicy[]> {
    assert.equal(projectId, PROJECT_ID);
    this.events.push("read");
    return structuredClone(this.policies);
  }

  async patchPolicy(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<AccessPolicy> {
    this.events.push(`patch:${id}`);
    this.patchRequests.push({ id, operations: structuredClone(operations), versionId });
    const policy = this.policies.find((candidate) => candidate.id === id);
    assert.ok(policy);
    if (id === this.stalePolicyId || policy.meta?.versionId !== versionId) {
      throw new Error(`AccessPolicy/${id} update failed: 412 Precondition Failed`);
    }
    applyPatch(policy, operations);
    policy.meta = { ...policy.meta, versionId: String(Number(versionId) + 1) };
    return structuredClone(policy);
  }
}

test("dry-run reports literal missing and unexpected canonicalized rules without writing", async () => {
  const policies = canonicalPolicies();
  const admin = policies.find((policy) => hasRole(policy, "admin"));
  assert.ok(admin);
  const healthcareWrite = admin.resource?.find((rule) =>
    rule.resourceType === "HealthcareService" && rule.interaction?.includes("create")
  );
  assert.ok(healthcareWrite);
  healthcareWrite.interaction = ["update"];
  const events: string[] = [];
  const adapter = new FakePolicyRuleSyncAdapter(policies, events);

  const result = await syncPracticeRolePolicyRules(adapter, {
    projectId: PROJECT_ID,
    assertProjectScope: async () => { events.push("guard"); },
  });

  assert.deepEqual(events, ["guard", "read"]);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.policiesUpdated, 0);
  assert.deepEqual(result.policies.map(({ role, status }) => ({ role, status })), [
    { role: "provider", status: "match" },
    { role: "staff", status: "match" },
    { role: "admin", status: "drift" },
  ]);
  assert.deepEqual(result.policies[2]?.missingRules, [{
    interaction: ["create", "update"],
    resourceType: "HealthcareService",
  }]);
  assert.deepEqual(result.policies[2]?.unexpectedRules, [{
    interaction: ["update"],
    resourceType: "HealthcareService",
  }]);
  assert.equal(adapter.patchRequests.length, 0);
  const report = formatPracticeRolePolicyRuleSync(result);
  assert.match(report, /provider: MATCH AccessPolicy\/provider-policy/);
  assert.match(report, /admin: DRIFT AccessPolicy\/admin-policy/);
  assert.match(report, /missing .*HealthcareService/);
  assert.match(report, /unexpected .*HealthcareService/);
  assert.match(report, /Dry run only.*--apply/);
});

test("apply patches only resource, preserves all other fields, and converges on rerun", async () => {
  const policies = canonicalPolicies();
  const admin = policies.find((policy) => hasRole(policy, "admin"));
  assert.ok(admin);
  admin.name = "Practice-owned admin label";
  admin.extension = [{ url: "https://example.test/extension", valueString: "preserve-me" }];
  admin.resource = admin.resource?.filter((rule) => rule.resourceType !== "AuditEvent");
  const original = structuredClone(admin);
  const adapter = new FakePolicyRuleSyncAdapter(policies);
  const guard = async (): Promise<void> => {};

  const first = await syncPracticeRolePolicyRules(adapter, {
    projectId: PROJECT_ID,
    apply: true,
    assertProjectScope: guard,
  });

  assert.equal(first.policiesUpdated, 1);
  assert.equal(adapter.patchRequests.length, 1);
  const updated = adapter.policies.find((policy) => policy.id === "admin-policy");
  assert.ok(updated);
  assert.equal(updated.id, original.id);
  assert.equal(updated.name, original.name);
  assert.deepEqual(updated.meta?.tag, original.meta?.tag);
  assert.deepEqual(updated.meta?.security, original.meta?.security);
  assert.equal(updated.meta?.project, original.meta?.project);
  assert.deepEqual(updated.extension, original.extension);
  assert.deepEqual(adapter.patchRequests[0], {
    id: "admin-policy",
    operations: [{
      op: "replace",
      path: "/resource",
      value: buildMedplumAccessPolicy(getRoleDeclaration("admin")).resource,
    }],
    versionId: "7",
  });

  const second = await syncPracticeRolePolicyRules(adapter, {
    projectId: PROJECT_ID,
    apply: true,
    assertProjectScope: guard,
  });
  assert.equal(second.policiesUpdated, 0);
  assert.equal(adapter.patchRequests.length, 1);
  assert.ok(second.policies.every((policy) => policy.status === "match"));
});

test("sync refuses missing, duplicate, versionless, or ambiguously tagged policies before writing", async () => {
  const cases: { label: string; policies: AccessPolicy[]; pattern: RegExp }[] = [
    {
      label: "missing",
      policies: canonicalPolicies().filter((policy) => !hasRole(policy, "staff")),
      pattern: /Expected exactly one tagged staff AccessPolicy; found 0/,
    },
    {
      label: "duplicate",
      policies: [...canonicalPolicies(), canonicalPolicy("staff", "staff-duplicate")],
      pattern: /Expected exactly one tagged staff AccessPolicy; found 2/,
    },
    {
      label: "versionless",
      policies: canonicalPolicies().map((policy) => hasRole(policy, "provider")
        ? { ...policy, meta: { ...policy.meta, versionId: undefined } }
        : policy),
      pattern: /AccessPolicy\/provider-policy is missing meta.versionId/,
    },
    {
      label: "one policy tagged as two canonical roles",
      policies: canonicalPolicies()
        .filter((policy) => !hasRole(policy, "staff"))
        .map((policy) => hasRole(policy, "provider")
          ? {
              ...policy,
              meta: {
                ...policy.meta,
                tag: [
                  ...(policy.meta?.tag ?? []),
                  { system: ODOS_PRACTICE_ROLE_SYSTEM, code: "staff" },
                ],
              },
            }
          : policy),
      pattern: /AccessPolicy\/provider-policy has ambiguous practice-role tags: provider, staff/,
    },
  ];

  for (const { label, policies, pattern } of cases) {
    const adapter = new FakePolicyRuleSyncAdapter(policies);
    await assert.rejects(
      syncPracticeRolePolicyRules(adapter, {
        projectId: PROJECT_ID,
        apply: true,
        assertProjectScope: async () => {},
      }),
      pattern,
      label,
    );
    assert.equal(adapter.patchRequests.length, 0, label);
  }
});

test("a project mismatch refuses before policy reads or writes", async () => {
  const events: string[] = [];
  const adapter = new FakePolicyRuleSyncAdapter(canonicalPolicies(), events);

  await assert.rejects(
    syncPracticeRolePolicyRules(adapter, {
      projectId: PROJECT_ID,
      apply: true,
      assertProjectScope: async () => {
        events.push("guard");
        throw new Error("Authenticated session project super-admin does not match target project practice-1.");
      },
    }),
    /does not match target project/,
  );

  assert.deepEqual(events, ["guard"]);
  assert.equal(adapter.patchRequests.length, 0);
});

test("a stale version fails cleanly without retry or overwrite", async () => {
  const policies = canonicalPolicies();
  const provider = policies.find((policy) => hasRole(policy, "provider"));
  assert.ok(provider);
  provider.resource = provider.resource?.slice(1);
  const adapter = new FakePolicyRuleSyncAdapter(policies);
  adapter.stalePolicyId = "provider-policy";
  const before = structuredClone(adapter.policies);

  await assert.rejects(
    syncPracticeRolePolicyRules(adapter, {
      projectId: PROJECT_ID,
      apply: true,
      assertProjectScope: async () => {},
    }),
    /412 Precondition Failed/,
  );

  assert.equal(adapter.patchRequests.length, 1);
  assert.equal(adapter.patchRequests[0]?.versionId, "7");
  assert.deepEqual(adapter.policies, before);
});

test("a later stale failure reports earlier successful updates and safe rerun guidance", async () => {
  const policies = canonicalPolicies();
  const provider = policies.find((policy) => hasRole(policy, "provider"));
  const staff = policies.find((policy) => hasRole(policy, "staff"));
  assert.ok(provider);
  assert.ok(staff);
  provider.resource = provider.resource?.slice(1);
  staff.resource = staff.resource?.slice(1);
  const adapter = new FakePolicyRuleSyncAdapter(policies);
  adapter.stalePolicyId = "staff-policy";

  await assert.rejects(
    syncPracticeRolePolicyRules(adapter, {
      projectId: PROJECT_ID,
      apply: true,
      assertProjectScope: async () => {},
    }),
    /AccessPolicy\/staff-policy update failed after 1 policy update.*Re-run.*412 Precondition Failed/,
  );

  assert.equal(adapter.patchRequests.length, 2);
  const updatedProvider = adapter.policies.find((policy) => policy.id === "provider-policy");
  assert.deepEqual(
    updatedProvider?.resource,
    buildMedplumAccessPolicy(getRoleDeclaration("provider")).resource,
  );
  const unchangedStaff = adapter.policies.find((policy) => policy.id === "staff-policy");
  assert.deepEqual(unchangedStaff?.resource, staff.resource);
});

test("live adapter sends the deployed version as a weak If-Match header", async () => {
  let captured:
    | { resourceType: string; id: string; operations: JsonPatchOperation[]; headers?: Record<string, string> }
    | undefined;
  const fhir = {
    patch: async (
      resourceType: string,
      id: string,
      operations: JsonPatchOperation[],
      headers?: Record<string, string>,
    ) => {
      captured = { resourceType, id, operations, headers };
      return canonicalPolicy("admin", id);
    },
  } as unknown as MedplumClient;
  const adapter = new LivePracticeRolePolicyRuleSyncAdapter(fhir);
  const operations: JsonPatchOperation[] = [{ op: "replace", path: "/resource", value: [] }];

  await adapter.patchPolicy("admin-policy", operations, "19");

  assert.deepEqual(captured, {
    resourceType: "AccessPolicy",
    id: "admin-policy",
    operations,
    headers: { "If-Match": 'W/"19"' },
  });
});

test("project id is required from --project or MEDPLUM_PROJECT_ID", () => {
  assert.equal(
    requiredPracticeRolePolicyRuleSyncProjectId(["--project", " practice-explicit "], "practice-env"),
    "practice-explicit",
  );
  assert.equal(requiredPracticeRolePolicyRuleSyncProjectId([], " practice-env "), "practice-env");
  assert.throws(
    () => requiredPracticeRolePolicyRuleSyncProjectId([], undefined),
    /Supply --project <project-id> or MEDPLUM_PROJECT_ID/,
  );
});

function canonicalPolicies(): AccessPolicy[] {
  return PRACTICE_ROLE_IDS.map((role) => canonicalPolicy(role, `${role}-policy`));
}

function canonicalPolicy(role: PracticeRoleId, id: string): AccessPolicy {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
  return {
    ...policy,
    id,
    meta: {
      ...policy.meta,
      project: PROJECT_ID,
      versionId: "7",
      tag: [
        { system: "https://example.test/tags", code: "keep-tag" },
        ...(policy.meta?.tag ?? []),
      ],
      security: [{ system: "https://example.test/security", code: "keep-security" }],
    },
  };
}

function hasRole(policy: AccessPolicy, role: PracticeRoleId): boolean {
  return policy.meta?.tag?.some((tag) =>
    tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === role
  ) ?? false;
}

function applyPatch(policy: AccessPolicy, operations: readonly JsonPatchOperation[]): void {
  for (const operation of operations) {
    if (operation.op === "replace" && operation.path === "/resource") {
      policy.resource = structuredClone(operation.value) as AccessPolicy["resource"];
      continue;
    }
    if (operation.op === "add" && operation.path === "/resource") {
      policy.resource = structuredClone(operation.value) as AccessPolicy["resource"];
      continue;
    }
    if (operation.op === "remove" && operation.path === "/meta/tag") {
      if (policy.meta) delete policy.meta.tag;
      continue;
    }
    assert.fail(`Unexpected patch operation: ${JSON.stringify(operation)}`);
  }
}
