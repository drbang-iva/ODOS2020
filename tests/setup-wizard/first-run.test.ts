import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  InMemorySetupPracticeAdapter,
  projectFromInitResponse,
  SETUP_WIZARD_ACTION_REASON,
  SETUP_WIZARD_NOOP_REASON,
  runSetupPractice,
} from "../../scripts/setup-practice.ts";

test("fresh Compose startup maps ODOS service credentials into Medplum's super-admin seed settings", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  assert.match(compose, /MEDPLUM_DEFAULT_SUPER_ADMIN_EMAIL: \$\{MEDPLUM_ADMIN_EMAIL\}/);
  assert.match(compose, /MEDPLUM_DEFAULT_SUPER_ADMIN_PASSWORD: \$\{MEDPLUM_ADMIN_PASSWORD\}/);
});

test("setup accepts Medplum 5.1.8's direct Project response from Project/$init", () => {
  assert.deepEqual(
    projectFromInitResponse({ resourceType: "Project", id: "practice-project", name: "ODOS Test Practice" }),
    { resourceType: "Project", id: "practice-project", name: "ODOS Test Practice" },
  );
});

test("v0.5d setup wizard creates all five policies while granting the first human admin three roles with front-desk primary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    const adapter = new InMemorySetupPracticeAdapter();
    const config = {
      baseUrl: "http://localhost:8103",
      practiceName: "ODOS Test Practice",
      adminEmail: "human-admin@example.test",
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
    const clinicianPolicy = adapter.policies.find((policy) => policy.name === "ODOS Clinician");
    assert.equal(clinicianPolicy?.resourceType, "AccessPolicy");
    assert.equal(clinicianPolicy?.resource?.some((rule) => rule.resourceType === "Observation"), true);
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
    assert.equal(roleChanges[0]?.actionReason, "bootstrap first-admin roles for human-admin@example.test");

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

test("setup reuses a pre-existing canonical clinician policy while creating the other canonical policies", async () => {
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
        adminEmail: "human-admin@example.test",
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

test("setup fails before provisioning when the human admin email collides with the service identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-identity-collision-"));
  try {
    const adapter = new InMemorySetupPracticeAdapter();
    await assert.rejects(
      () => runSetupPractice({
        adapter,
        config: {
          baseUrl: "http://localhost:8103",
          practiceName: "ODOS Test Practice",
          adminEmail: "same@odos.local",
          adminName: "ODOS Admin",
          adminPassword: "not-real-password",
          statePath: join(dir, ".odos-setup-state.json"),
        },
        env: { MEDPLUM_ADMIN_EMAIL: " SAME@odos.local " },
        skipInteractiveBoundaryCheck: true,
      }),
      /ODOS_ADMIN_EMAIL must be distinct from MEDPLUM_ADMIN_EMAIL; refusing to grant first-admin practice roles to the configured Medplum service identity/,
    );
    assert.equal(adapter.admins.length, 0);
    assert.equal(adapter.practitioners.length, 0);
    assert.equal(adapter.policies.length, 0);
    assert.equal(adapter.assignments.length, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
