import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  InMemorySetupPracticeAdapter,
  resolveSessionContext,
  SETUP_WIZARD_ACTION_REASON,
  SETUP_WIZARD_NOOP_REASON,
  runSetupPractice,
} from "../../scripts/setup-practice.ts";

test("setup resolves the authenticated project membership from auth/me", async () => {
  const membership = {
    resourceType: "ProjectMembership" as const,
    id: "membership-1",
    project: { reference: "Project/project-1" },
    user: { reference: "User/user-1" },
  };
  const context = await resolveSessionContext({
    baseUrl: "http://localhost:8103/",
    accessToken: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({
      project: { id: "project-1" },
      membership,
    }), { status: 200 }),
  });

  assert.equal(context.projectId, "project-1");
  assert.deepEqual(context.membership, membership);
});

test("v0.5d setup wizard gives the first administrator front-desk, practice-admin, and clinician roles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    const adapter = new InMemorySetupPracticeAdapter();
    const config = {
      baseUrl: "http://localhost:8103",
      practiceName: "ODOS Test Practice",
      adminEmail: "admin@odos.local",
      adminName: "ODOS Admin",
      adminPassword: "not-real-password",
      statePath,
    };

    const firstRun = await runSetupPractice({
      adapter,
      config,
      skipInteractiveBoundaryCheck: true,
    });

    assert.equal(firstRun.noOp, false);
    assert.equal(adapter.admins.length, 1);
    assert.equal(adapter.practitioners.length, 1);
    assert.equal(adapter.policies.length, 5);
    assert.equal(adapter.assignments.length, 1);
    assert.equal(firstRun.state.completed, true);
    assert.equal(firstRun.practitionerId, "practitioner-1");
    assert.equal(firstRun.accessPolicyId, "access-policy-2");
    assert.deepEqual(adapter.policies.map((policy) => policy.name), [
      "ODOS Practice Admin",
      "ODOS Clinician",
      "ODOS Front Desk",
      "ODOS Auditor",
      "ODOS Aesthetics Provider",
    ]);
    assert.equal(adapter.policies[1]?.resourceType, "AccessPolicy");
    assert.equal(adapter.policies[1]?.resource?.some((rule) => rule.resourceType === "Observation"), true);
    assert.deepEqual(adapter.membership.access?.map((access) => access.policy.reference), [
      "AccessPolicy/access-policy-3",
      "AccessPolicy/access-policy-1",
      "AccessPolicy/access-policy-2",
    ]);

    assert.deepEqual(firstRun.auditRows.map((row) => row.eventType), [
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "create",
      "projectmembership-lifecycle",
    ]);
    for (const row of firstRun.auditRows) {
      assert.equal(row.actorId, "setup-wizard");
      assert.equal(row.actorRole, "system");
      assert.equal(row.actionReason, SETUP_WIZARD_ACTION_REASON);
    }
    const roleChanges = adapter.auditRows.filter((row) => row.eventType === "role-change");
    assert.equal(roleChanges.length, 1);
    assert.equal(roleChanges[0]?.resourceId, "project-membership-1");
    assert.equal(roleChanges[0]?.actionReason, "bootstrap first administrator role bundle");

    const secondRun = await runSetupPractice({
      adapter,
      config,
      skipInteractiveBoundaryCheck: true,
    });

    assert.equal(secondRun.noOp, true);
    assert.equal(adapter.admins.length, 1);
    assert.equal(adapter.practitioners.length, 1);
    assert.equal(adapter.policies.length, 5);
    assert.equal(adapter.assignments.length, 1);
    assert.equal(secondRun.auditRows.length, 1);
    assert.equal(secondRun.auditRows[0]?.eventType, "noop");
    assert.equal(secondRun.auditRows[0]?.actorId, "setup-wizard");
    assert.equal(secondRun.auditRows[0]?.actorRole, "system");
    assert.equal(secondRun.auditRows[0]?.actionReason, SETUP_WIZARD_NOOP_REASON);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("setup reuses one pre-existing canonical clinician policy instead of creating a duplicate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-existing-policy-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    const adapter = new InMemorySetupPracticeAdapter();
    adapter.policies.push({
      resourceType: "AccessPolicy",
      id: "existing-clinician-policy",
      name: "ODOS Clinician",
      meta: {
        tag: [{
          system: "https://odos2020.com/fhir/NamingSystem/practice-role",
          code: "clinician",
        }],
      },
    });

    const result = await runSetupPractice({
      adapter,
      config: {
        baseUrl: "http://localhost:8103",
        practiceName: "ODOS Test Practice",
        adminEmail: "admin@odos.local",
        adminName: "ODOS Admin",
        adminPassword: "not-real-password",
        statePath,
      },
      skipInteractiveBoundaryCheck: true,
    });

    assert.equal(result.state.completed, true);
    assert.equal(result.accessPolicyId, "existing-clinician-policy");
    assert.equal(adapter.policies.length, 5);
    assert.deepEqual(result.auditRows.map((row) => row.resourceType), [
      "Project",
      "Practitioner",
      "AccessPolicy",
      "AccessPolicy",
      "AccessPolicy",
      "AccessPolicy",
      "ProjectMembership",
    ]);
    assert.deepEqual(adapter.membership.access?.map((access) => access.policy.reference), [
      "AccessPolicy/access-policy-3",
      "AccessPolicy/access-policy-2",
      "AccessPolicy/existing-clinician-policy",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
