import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, ProjectMembership, ProjectMembershipAccess } from "@medplum/fhirtypes";
import {
  executeThreeRoleMigration,
  planThreeRoleMigration,
  type ThreeRoleMigrationAdapter,
} from "../../scripts/migrate-three-role-model.js";
import { ODOS_PRACTICE_ROLE_SYSTEM } from "../../mcp/src/authz/roles.js";

const PROJECT = "practice-1";

test("planner folds five legacy roles into three new policies and preserves access parameters", () => {
  const policies = [
    legacyPolicy("pa", "practice-admin"),
    legacyPolicy("audit", "auditor"),
    legacyPolicy("clinical", "clinician"),
    legacyPolicy("aesthetic", "aesthetics-provider"),
    legacyPolicy("desk", "front-desk"),
    unrelatedPolicy("other"),
  ];
  const parameter = [{ name: "patient_compartment", valueString: "Patient/synthetic-1" }];
  const membership = membershipFixture([
    access("pa", parameter),
    access("audit"),
    access("clinical", parameter),
    access("aesthetic"),
    access("desk"),
    access("other"),
  ]);

  const plan = planThreeRoleMigration({ projectId: PROJECT, policies, memberships: [membership] });

  assert.deepEqual(plan.canonicalRolesToCreate, ["provider", "staff", "admin"]);
  assert.deepEqual(plan.memberships[0]?.access, [
    { kind: "canonical", role: "admin", parameter },
    { kind: "canonical", role: "admin" },
    { kind: "canonical", role: "provider", parameter },
    { kind: "canonical", role: "provider" },
    { kind: "canonical", role: "staff" },
    { kind: "preserve", access: access("other") },
  ]);
  assert.deepEqual(membership.access?.[0]?.parameter, parameter);
});

test("planner deduplicates only identical canonical role and parameter entries", () => {
  const parameter = [{ name: "patient_compartment", valueString: "Patient/synthetic-1" }];
  const plan = planThreeRoleMigration({
    projectId: PROJECT,
    policies: [legacyPolicy("pa", "practice-admin"), legacyPolicy("audit", "auditor")],
    memberships: [membershipFixture([access("pa", parameter), access("audit", parameter), access("audit")])],
  });
  assert.deepEqual(plan.memberships[0]?.access, [
    { kind: "canonical", role: "admin", parameter },
    { kind: "canonical", role: "admin" },
  ]);
});

test("planner stops on ambiguous tags, ownership mismatch, missing version, and unmappable access", () => {
  const ambiguous = legacyPolicy("ambiguous", "clinician");
  ambiguous.meta!.tag!.push({ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "front-desk" });
  assert.throws(
    () => planThreeRoleMigration({ projectId: PROJECT, policies: [ambiguous], memberships: [membershipFixture([access("ambiguous")])] }),
    /ambiguous practice-role tags/,
  );

  const wrongProject = legacyPolicy("wrong-project", "front-desk");
  wrongProject.meta!.project = "other";
  assert.throws(
    () => planThreeRoleMigration({ projectId: PROJECT, policies: [wrongProject], memberships: [membershipFixture([access("wrong-project")])] }),
    /ownership mismatch/,
  );

  const missingVersion = membershipFixture([access("desk")]);
  delete missingVersion.meta;
  assert.throws(
    () => planThreeRoleMigration({ projectId: PROJECT, policies: [legacyPolicy("desk", "front-desk")], memberships: [missingVersion] }),
    /meta.versionId/,
  );

  assert.throws(
    () => planThreeRoleMigration({ projectId: PROJECT, policies: [], memberships: [membershipFixture([access("missing")])] }),
    /unmappable access/,
  );
});

test("dry-run performs zero writes; apply creates policies, conditionally patches, audits, and converges", async () => {
  const fixture = adapterFixture();
  const dryRun = await executeThreeRoleMigration(fixture.adapter, { projectId: PROJECT });
  assert.equal(dryRun.mode, "dry-run");
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.audits, []);

  const applied = await executeThreeRoleMigration(fixture.adapter, { projectId: PROJECT, apply: true });
  assert.equal(applied.mode, "apply");
  assert.deepEqual(fixture.writes.map((write) => write.kind), ["create-policy", "create-policy", "create-policy", "patch-membership"]);
  assert.equal(fixture.writes.at(-1)?.ifMatch, 'W/"7"');
  assert.deepEqual(fixture.audits, [
    "AccessPolicy/provider",
    "AccessPolicy/staff",
    "AccessPolicy/admin",
    "ProjectMembership/membership-1",
  ]);
  assert.deepEqual(fixture.membership.access?.map((entry) => entry.policy.reference), [
    "AccessPolicy/canonical-admin",
    "AccessPolicy/canonical-provider",
    "AccessPolicy/unrelated",
  ]);

  fixture.writes.length = 0;
  fixture.audits.length = 0;
  const second = await executeThreeRoleMigration(fixture.adapter, { projectId: PROJECT, apply: true });
  assert.equal(second.membershipsChanged, 0);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.audits, []);
});

function adapterFixture() {
  const policies: AccessPolicy[] = [
    legacyPolicy("legacy-admin", "practice-admin"),
    legacyPolicy("legacy-provider", "clinician"),
    unrelatedPolicy("unrelated"),
  ];
  const membership = membershipFixture([access("legacy-admin"), access("legacy-provider"), access("unrelated")]);
  const writes: Array<{ kind: string; ifMatch?: string }> = [];
  const audits: string[] = [];
  const adapter: ThreeRoleMigrationAdapter = {
    readPolicies: async () => structuredClone(policies),
    readMemberships: async () => [structuredClone(membership)],
    createPolicy: async (role, policy) => {
      writes.push({ kind: "create-policy" });
      const created = {
        ...policy,
        id: `canonical-${role}`,
        meta: { ...policy.meta, project: PROJECT, versionId: "1" },
      };
      policies.push(created);
      return structuredClone(created);
    },
    patchMembership: async (_id, nextAccess, ifMatch) => {
      writes.push({ kind: "patch-membership", ifMatch });
      membership.access = structuredClone(nextAccess);
      membership.meta = { ...membership.meta, versionId: "8" };
      return structuredClone(membership);
    },
    recordMutation: async (target, operation) => {
      audits.push(target);
      return operation();
    },
  };
  return { adapter, audits, membership, writes };
}

function legacyPolicy(id: string, role: string): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    id,
    meta: {
      project: PROJECT,
      versionId: "3",
      tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: role }],
    },
  };
}

function unrelatedPolicy(id: string): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    id,
    meta: { project: PROJECT, versionId: "2", tag: [{ system: "https://example.test/tag", code: "unrelated" }] },
  };
}

function membershipFixture(entries: ProjectMembershipAccess[]): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id: "membership-1",
    meta: { versionId: "7" },
    project: { reference: `Project/${PROJECT}` },
    user: { reference: "User/synthetic-user" },
    profile: { reference: "Practitioner/synthetic-practitioner" },
    access: entries,
  };
}

function access(id: string, parameter?: ProjectMembershipAccess["parameter"]): ProjectMembershipAccess {
  return { policy: { reference: `AccessPolicy/${id}` }, ...(parameter ? { parameter: structuredClone(parameter) } : {}) };
}
