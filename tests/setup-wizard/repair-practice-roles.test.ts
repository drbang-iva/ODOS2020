import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AccessPolicy, Bundle, Practitioner, ProjectMembership, Resource, User } from "@medplum/fhirtypes";
import {
  devPrimaryRole,
  loginForLocalRepair,
  membershipPolicyReferences,
  repairPracticeRoles,
  resolvePracticeRoleTarget,
  requiredEmailArgument,
  type PracticeRoleRepairAdapter,
} from "../../scripts/repair-practice-roles.ts";
import type { ResolvedRoleGrantTarget } from "../../mcp/src/authz/role-grants.ts";
import {
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
} from "../../mcp/src/authz/roles.ts";
import type { JsonPatchOperation } from "../../mcp/src/fhir-client.ts";

class FakeRepairAdapter implements PracticeRoleRepairAdapter {
  readonly policies: AccessPolicy[];
  readonly membership: ProjectMembership;
  policyWrites = 0;
  membershipWrites = 0;
  auditWrites = 0;

  constructor(input: { policies?: AccessPolicy[]; membership?: ProjectMembership } = {}) {
    this.policies = input.policies ?? [];
    this.membership = input.membership ?? membership();
  }

  async findPoliciesByName(name: string, projectId: string): Promise<AccessPolicy[]> {
    return this.policies.filter((policy) =>
      policy.name === name && policy.meta?.project === projectId
    );
  }

  async readPolicy(reference: string): Promise<AccessPolicy | undefined> {
    const id = reference.match(/^AccessPolicy\/([^/]+)$/)?.[1];
    return this.policies.find((policy) => policy.id === id);
  }

  async createPolicy(policy: AccessPolicy): Promise<AccessPolicy> {
    const created = {
      ...structuredClone(policy),
      id: `policy-${this.policies.length + 1}`,
      meta: {
        ...policy.meta,
        project: this.membership.project.reference?.replace(/^Project\//, ""),
        versionId: "1",
      },
    };
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

  async resolveTarget(target: string): Promise<ResolvedRoleGrantTarget> {
    return { email: target, membership: this.membership };
  }

  async patchMembership(id: string, operations: JsonPatchOperation[], versionId: string): Promise<ProjectMembership> {
    assert.equal(id, this.membership.id);
    assert.equal(versionId, this.membership.meta?.versionId);
    applyPatch(this.membership, operations);
    this.membership.meta = { ...this.membership.meta, versionId: String(Number(versionId) + 1) };
    this.membershipWrites += 1;
    return this.membership;
  }

  async recordMembershipChange<T>(_target: ResolvedRoleGrantTarget, operation: () => Promise<T>): Promise<T> {
    this.auditWrites += 1;
    return operation();
  }
}

test("missing role policies are created before the preserved legacy grant", async () => {
  const adapter = new FakeRepairAdapter({
    membership: membership({ accessPolicy: { reference: "AccessPolicy/keep-legacy" } }),
  });

  const result = await repairPracticeRoles(adapter, "human@example.test");

  assert.deepEqual(result.createdPolicies, PRACTICE_ROLE_IDS);
  assert.equal(result.primaryRole, "staff");
  assert.equal(result.targetEmail, "human@example.test");
  assert.equal(result.membershipChanged, true);
  assert.equal(result.membershipReference, "ProjectMembership/dev-membership");
  assert.equal(adapter.policyWrites, 4);
  assert.equal(adapter.membershipWrites, 1);
  assert.equal(adapter.policies.length, 4);
  for (const roleId of PRACTICE_ROLE_IDS) {
    assert.ok(adapter.policies.some((policy) => policy.meta?.tag?.some((tag) =>
      tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === roleId,
    )));
  }
  assert.deepEqual(membershipPolicyReferences(adapter.membership), [
    "AccessPolicy/policy-4",
    "AccessPolicy/keep-legacy",
  ]);
  assert.equal(adapter.membership.accessPolicy, undefined);
  assert.equal(adapter.auditWrites, 1);
});

test("a second repair is a zero-write idempotent no-op", async () => {
  const adapter = new FakeRepairAdapter();
  await repairPracticeRoles(adapter, "human@example.test");
  const policyWrites = adapter.policyWrites;
  const membershipWrites = adapter.membershipWrites;

  const result = await repairPracticeRoles(adapter, "human@example.test");

  assert.deepEqual(result.createdPolicies, []);
  assert.deepEqual(result.taggedPolicies, []);
  assert.deepEqual(result.existingPolicies, PRACTICE_ROLE_IDS);
  assert.equal(result.membershipChanged, false);
  assert.equal(adapter.policyWrites, policyWrites);
  assert.equal(adapter.membershipWrites, membershipWrites);
});

test("repair reconciles a drifted composite before leaving membership bindings unchanged", async () => {
  const adapter = new FakeRepairAdapter();
  await repairPracticeRoles(adapter, "human@example.test");
  const composite = adapter.policies.find((candidate) => candidate.name?.startsWith("ODOS Composite"));
  assert.ok(composite?.resource?.length);
  const expectedResource = structuredClone(composite.resource);
  composite.resource = composite.resource.slice(1);
  const priorPolicyWrites = adapter.policyWrites;
  const priorMembershipWrites = adapter.membershipWrites;

  const result = await repairPracticeRoles(adapter, "human@example.test");

  assert.equal(result.membershipChanged, false);
  assert.equal(adapter.policyWrites, priorPolicyWrites + 1);
  assert.equal(adapter.membershipWrites, priorMembershipWrites);
  assert.deepEqual(composite.resource, expectedResource);
});

test("Provider primary override compiles one role policy, preserves unrelated access, and remains idempotent", async () => {
  const adapter = new FakeRepairAdapter({
    membership: membership({
      access: [
        { policy: { reference: "AccessPolicy/policy-3" } },
        { policy: { reference: "AccessPolicy/unrelated" } },
        { policy: { reference: "AccessPolicy/policy-2" } },
        { policy: { reference: "AccessPolicy/policy-1" } },
        { policy: { reference: "AccessPolicy/policy-2" } },
      ],
    }),
  });

  const first = await repairPracticeRoles(adapter, "human@example.test", "provider");
  const writes = adapter.membershipWrites;
  const second = await repairPracticeRoles(adapter, "human@example.test", "provider");

  assert.equal(first.primaryRole, "provider");
  assert.deepEqual(adapter.membership.access?.map((access) => access.policy.reference), [
    "AccessPolicy/policy-4",
    "AccessPolicy/unrelated",
  ]);
  assert.equal(adapter.membershipWrites, writes);
  assert.equal(second.membershipChanged, false);
});

test("the primary-role environment value defaults safely and rejects unsupported roles", () => {
  assert.equal(devPrimaryRole(undefined), "staff");
  assert.equal(devPrimaryRole(" provider "), "provider");
  assert.throws(() => devPrimaryRole("admin"), /must be staff or provider/);
});

test("the repair CLI requires an explicit --email target", () => {
  assert.equal(requiredEmailArgument(["--email", "person@example.test"]), "person@example.test");
  assert.equal(requiredEmailArgument(["--email", "Practitioner/p1"]), "Practitioner/p1");
  assert.throws(() => requiredEmailArgument([]), /requires --email <email-or-Practitioner-reference>/);
  assert.throws(() => requiredEmailArgument(["--email"]), /requires --email <email-or-Practitioner-reference>/);
});

test("repair target resolution prefers canonical User.email over Practitioner telecom and stale display", async () => {
  const practitioner: Practitioner = { resourceType: "Practitioner", id: "p1", telecom: [{ system: "email", value: "searchable@example.test" }] };
  const user: User = { resourceType: "User", id: "dev-admin", email: "canonical@example.test" };
  const client = {
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      if (resourceType === "User") {
        assert.equal(id, "dev-admin");
        return user as T;
      }
      assert.equal(resourceType, "Practitioner");
      assert.equal(id, "p1");
      return practitioner as T;
    },
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      if (resourceType === "Practitioner") return bundle([practitioner as T]);
      assert.equal(params.profile, "Practitioner/p1");
      return bundle([membership({ profile: { reference: "Practitioner/p1" } }) as T]);
    },
  };
  const byEmail = await resolvePracticeRoleTarget(client, "searchable@example.test");
  const byReference = await resolvePracticeRoleTarget(client, "Practitioner/p1");
  assert.equal(byEmail.email, "canonical@example.test");
  assert.equal(byReference.email, "canonical@example.test");
});

test("one untagged canonical policy is tagged without replacing unrelated metadata", async () => {
  const adapter = new FakeRepairAdapter({
    policies: [{
      resourceType: "AccessPolicy",
      id: "admin-policy",
      name: "ODOS Admin / Manager",
      meta: {
        project: "local-practice",
        versionId: "7",
        tag: [{ system: "https://example.test", code: "keep" }],
      },
    }],
  });

  const result = await repairPracticeRoles(adapter, "human@example.test");

  assert.deepEqual(result.taggedPolicies, ["admin"]);
  assert.deepEqual(adapter.policies[0]?.meta?.tag, [
    { system: "https://example.test", code: "keep" },
    { system: ODOS_PRACTICE_ROLE_SYSTEM, code: "admin" },
  ]);
});

test("repair ignores an identically named foreign policy and creates a project-owned replacement", async () => {
  const foreign = policy("foreign-admin", "admin");
  foreign.meta = { ...foreign.meta, project: "other-practice" };
  const before = structuredClone(foreign);
  const adapter = new FakeRepairAdapter({ policies: [foreign] });

  const result = await repairPracticeRoles(adapter, "human@example.test");

  assert.ok(result.createdPolicies.includes("admin"));
  assert.deepEqual(foreign, before);
  assert.ok(adapter.policies.some((candidate) =>
    candidate.id !== foreign.id
    && candidate.name === foreign.name
    && candidate.meta?.project === "local-practice"
  ));
});

test("duplicate canonical policies stop repair before membership mutation", async () => {
  const adapter = new FakeRepairAdapter({ policies: [policy("a", "admin"), policy("b", "admin")] });

  await assert.rejects(() => repairPracticeRoles(adapter, "human@example.test"), /2 exact matches; repair stopped without guessing/);
  assert.equal(adapter.membershipWrites, 0);
});

test("a wrong ODOS role tag stops repair without overwriting it", async () => {
  const wrong = policy("wrong", "admin");
  wrong.meta!.tag = [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "provider" }];
  const adapter = new FakeRepairAdapter({ policies: [wrong] });

  await assert.rejects(() => repairPracticeRoles(adapter, "human@example.test"), /conflicting practice-role code/);
  assert.deepEqual(wrong.meta.tag, [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "provider" }]);
  assert.equal(adapter.membershipWrites, 0);
});

test("local repair login refuses a multi-membership response before token exchange", async () => {
  let tokenCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/auth/login") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        login: "login-1",
        memberships: [
          { id: "membership-super", project: { reference: "Project/super-admin" } },
          { id: "membership-practice", project: { reference: "Project/practice-1" } },
        ],
      }));
      return;
    }
    if (request.url === "/oauth2/token") tokenCalls += 1;
    response.statusCode = 500;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () => loginForLocalRepair({
        baseUrl: `http://127.0.0.1:${address.port}`,
        email: "admin@example.test",
        password: "not-a-real-password",
      }),
      /found 2 project memberships.*--project <project-id>.*MEDPLUM_PROJECT_ID/,
    );
    assert.equal(tokenCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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

function policy(id: string, roleId: "admin" | "provider"): AccessPolicy {
  const display = roleId === "admin" ? "Admin / Manager" : "Provider";
  return {
    resourceType: "AccessPolicy",
    id,
    name: `ODOS ${display}`,
    meta: {
      project: "local-practice",
      versionId: "1",
      tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: roleId }],
    },
  };
}

function bundle<T extends Resource>(resources: T[]): Bundle<T> {
  return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource })) };
}

function applyPatch(target: AccessPolicy | ProjectMembership, operations: JsonPatchOperation[]): void {
  for (const operation of operations) {
    if (operation.path === "/meta/tag/-") {
      assert.equal(operation.op, "add");
      assert.ok(target.meta?.tag);
      target.meta.tag.push(operation.value as NonNullable<AccessPolicy["meta"]>["tag"][number]);
    } else if (operation.path === "/access") {
      assert.ok(operation.op === "add" || operation.op === "replace");
      (target as ProjectMembership).access = operation.value as ProjectMembership["access"];
    } else if (operation.path === "/access/-") {
      assert.equal(operation.op, "add");
      assert.ok((target as ProjectMembership).access);
      (target as ProjectMembership).access!.push(operation.value as NonNullable<ProjectMembership["access"]>[number]);
    } else if (operation.path === "/access/0") {
      assert.equal(operation.op, "add");
      assert.ok((target as ProjectMembership).access);
      (target as ProjectMembership).access!.splice(0, 0, operation.value as NonNullable<ProjectMembership["access"]>[number]);
    } else if (operation.path === "/accessPolicy") {
      assert.equal(operation.op, "remove");
      delete (target as ProjectMembership).accessPolicy;
    } else if (operation.path === "/resource") {
      assert.ok(operation.op === "add" || operation.op === "replace");
      (target as AccessPolicy).resource = operation.value as AccessPolicy["resource"];
    } else {
      assert.fail(`Unexpected patch path ${operation.path}`);
    }
  }
}
