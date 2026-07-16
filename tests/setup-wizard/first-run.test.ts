import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  InMemorySetupPracticeAdapter,
  SETUP_WIZARD_ACTION_REASON,
  SETUP_WIZARD_NOOP_REASON,
  runSetupPractice,
} from "../../scripts/setup-practice.ts";

test("v0.5d setup wizard completes with the default shared bootstrap identity and audits its clinician grant", async () => {
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
    assert.equal(adapter.policies.length, 1);
    assert.equal(adapter.assignments.length, 1);
    assert.equal(firstRun.state.completed, true);
    assert.equal(firstRun.practitionerId, "practitioner-1");
    assert.equal(firstRun.accessPolicyId, "access-policy-1");
    assert.equal(adapter.policies[0]?.name, "ODOS Clinician");
    assert.equal(adapter.policies[0]?.resourceType, "AccessPolicy");
    assert.equal(adapter.policies[0]?.resource?.some((rule) => rule.resourceType === "Observation"), true);
    assert.deepEqual(adapter.membership.access?.map((access) => access.policy.reference), [
      "AccessPolicy/access-policy-1",
    ]);

    assert.deepEqual(firstRun.auditRows.map((row) => row.eventType), [
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
    assert.equal(roleChanges[0]?.actionReason, "bootstrap clinician role for admin@odos.local");

    const secondRun = await runSetupPractice({
      adapter,
      config,
      skipInteractiveBoundaryCheck: true,
    });

    assert.equal(secondRun.noOp, true);
    assert.equal(adapter.admins.length, 1);
    assert.equal(adapter.practitioners.length, 1);
    assert.equal(adapter.policies.length, 1);
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
    assert.equal(adapter.policies.length, 1);
    assert.deepEqual(result.auditRows.map((row) => row.resourceType), [
      "Project",
      "Practitioner",
      "ProjectMembership",
    ]);
    assert.deepEqual(adapter.membership.access?.map((access) => access.policy.reference), [
      "AccessPolicy/existing-clinician-policy",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
