import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  conditionalCreateSetupResource,
  createSetupServiceFhirClient,
  InMemorySetupPracticeAdapter,
  projectFromInitResponse,
  persistSetupState,
  provisionSetupOperatorIdentity,
  readSetupState,
  SETUP_WIZARD_ACTION_REASON,
  SETUP_WIZARD_NOOP_REASON,
  SETUP_PRACTICE_LOCATION_IDENTIFIER_SYSTEM,
  SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM,
  runSetupPractice,
} from "../../scripts/setup-practice.ts";
import { parseSchedulingPracticeConfig } from "../../mcp/src/scheduling/practice-config.ts";
import {
  buildVisitType,
  visitTypeCategory,
  visitTypeCode,
  visitTypeDurationMinutes,
} from "../../mcp/src/fhir/schedulingVisitType.ts";
import {
  buildVisitTypeConfigResource,
  parseVisitTypeConfig,
} from "../../mcp/src/scheduling/visit-type-config.ts";

test("fresh Compose startup maps ODOS service credentials into Medplum's super-admin seed settings", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  assert.match(compose, /MEDPLUM_DEFAULT_SUPER_ADMIN_EMAIL: \$\{MEDPLUM_ADMIN_EMAIL\}/);
  assert.match(compose, /MEDPLUM_DEFAULT_SUPER_ADMIN_PASSWORD: \$\{MEDPLUM_ADMIN_PASSWORD\}/);
});

test("setup-practice loads the root .env file when present", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts["setup-practice"]!, /--env-file-if-exists=\.env/);
});

test("setup replaces the installation manifest atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-atomic-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    writeFileSync(statePath, JSON.stringify({ version: "v0.5d", projectId: "old-project" }));
    const before = statSync(statePath).ino;
    persistSetupState(statePath, { version: "v0.5d", projectId: "new-project", completed: true });
    assert.notEqual(statSync(statePath).ino, before);
    assert.equal(readSetupState(statePath).projectId, "new-project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup accepts Medplum 5.1.8's direct Project response from Project/$init", () => {
  assert.deepEqual(
    projectFromInitResponse({ resourceType: "Project", id: "practice-project", name: "ODOS Test Practice" }),
    { resourceType: "Project", id: "practice-project", name: "ODOS Test Practice" },
  );
});

test("setup service reads retain Medplum project ownership metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const extended = new Headers(init?.headers).get("X-Medplum");
    return new Response(JSON.stringify({
      resourceType: "AccessPolicy",
      id: "policy-1",
      meta: extended === "extended" ? { project: "project-1" } : {},
    }), {
      status: 200,
      headers: { "Content-Type": "application/fhir+json" },
    });
  };
  try {
    const client = createSetupServiceFhirClient("http://medplum.test", "service-token");
    const policy = await client.read("AccessPolicy", "policy-1");
    assert.equal(policy.meta?.project, "project-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("setup conditional create reports whether this transaction created or resolved the resource", async () => {
  let capturedIfNoneExist: string | undefined;
  const created = await conditionalCreateSetupResource(
    {
      executeTransaction: async (bundle) => {
        capturedIfNoneExist = bundle.entry?.[0]?.request?.ifNoneExist;
        return {
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [{
            resource: {
              resourceType: "Organization",
              id: "created-organization",
              name: "ODOS Test Practice",
            },
            response: { status: "201 Created" },
          }],
        };
      },
      read: async () => {
        throw new Error("created response should not require a read");
      },
    },
    {
      resourceType: "Organization",
      name: "ODOS Test Practice",
    },
    "identifier=https://odos2020.com/fhir/NamingSystem/setup-practice-organization|primary",
  );

  assert.equal(created.created, true);
  assert.equal(created.resource.id, "created-organization");
  assert.equal(
    capturedIfNoneExist,
    "identifier=https://odos2020.com/fhir/NamingSystem/setup-practice-organization|primary",
  );

  const resolved = await conditionalCreateSetupResource(
    {
      executeTransaction: async () => ({
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [{
          response: {
            status: "200 OK",
            location: "Location/existing-location/_history/3",
          },
        }],
      }),
      read: async (_resourceType, id) => ({
        resourceType: "Location",
        id,
        status: "active",
      }),
    },
    {
      resourceType: "Location",
      status: "active",
    },
    "identifier=https://odos2020.com/fhir/NamingSystem/setup-practice-location|main",
  );

  assert.equal(resolved.created, false);
  assert.equal(resolved.resource.id, "existing-location");
});

test("setup wizard creates canonical role policies and binds one first-admin composite policy", async () => {
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
    assert.equal(adapter.organizations.length, 1);
    assert.equal(adapter.locations.length, 1);
    assert.equal(adapter.schedules.length, 1);
    assert.equal(adapter.schedulingConfigs.length, 1);
    assert.equal(adapter.policies.length, 4);
    assert.equal(adapter.assignments.length, 1);
    assert.equal(firstRun.state.completed, true);
    assert.equal(firstRun.state.organizationCreated, true);
    assert.equal(firstRun.state.organizationId, "organization-1");
    assert.equal(firstRun.state.locationCreated, true);
    assert.equal(firstRun.state.locationId, "location-1");
    assert.equal(firstRun.state.schedulingProvisioned, true);
    assert.equal(firstRun.state.scheduleId, "schedule-1");
    assert.equal(firstRun.state.schedulingConfigId, "scheduling-config-1");
    assert.equal(firstRun.practitionerId, "practitioner-1");
    assert.equal(firstRun.accessPolicyId, "access-policy-1");
    assert.equal(adapter.organizations[0]?.name, "ODOS Test Practice");
    assert.deepEqual(adapter.organizations[0]?.identifier, [{
      system: SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM,
      value: "primary",
    }]);
    assert.equal(adapter.locations[0]?.status, "active");
    assert.equal(
      adapter.locations[0]?.managingOrganization?.reference,
      "Organization/organization-1",
    );
    assert.deepEqual(adapter.locations[0]?.identifier, [{
      system: SETUP_PRACTICE_LOCATION_IDENTIFIER_SYSTEM,
      value: "main",
    }]);
    assert.equal(adapter.locations[0]?.address, undefined);
    assert.equal(adapter.locations[0]?.telecom, undefined);
    assert.deepEqual(adapter.policies.map((policy) => policy.name), [
      "ODOS Provider",
      "ODOS Staff",
      "ODOS Admin / Manager",
      "ODOS Composite Provider + Staff + Admin / Manager",
    ]);
    const providerPolicy = adapter.policies.find((policy) => policy.name === "ODOS Provider");
    assert.equal(providerPolicy?.resourceType, "AccessPolicy");
    assert.equal(providerPolicy?.resource?.some((rule) => rule.resourceType === "Observation"), true);
    assert.deepEqual(adapter.membership.access?.map((access) => access.policy.reference), [
      "AccessPolicy/access-policy-4",
    ]);
    assert.equal(adapter.schedules[0]?.actor?.[0]?.reference, "Practitioner/practitioner-1");
    const schedulingConfig = parseSchedulingPracticeConfig(adapter.schedulingConfigs[0]!);
    assert.deepEqual(schedulingConfig.defaultWeeklyHours.mon, [{ start: "09:00", end: "17:00" }]);
    assert.equal(schedulingConfig.offices[0]?.name, "Main Office");
    assert.equal(schedulingConfig.officeBySchedule["Schedule/schedule-1"], "main");

    assert.deepEqual(firstRun.auditRows.map((row) => row.eventType), [
      ...Array.from({ length: 20 }, () => "create"),
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
    assert.equal(adapter.organizations.length, 1);
    assert.equal(adapter.locations.length, 1);
    assert.equal(adapter.schedules.length, 1);
    assert.equal(adapter.schedulingConfigs.length, 1);
    assert.equal(adapter.policies.length, 4);
    assert.equal(adapter.assignments.length, 1);
    assert.equal(secondRun.auditRows.length, 1);
    assert.equal(secondRun.auditRows[0]?.eventType, "noop");
    assert.equal(secondRun.auditRows[0]?.actorId, "setup-wizard");
    assert.equal(secondRun.auditRows[0]?.actorRole, "system");
    assert.equal(secondRun.auditRows[0]?.actionReason, SETUP_WIZARD_NOOP_REASON);
    assert.equal(
      adapter.auditRows.filter((row) =>
        row.eventType === "create"
        && (row.resourceType === "Organization" || row.resourceType === "Location")
      ).length,
      2,
    );
    assert.deepEqual(readSetupState(statePath), firstRun.state);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("setup persists the default visit-type catalog and category config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-visit-types-"));
  try {
    const adapter = new InMemorySetupPracticeAdapter();
    const result = await runSetupPractice({
      adapter,
      config: {
        baseUrl: "http://localhost:8103",
        practiceName: "ODOS Test Practice",
        adminEmail: "human-admin@example.test",
        adminName: "ODOS Admin",
        adminPassword: "not-real-password",
        statePath: join(dir, ".odos-setup-state.json"),
      },
      skipInteractiveBoundaryCheck: true,
    });

    assert.equal(result.noOp, false);
    assert.deepEqual(adapter.visitTypes.map(visitTypeCode), [
      "routine-exam-new",
      "routine-exam-established",
      "contact-lens-exam",
      "contact-lens-follow-up",
      "office-visit",
      "special-testing",
      "aesthetics-consult",
      "aesthetics-treatment",
      "aesthetics-follow-up",
    ]);
    assert.deepEqual(
      parseVisitTypeConfig(adapter.visitTypeConfigs[0]!).categories.map((category) => category.id),
      ["exams", "contact-lens", "medical"],
    );
    assert.equal(
      result.auditRows.filter((row) => row.resourceType === "HealthcareService" && row.eventType === "create").length,
      9,
    );
    assert.equal(
      result.auditRows.filter((row) =>
        row.resourceType === "Basic" && row.resourceId === adapter.visitTypeConfigs[0]?.id
      ).length,
      1,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a setup re-run is a no-op and preserves edited or deactivated visit-type defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-visit-type-rerun-"));
  try {
    const adapter = new InMemorySetupPracticeAdapter();
    const existing = {
      ...buildVisitType({
        code: "routine-exam-new",
        name: "Practice-edited comprehensive visit",
        discipline: "eyecare",
        durationMinutes: 45,
        color: "#123456",
        active: false,
      }),
      id: "existing-routine-exam-new",
    };
    adapter.visitTypes.push(existing);
    const config = {
      baseUrl: "http://localhost:8103",
      practiceName: "ODOS Test Practice",
      adminEmail: "human-admin@example.test",
      adminName: "ODOS Admin",
      adminPassword: "not-real-password",
      statePath: join(dir, ".odos-setup-state.json"),
    };
    await runSetupPractice({ adapter, config, skipInteractiveBoundaryCheck: true });
    const preserved = adapter.visitTypes.find((visitType) => visitTypeCode(visitType) === "routine-exam-new");
    assert.notEqual(preserved, existing);
    assert.equal(adapter.visitTypes.length, 9);
    assert.equal(adapter.visitTypes.filter((visitType) => visitTypeCode(visitType) === "routine-exam-new").length, 1);
    assert.equal(preserved.name, "Practice-edited comprehensive visit");
    assert.equal(preserved.active, false);
    assert.equal(visitTypeCategory(preserved)?.code, "exams");
    assert.equal(preserved.extension?.find((extension) => extension.url.endsWith("odos-visit-duration"))?.valuePositiveInt, 45);

    const secondRun = await runSetupPractice({ adapter, config, skipInteractiveBoundaryCheck: true });

    assert.equal(secondRun.noOp, true);
    assert.equal(adapter.visitTypes.length, 9);
    assert.equal(preserved.name, "Practice-edited comprehensive visit");
    assert.equal(preserved.active, false);
    assert.equal(secondRun.auditRows.length, 1);
    assert.equal(secondRun.auditRows[0]?.eventType, "noop");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("setup reuses a pre-existing canonical Provider policy while creating Staff and Admin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-existing-policy-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    const adapter = new InMemorySetupPracticeAdapter();
    adapter.policies.push({
      resourceType: "AccessPolicy",
      id: "existing-clinician-policy",
      name: "ODOS Provider",
      meta: {
        tag: [{
          system: "https://odos2020.com/fhir/NamingSystem/practice-role",
          code: "provider",
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
    assert.equal(adapter.policies.length, 4);
    assert.deepEqual(result.auditRows.map((row) => row.resourceType), [
      "Project",
      "Practitioner",
      "Organization",
      "Location",
      "Schedule",
      "Basic",
      ...Array.from({ length: 9 }, () => "HealthcareService"),
      "Basic",
      "AccessPolicy",
      "AccessPolicy",
      "AccessPolicy",
      "AccessPolicy",
      "ProjectMembership",
    ]);
    assert.equal(result.auditRows.filter((row) => row.eventType === "update" && row.resourceId === "existing-clinician-policy").length, 1);
    assert.equal(adapter.policies.find((policy) => policy.id === "existing-clinician-policy")?.resource?.length! > 0, true);
    assert.deepEqual(adapter.membership.access?.map((access) => access.policy.reference), [
      "AccessPolicy/access-policy-4",
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a completed pre-taxonomy setup migrates installed visit categories and retires Medicaid before becoming a no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-retire-medicaid-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    const adapter = new InMemorySetupPracticeAdapter();
    adapter.visitTypes.push(
      {
        ...buildVisitType({
          code: "medicaid-exam",
          name: "Medicaid Exam",
          discipline: "eyecare",
          durationMinutes: 30,
        }),
        id: "legacy-medicaid-active",
      },
      {
        ...buildVisitType({
          code: "medicaid-exam",
          name: "Practice-edited Medicaid label",
          discipline: "eyecare",
          durationMinutes: 45,
          active: false,
        }),
        id: "legacy-medicaid-inactive",
      },
      {
        ...buildVisitType({
          code: "routine-exam-new",
          name: "Practice Annual Exam",
          discipline: "eyecare",
          durationMinutes: 40,
        }),
        id: "routine-customized",
      },
      {
        ...buildVisitType({
          code: "contact-lens-exam",
          name: "Contact Lens Exam",
          discipline: "eyecare",
          durationMinutes: 30,
        }),
        id: "contact-lens",
      },
      {
        ...buildVisitType({
          code: "office-visit",
          name: "Office Visit (Medical)",
          discipline: "eyecare",
          durationMinutes: 20,
        }),
        id: "medical",
      },
      {
        ...buildVisitType({
          code: "special-testing",
          name: "Special Testing (VF / OCT / Dry Eye)",
          discipline: "eyecare",
          durationMinutes: 30,
        }),
        id: "testing",
      },
      {
        ...buildVisitType({
          code: "aesthetics-consult",
          name: "Aesthetics Consult",
          discipline: "aesthetics",
          categoryCode: "dry-eye",
          categoryLabel: "Dry Eye",
          durationMinutes: 30,
        }),
        id: "aesthetics",
      },
      {
        ...buildVisitType({
          code: "practice-annual-exam",
          name: "Practice Annual Exam",
          discipline: "eyecare",
          categoryCode: "comprehensive",
          categoryLabel: "Comprehensive",
          durationMinutes: 50,
          active: false,
        }),
        id: "custom-legacy-exam",
      },
      {
        ...buildVisitType({
          code: "practice-dry-eye-check",
          name: "Practice Dry Eye Check",
          discipline: "eyecare",
          categoryCode: "dry-eye",
          categoryLabel: "Dry Eye",
          durationMinutes: 25,
        }),
        id: "custom-legacy-medical",
      },
    );
    adapter.visitTypeConfigs.push({
      ...buildVisitTypeConfigResource({
        categories: [
          { id: "comprehensive", label: "Comprehensive", order: 0 },
          { id: "dry-eye", label: "Dry Eye", order: 1 },
          { id: "myopia-management", label: "Myopia Management", order: 2 },
          { id: "diagnostic-only", label: "Diagnostic-Only", order: 3 },
          { id: "post-op", label: "Post-op", order: 4 },
        ],
      }),
      id: "legacy-visit-type-config",
    });
    writeFileSync(statePath, JSON.stringify({
      version: "v0.5d",
      adminProjectCreated: true,
      projectId: "project-1",
      practitionerCreated: true,
      practitionerId: "practitioner-1",
      organizationCreated: true,
      organizationId: "organization-1",
      locationCreated: true,
      locationId: "location-1",
      schedulingProvisioned: true,
      scheduleId: "schedule-1",
      schedulingConfigId: "scheduling-config-1",
      accessPolicyCreated: true,
      accessPolicyId: "access-policy-1",
      accessPolicyAssigned: true,
      completed: true,
    }));
    const config = {
      baseUrl: "http://localhost:8103",
      practiceName: "ODOS Test Practice",
      adminEmail: "human-admin@example.test",
      adminName: "ODOS Admin",
      adminPassword: "not-real-password",
      statePath,
    };

    const migrated = await runSetupPractice({ adapter, config, skipInteractiveBoundaryCheck: true });

    assert.equal(migrated.noOp, false);
    const visitTypeState = Object.fromEntries(adapter.visitTypes.map((visitType) => [visitType.id, {
      active: visitType.active,
      category: visitTypeCategory(visitType)?.code,
      duration: visitTypeDurationMinutes(visitType),
      name: visitType.name,
    }]));
    assert.deepEqual(visitTypeState["legacy-medicaid-active"], {
      active: false,
      category: undefined,
      duration: 30,
      name: "Medicaid Exam",
    });
    assert.equal(visitTypeState["legacy-medicaid-inactive"]?.active, false);
    assert.deepEqual(visitTypeState["routine-customized"], {
      active: true,
      category: "exams",
      duration: 40,
      name: "Practice Annual Exam",
    });
    assert.equal(visitTypeState["contact-lens"]?.category, "contact-lens");
    assert.equal(visitTypeState.medical?.category, "medical");
    assert.deepEqual(visitTypeState.testing, {
      active: true,
      category: "medical",
      duration: 20,
      name: "Testing Visit",
    });
    assert.equal(visitTypeState.aesthetics?.category, undefined);
    assert.deepEqual(visitTypeState["custom-legacy-exam"], {
      active: false,
      category: "exams",
      duration: 50,
      name: "Practice Annual Exam",
    });
    assert.deepEqual(visitTypeState["custom-legacy-medical"], {
      active: true,
      category: "medical",
      duration: 25,
      name: "Practice Dry Eye Check",
    });
    assert.deepEqual(parseVisitTypeConfig(adapter.visitTypeConfigs[0]!).categories, [
      { id: "exams", label: "Exams", order: 0 },
      { id: "contact-lens", label: "Contact Lens", order: 1 },
      { id: "medical", label: "Medical", order: 2 },
      { id: "post-op", label: "Post-op", order: 3 },
    ]);
    assert.equal(migrated.state.visitTypeTaxonomyReconciled, true);
    assert.deepEqual(
      migrated.auditRows
        .filter((row) => row.resourceType === "HealthcareService")
        .map((row) => ({ eventType: row.eventType, resourceId: row.resourceId })),
      [
        { eventType: "update", resourceId: "legacy-medicaid-active" },
        { eventType: "update", resourceId: "routine-customized" },
        { eventType: "update", resourceId: "contact-lens" },
        { eventType: "update", resourceId: "medical" },
        { eventType: "update", resourceId: "testing" },
        { eventType: "update", resourceId: "aesthetics" },
        { eventType: "update", resourceId: "custom-legacy-exam" },
        { eventType: "update", resourceId: "custom-legacy-medical" },
      ],
    );
    assert.equal(
      migrated.auditRows.some((row) => row.resourceType === "Basic" && row.resourceId === "legacy-visit-type-config"),
      true,
    );

    const rerun = await runSetupPractice({ adapter, config, skipInteractiveBoundaryCheck: true });
    assert.equal(rerun.noOp, true);
    assert.equal(rerun.auditRows.length, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a completed legacy setup without the scheduling marker resumes and seeds the missing foundation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-legacy-state-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    const adapter = new InMemorySetupPracticeAdapter();
    writeFileSync(statePath, JSON.stringify({
      version: "v0.5d",
      adminProjectCreated: true,
      practitionerCreated: true,
      practitionerId: "existing-practitioner",
      accessPolicyAssigned: true,
      completed: true,
    }));

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

    assert.equal(result.noOp, false);
    assert.equal(result.state.schedulingProvisioned, true);
    assert.equal(adapter.schedules[0]?.actor?.[0]?.reference, "Practitioner/existing-practitioner");
    assert.equal(adapter.schedulingConfigs.length, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("setup ignores an unrelated payer Organization and provisions stable practice resources once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-practice-resources-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    const adapter = new InMemorySetupPracticeAdapter();
    adapter.organizations.push({
      resourceType: "Organization",
      id: "payer-stub",
      active: true,
      name: "Contract Payer synthetic",
    });
    writeFileSync(statePath, JSON.stringify({
      version: "v0.5d",
      adminProjectCreated: true,
      projectId: "project-1",
      practitionerCreated: true,
      practitionerId: "existing-practitioner",
      schedulingProvisioned: true,
      scheduleId: "existing-schedule",
      schedulingConfigId: "existing-config",
      accessPolicyAssigned: true,
      completed: true,
    }));
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
    assert.equal(adapter.organizations.length, 2);
    assert.equal(firstRun.state.organizationId, "organization-2");
    assert.equal(adapter.locations.length, 1);
    assert.equal(firstRun.state.locationId, "location-1");
    assert.equal(
      adapter.locations[0]?.managingOrganization?.reference,
      "Organization/organization-2",
    );
    assert.deepEqual(
      firstRun.auditRows
        .filter((row) =>
          row.resourceType === "Organization" || row.resourceType === "Location"
        )
        .map((row) => row.eventType),
      ["create", "create"],
    );

    const secondRun = await runSetupPractice({
      adapter,
      config,
      skipInteractiveBoundaryCheck: true,
    });

    assert.equal(secondRun.noOp, true);
    assert.equal(adapter.organizations.length, 2);
    assert.equal(adapter.locations.length, 1);
    assert.equal(
      adapter.auditRows.filter((row) =>
        row.eventType === "create"
        && (row.resourceType === "Organization" || row.resourceType === "Location")
      ).length,
      2,
    );

    writeFileSync(statePath, JSON.stringify({
      ...readSetupState(statePath),
      organizationCreated: undefined,
      organizationId: undefined,
      locationCreated: undefined,
      locationId: undefined,
    }));
    const recovered = await runSetupPractice({
      adapter,
      config: { ...config, practiceName: "Renamed Practice" },
      skipInteractiveBoundaryCheck: true,
    });

    assert.equal(recovered.noOp, false);
    assert.equal(recovered.state.organizationId, "organization-2");
    assert.equal(recovered.state.locationId, "location-1");
    assert.equal(adapter.organizations.length, 2);
    assert.equal(adapter.locations.length, 1);
    assert.equal(
      recovered.auditRows.some((row) =>
        row.resourceType === "Organization" || row.resourceType === "Location"
      ),
      false,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("scheduling provisioning is not committed until both create audits succeed and retry re-emits them", async () => {
  class RetryableSchedulingAuditAdapter extends InMemorySetupPracticeAdapter {
    failBasicAudit = true;

    override async createSchedulingFoundation(
      input: Parameters<InMemorySetupPracticeAdapter["createSchedulingFoundation"]>[0],
    ) {
      const schedule = this.schedules[0];
      const practiceConfig = this.schedulingConfigs[0];
      const visitTypeConfig = this.visitTypeConfigs[0];
      if (schedule && practiceConfig && visitTypeConfig && this.visitTypes.length > 0) {
        return {
          schedule,
          scheduleCreated: false,
          practiceConfig,
          practiceConfigCreated: false,
          visitTypes: this.visitTypes.map((resource) => ({ resource, created: false })),
          visitTypeConfig,
          visitTypeConfigCreated: false,
        };
      }
      return super.createSchedulingFoundation(input);
    }

    override async emitAudit(row: Parameters<InMemorySetupPracticeAdapter["emitAudit"]>[0]) {
      if (this.failBasicAudit && row.resourceType === "Basic" && row.eventType === "create") {
        this.failBasicAudit = false;
        throw new Error("synthetic scheduling audit failure");
      }
      return super.emitAudit(row);
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-audit-retry-"));
  try {
    const statePath = join(dir, ".odos-setup-state.json");
    const adapter = new RetryableSchedulingAuditAdapter();
    const config = {
      baseUrl: "http://localhost:8103",
      practiceName: "ODOS Test Practice",
      adminEmail: "human-admin@example.test",
      adminName: "ODOS Admin",
      adminPassword: "not-real-password",
      statePath,
    };

    await assert.rejects(
      () => runSetupPractice({ adapter, config, skipInteractiveBoundaryCheck: true }),
      /synthetic scheduling audit failure/,
    );
    const failedState = JSON.parse(readFileSync(statePath, "utf8")) as {
      schedulingProvisioned?: boolean;
      scheduleId?: string;
      schedulingConfigId?: string;
    };
    assert.equal(failedState.schedulingProvisioned, undefined);
    assert.equal(failedState.scheduleId, "schedule-1");
    assert.equal(failedState.schedulingConfigId, "scheduling-config-1");

    const retried = await runSetupPractice({ adapter, config, skipInteractiveBoundaryCheck: true });
    assert.equal(retried.state.schedulingProvisioned, true);
    assert.equal(adapter.schedules.length, 1);
    assert.equal(adapter.schedulingConfigs.length, 1);
    assert.equal(adapter.auditRows.filter((row) => row.resourceType === "Schedule" && row.eventType === "create").length, 2);
    assert.equal(adapter.auditRows.filter((row) =>
      row.resourceType === "Basic"
      && row.resourceId === "scheduling-config-1"
      && row.eventType === "create"
    ).length, 1);
    assert.equal(adapter.auditRows.filter((row) =>
      row.resourceType === "Basic"
      && row.resourceId === "visit-type-config-1"
      && row.eventType === "create"
    ).length, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("setup accepts an explicit scheduling timezone offset instead of the host fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-setup-wizard-timezone-"));
  try {
    const adapter = new InMemorySetupPracticeAdapter();
    await runSetupPractice({
      adapter,
      config: {
        baseUrl: "http://localhost:8103",
        practiceName: "ODOS Test Practice",
        adminEmail: "human-admin@example.test",
        adminName: "ODOS Admin",
        adminPassword: "not-real-password",
        timezoneOffset: "+05:45",
        statePath: join(dir, ".odos-setup-state.json"),
      },
      skipInteractiveBoundaryCheck: true,
    });
    const schedulingConfig = parseSchedulingPracticeConfig(adapter.schedulingConfigs[0]!);
    assert.equal(schedulingConfig.timezoneOffset, "+05:45");
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

test("setup provisions the dedicated operator identity for the exact resulting project", async () => {
  const calls: unknown[] = [];
  const result = await provisionSetupOperatorIdentity({
    setupResult: {
      noOp: true,
      auditRows: [],
      state: { version: "v0.5d", projectId: "practice-1", completed: true },
    },
    config: {
      baseUrl: "http://localhost:8103",
      serviceIdentityEmail: "service@example.test",
      serviceIdentityPassword: "service-password",
      postgresUrl: "postgresql://medplum:medplum@127.0.0.1:5433/medplum",
    },
    provision: async (input) => {
      calls.push(input);
      return {
        accessToken: "operator-token",
        reused: false,
        state: { clientId: "operator-client", status: "active" },
      } as never;
    },
  });

  assert.equal(result.state.clientId, "operator-client");
  assert.deepEqual(calls, [{
    baseUrl: "http://localhost:8103",
    projectId: "practice-1",
    serviceEmail: "service@example.test",
    servicePassword: "service-password",
    postgresUrl: "postgresql://medplum:medplum@127.0.0.1:5433/medplum",
  }]);
});
