import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AccessPolicy,
  AccessPolicyResource,
  Encounter,
  ProjectMembership,
} from "@medplum/fhirtypes";
import fhirpath from "fhirpath";
import {
  grantPracticeRoles,
  reconcileMembershipAccess,
  resolveProjectCompositeAccessPolicy,
  type PracticeRoleGrantDependencies,
} from "../src/authz/role-grants.js";
import {
  buildMedplumAccessPolicy,
  buildMedplumCompositeAccessPolicy,
  getRoleDeclaration,
  type PracticeRoleId,
} from "../src/authz/roles.js";
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
    ["staff", { ...buildMedplumAccessPolicy(getRoleDeclaration("staff")), id: "desk" }],
    ["admin", { ...buildMedplumAccessPolicy(getRoleDeclaration("admin")), id: "admin" }],
    ["provider", { ...buildMedplumAccessPolicy(getRoleDeclaration("provider")), id: "clinical" }],
  ]);
  const boundPolicies = new Map<string, AccessPolicy>(
    [...policies.values()].map((policy) => [`AccessPolicy/${policy.id}`, policy]),
  );
  const deps: PracticeRoleGrantDependencies = {
    serviceIdentityEmail: input.serviceIdentityEmail,
    resolveTarget: async () => ({ email: input.email ?? "human@example.test", membership }),
    resolvePolicy: async (role) => policies.get(role)!,
    resolveBoundPolicy: async (reference) => boundPolicies.get(reference),
    resolveCompositePolicy: async (roles) => {
      const policy = {
        ...buildMedplumCompositeAccessPolicy(roles),
        id: roles.join("-"),
        meta: { ...buildMedplumCompositeAccessPolicy(roles).meta, project: "p1" },
      };
      boundPolicies.set(`AccessPolicy/${policy.id}`, policy);
      return policy;
    },
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

test("grantPracticeRoles binds one composite policy, preserves parameters, and clears legacy accessPolicy", async () => {
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
    "AccessPolicy/provider-staff",
    "AccessPolicy/provider-staff",
    "AccessPolicy/unrelated",
  ]);
  assert.equal(membership.access?.[0]?.parameter, undefined);
  assert.deepEqual(membership.access?.[1]?.parameter, [
    { name: "provider_provider_profile", valueReference: { reference: "Practitioner/p1" } },
  ]);
  assert.equal(membership.accessPolicy, undefined);
  assert.deepEqual(counts(), { auditCount: 1, patchCount: 1 });
});

test("composite compilation preserves disjoint Provider and Staff patient grants", async () => {
  const { deps, membership } = fixture({
    membership: baseMembership({
      access: [
        {
          policy: { reference: "AccessPolicy/clinical" },
          parameter: [{ name: "patient_compartment", valueString: "Patient/provider-only" }],
        },
        {
          policy: { reference: "AccessPolicy/desk" },
          parameter: [{ name: "patient_compartment", valueString: "Patient/staff-only" }],
        },
      ],
    }),
  });

  await grantPracticeRoles(
    { target: "human@example.test", roles: ["provider", "staff"], primaryRole: "provider" },
    deps,
  );

  assert.deepEqual(membership.access, [
    { policy: { reference: "AccessPolicy/provider-staff" } },
    {
      policy: { reference: "AccessPolicy/provider-staff" },
      parameter: [{ name: "provider_patient_compartment", valueString: "Patient/provider-only" }],
    },
    {
      policy: { reference: "AccessPolicy/provider-staff" },
      parameter: [{ name: "staff_patient_compartment", valueString: "Patient/staff-only" }],
    },
  ]);
});

test("incremental Admin grant recompiles an existing Provider and Staff composite", async () => {
  const existing = {
    ...buildMedplumCompositeAccessPolicy(["provider", "staff"]),
    id: "provider-staff",
    meta: { ...buildMedplumCompositeAccessPolicy(["provider", "staff"]).meta, project: "p1" },
  };
  const { deps, membership } = fixture({
    membership: baseMembership({ access: [{ policy: { reference: "AccessPolicy/provider-staff" } }] }),
  });
  deps.resolveBoundPolicy = async (reference) =>
    reference === "AccessPolicy/provider-staff" ? existing : undefined;

  await grantPracticeRoles(
    { target: "human@example.test", roles: ["admin"], primaryRole: "admin" },
    deps,
  );

  assert.deepEqual(membership.access, [
    { policy: { reference: "AccessPolicy/provider-staff-admin" } },
  ]);
});

test("finished Encounter capability is identical for Provider to Staff and Staff to Provider access order", () => {
  const provider = {
    ...buildMedplumAccessPolicy(getRoleDeclaration("provider")),
    id: "clinical",
  };
  const staff = {
    ...buildMedplumAccessPolicy(getRoleDeclaration("staff")),
    id: "desk",
  };
  const composite: AccessPolicy = {
    ...buildMedplumCompositeAccessPolicy(["provider", "staff"]),
    id: "provider-staff",
  };
  const policies = new Map([
    ["AccessPolicy/clinical", provider],
    ["AccessPolicy/desk", staff],
    ["AccessPolicy/provider-staff", composite],
  ]);

  for (const sourceOrder of [
    ["AccessPolicy/clinical", "AccessPolicy/desk"],
    ["AccessPolicy/desk", "AccessPolicy/clinical"],
  ]) {
    const membership = baseMembership({
      access: sourceOrder.map((reference) => ({
        policy: { reference },
        parameter: [{ name: "patient_compartment", valueString: "Patient/patient-1" }],
      })),
    });
    applyPatch(
      membership,
      reconcileMembershipAccess(
        membership,
        sourceOrder,
        "AccessPolicy/provider-staff",
        new Map([
          ["AccessPolicy/clinical", ["provider"] as const],
          ["AccessPolicy/desk", ["staff"] as const],
        ]),
      ),
    );

    assert.deepEqual(
      [...new Set(membership.access?.map((access) => access.policy.reference))],
      ["AccessPolicy/provider-staff"],
    );
    assert.equal(finishedEncounterUpdateAllowed(membership, policies), true);
  }
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

test("grantPracticeRoles rejects an unscoped composite policy before membership mutation", async () => {
  const { deps, counts } = fixture();
  deps.resolveCompositePolicy = async (roles) => ({
    ...buildMedplumCompositeAccessPolicy(roles),
    id: "unscoped-composite",
  });

  await assert.rejects(
    grantPracticeRoles(
      { target: "human@example.test", roles: ["provider", "staff"], primaryRole: "provider" },
      deps,
    ),
    /Composite AccessPolicy\/unscoped-composite is missing Project\/p1 ownership/,
  );
  assert.deepEqual(counts(), { auditCount: 0, patchCount: 0 });
});

test("project composite resolver creates target-owned policy and reconciles rule drift", async () => {
  const policies: AccessPolicy[] = [];
  let patches = 0;
  let createHeaders: Record<string, string> | undefined;
  const store = {
    findPoliciesByName: async (name: string) => policies.filter((policy) => policy.name === name),
    createPolicy: async (policy: AccessPolicy, headers?: Record<string, string>) => {
      createHeaders = headers;
      const created = { ...structuredClone(policy), id: "composite", meta: { ...policy.meta, versionId: "1" } };
      policies.push(created);
      return created;
    },
    patchPolicy: async (_id: string, operations: JsonPatchOperation[]) => {
      patches += 1;
      const policy = policies[0]!;
      policy.resource = operations[0]!.value as AccessPolicy["resource"];
      return policy;
    },
  };
  const expected = buildMedplumCompositeAccessPolicy(["provider", "staff"]);

  const created = await resolveProjectCompositeAccessPolicy(
    store,
    "p1",
    ["provider", "staff"],
    expected,
  );
  assert.equal(created.meta?.project, "p1");
  assert.equal(createHeaders?.["X-Medplum"], "extended");
  created.resource = created.resource?.slice(1);

  const reconciled = await resolveProjectCompositeAccessPolicy(
    store,
    "p1",
    ["provider", "staff"],
    expected,
  );
  assert.deepEqual(reconciled.resource, expected.resource);
  assert.equal(patches, 1);
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

function finishedEncounterUpdateAllowed(
  membership: ProjectMembership,
  policies: ReadonlyMap<string, AccessPolicy>,
): boolean {
  const before: Encounter = {
    resourceType: "Encounter",
    status: "finished",
    class: { code: "AMB" },
  };
  const after: Encounter = {
    ...before,
    diagnosis: [{ condition: { reference: "Condition/diagnosis-1" } }],
  };

  for (const access of membership.access ?? []) {
    const policy = policies.get(access.policy.reference ?? "");
    const rule = policy?.resource?.find((candidate) =>
      candidate.resourceType === "Encounter" && candidate.interaction?.includes("update")
    );
    if (!rule) continue;
    return ruleAllowsEncounterUpdate(rule, before, after);
  }
  return false;
}

function ruleAllowsEncounterUpdate(
  rule: AccessPolicyResource,
  before: Encounter,
  after: Encounter,
): boolean {
  return (rule.writeConstraint ?? []).every((constraint) => {
    const result = fhirpath.evaluate(after, constraint.expression ?? "", { before, after });
    return result.length === 1 && result[0] === true;
  });
}
