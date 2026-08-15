import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, AccessPolicyResource, Encounter } from "@medplum/fhirtypes";
import fhirpath from "fhirpath";
import {
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  assertAestheticsProviderScope,
  assertBusinessActionAllowed,
  buildMedplumAccessPolicy,
  getRoleDeclaration,
} from "../src/authz/roles.js";

test("the active practice-role catalog contains only Provider, Staff, and Admin", () => {
  assert.deepEqual(PRACTICE_ROLE_IDS, ["provider", "staff", "admin"]);
  assert.equal(ODOS_PRACTICE_ROLE_SYSTEM, "https://odos2020.com/fhir/NamingSystem/practice-role");
  assert.deepEqual(
    PRACTICE_ROLE_IDS.map((roleId) => getRoleDeclaration(roleId).display),
    ["Provider", "Staff", "Admin / Manager"],
  );
});

test("correction authority stays clinical for Provider and financial or inventory for Admin", () => {
  for (const action of ["clinical.sign", "aesthetics.procedure.write"] as const) {
    assert.doesNotThrow(() => assertBusinessActionAllowed("provider", action));
    assert.throws(() => assertBusinessActionAllowed("staff", action), /lacks business action/);
    assert.throws(() => assertBusinessActionAllowed("admin", action), /lacks business action/);
  }

  for (const action of [
    "payment.void",
    "payment.seal-day",
    "margin.read",
    "inventory.adjust",
    "inventory.price",
  ] as const) {
    assert.doesNotThrow(() => assertBusinessActionAllowed("admin", action));
    assert.throws(() => assertBusinessActionAllowed("staff", action), /lacks business action/);
    assert.throws(() => assertBusinessActionAllowed("provider", action), /lacks business action/);
  }

  for (const roleId of PRACTICE_ROLE_IDS) {
    assert.doesNotThrow(() => assertBusinessActionAllowed(roleId, "chart.read"));
  }
  for (const roleId of ["staff", "provider"] as const) {
    assert.doesNotThrow(() => assertBusinessActionAllowed(roleId, "payment.charge"));
  }
});

test("all roles read operational records at practice scope while Staff writes stay constrained", () => {
  for (const roleId of PRACTICE_ROLE_IDS) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    for (const resourceType of [
      "Patient",
      "Observation",
      "Coverage",
      "Schedule",
      "PaymentReconciliation",
    ]) {
      const readRule = policy.resource?.find((rule) =>
        rule.resourceType === resourceType &&
        rule.interaction?.includes("read") &&
        rule.interaction?.includes("search") &&
        !rule.interaction?.includes("create") &&
        !rule.interaction?.includes("update"));
      assert.ok(readRule, `${roleId} needs a read-only ${resourceType} rule`);
      assert.equal(readRule.criteria, undefined, `${roleId} ${resourceType} read must be practice-scoped`);
    }
  }

  const staff = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const patientWrite = staff.resource?.find((rule) =>
    rule.resourceType === "Patient" && rule.interaction?.includes("update"));
  assert.equal(patientWrite?.criteria, "Patient?_compartment=%patient_compartment");

  const observationWrite = staff.resource?.find((rule) =>
    rule.resourceType === "Observation" && rule.interaction?.includes("update"));
  assert.equal(observationWrite?.criteria, "Observation?_compartment=%patient_compartment");
  assert.match(
    observationWrite?.writeConstraint?.map((constraint) => constraint.expression).join(" ") ?? "",
    /status = 'preliminary'/,
  );
  assert.doesNotMatch(
    observationWrite?.writeConstraint?.map((constraint) => constraint.expression).join(" ") ?? "",
    /status = 'amended'/,
  );
});

test("Door 1 actor gating leaves Provider, Staff, and Admin Appointment reads practice-wide", () => {
  for (const roleId of ["provider", "staff", "admin"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    const appointmentReads = policy.resource?.filter((rule) =>
      rule.resourceType === "Appointment" && rule.interaction?.includes("read")) ?? [];
    assert.equal(
      appointmentReads.some((rule) => rule.criteria === undefined),
      true,
      `${roleId} keeps its existing practice-wide scheduling read`,
    );
  }
});

test("three-role policies allow only Admin to write HealthcareService without wildcard or delete", () => {
  const adminPolicy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  assert.equal(
    adminPolicy.resource?.some((rule) => rule.resourceType === "*"),
    false,
    "the retired practice-admin wildcard must not return",
  );

  for (const interaction of ["create", "update"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "HealthcareService", interaction),
      true,
      `Admin must be permitted to ${interaction} HealthcareService`,
    );
    for (const roleId of ["staff", "provider"] as const) {
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
      assert.equal(
        accessPolicyAllows(policy, "HealthcareService", interaction),
        false,
        `${roleId} must be rejected from ${interaction} HealthcareService`,
      );
    }
  }

  for (const roleId of PRACTICE_ROLE_IDS) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    assert.equal(
      accessPolicyAllows(policy, "HealthcareService", "delete"),
      false,
      `${roleId} must be rejected from deleting HealthcareService`,
    );
  }
});

test("three-role policies allow only Admin to write the visit-type category singleton", () => {
  const criteria =
    "Basic?code=https://odos2020.com/fhir/CodeSystem/visit-type-config|odos-visit-type-config";
  const adminPolicy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));

  assert.equal(
    adminPolicy.resource?.some((rule) => rule.resourceType === "*"),
    false,
    "the retired practice-admin wildcard must not return",
  );

  for (const interaction of ["create", "update"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "Basic", interaction, criteria),
      true,
      `Admin must be permitted to ${interaction} the visit-type category singleton`,
    );
    for (const roleId of ["provider", "staff"] as const) {
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
      assert.equal(
        accessPolicyAllows(policy, "Basic", interaction, criteria),
        false,
        `${roleId} must be rejected from ${interaction} of the visit-type category singleton`,
      );
    }
  }
});

test("three-role policies allow only Admin to read AccessPolicy at practice scope without write access or wildcard", () => {
  const adminPolicy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  const adminRule = adminPolicy.resource?.find((rule) => rule.resourceType === "AccessPolicy");
  assert.ok(adminRule, "Admin needs an explicit AccessPolicy rule");
  assert.equal(adminRule.criteria, undefined, "Admin AccessPolicy reads must be practice-scoped");
  assert.equal(
    adminPolicy.resource?.some((rule) => rule.resourceType === "*"),
    false,
    "the retired practice-admin wildcard must not return",
  );

  for (const interaction of ["read", "search", "history", "vread"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "AccessPolicy", interaction),
      true,
      `Admin must be permitted to ${interaction} AccessPolicy`,
    );
    for (const roleId of ["provider", "staff"] as const) {
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
      assert.equal(
        accessPolicyAllows(policy, "AccessPolicy", interaction),
        false,
        `${roleId} must be rejected from ${interaction} AccessPolicy`,
      );
      assert.equal(
        policy.resource?.some((rule) => rule.resourceType === "*"),
        false,
        `${roleId} must not regain a wildcard`,
      );
    }
  }

  for (const interaction of ["create", "update", "delete"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "AccessPolicy", interaction),
      false,
      `Admin must be rejected from ${interaction} AccessPolicy`,
    );
  }
});

test("Staff Encounter writes allow unfinished work but reject finalization and reopening", () => {
  const staff = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const encounterWrite = staff.resource?.find((rule) =>
    rule.resourceType === "Encounter" && rule.interaction?.includes("update"));
  assert.ok(encounterWrite?.writeConstraint?.length);

  assert.equal(staffEncounterWriteAllowed(encounterWrite.writeConstraint, undefined, "in-progress"), true);
  assert.equal(staffEncounterWriteAllowed(encounterWrite.writeConstraint, "planned", "in-progress"), true);
  assert.equal(staffEncounterWriteAllowed(encounterWrite.writeConstraint, "in-progress", "finished"), false);
  assert.equal(staffEncounterWriteAllowed(encounterWrite.writeConstraint, "finished", "in-progress"), false);
});

test("Admin has no wildcard write bypass and Staff inventory writes cannot correct counts or prices", () => {
  const admin = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  assert.equal(
    admin.resource?.some((rule) =>
      rule.resourceType === "*" &&
      (rule.interaction?.includes("create") || rule.interaction?.includes("update") || rule.interaction?.includes("delete"))),
    false,
  );

  const staff = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const unitRules = staff.resource?.filter((rule) =>
    rule.resourceType === "Basic" && rule.criteria?.endsWith("|practice-frame-inventory-unit")) ?? [];
  assert.equal(unitRules.some((rule) => rule.interaction?.includes("delete")), false);
  assert.equal(unitRules.some((rule) => rule.interaction?.includes("create")), true);
  assert.equal(unitRules.some((rule) => rule.interaction?.includes("update")), true);
  assert.match(
    unitRules.flatMap((rule) => rule.writeConstraint ?? []).map((constraint) => constraint.expression).join(" "),
    /received-at/,
  );

  const settingsRules = staff.resource?.filter((rule) =>
    rule.resourceType === "Basic" && rule.criteria?.endsWith("|practice-frame-variant-settings")) ?? [];
  assert.equal(settingsRules.some((rule) => rule.interaction?.includes("create")), false);
  assert.equal(settingsRules.some((rule) => rule.interaction?.includes("update")), false);
  assert.equal(settingsRules.some((rule) => rule.interaction?.includes("read")), true);
});

test("aesthetics license and procedure scope is a Provider membership parameter", () => {
  const provider = getRoleDeclaration("provider");
  assert.deepEqual(
    provider.membershipParameters?.map((parameter) => parameter.name),
    ["provider_profile", "patient_compartment", "license_state", "procedure_scope"],
  );
  assert.doesNotThrow(() => assertAestheticsProviderScope({
    roleId: "provider",
    licensedStates: ["TX"],
    requestedState: "TX",
    procedureType: "injectables",
    allowedProcedureTypesByState: { TX: ["injectables"] },
  }));
});

function staffEncounterWriteAllowed(
  constraints: NonNullable<AccessPolicyResource["writeConstraint"]>,
  beforeStatus: Encounter["status"] | undefined,
  afterStatus: Encounter["status"],
): boolean {
  const before = beforeStatus ? { resourceType: "Encounter" as const, status: beforeStatus } : undefined;
  const after: Encounter = { resourceType: "Encounter", status: afterStatus, class: { code: "AMB" } };

  return constraints.every((constraint) => {
    const result = fhirpath.evaluate(after, constraint.expression ?? "", {
      before: before ?? [],
      after,
    });
    return result.length === 1 && result[0] === true;
  });
}

function accessPolicyAllows(
  policy: AccessPolicy,
  resourceType: string,
  interaction: NonNullable<AccessPolicyResource["interaction"]>[number],
  criteria?: string,
): boolean {
  return policy.resource?.some(
    (rule) =>
      (rule.resourceType === resourceType || rule.resourceType === "*") &&
      rule.interaction?.includes(interaction) &&
      (criteria === undefined || rule.criteria === criteria),
  ) ?? false;
}
