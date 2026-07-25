import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicyResource } from "@medplum/fhirtypes";
import {
  ODOS_PRACTICE_ROLE_SYSTEM,
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  type PracticeRoleId,
} from "../src/authz/roles.js";

/**
 * Scheduler Phase 3a — front-desk scheduling grants (parallel kernel slice to PRs #24-#26).
 *
 * The day grid reads ALL resources' Schedules, the whole visit-type catalog, and every patient's
 * appointments for the day; booking writes Appointments for arbitrary patients. Patient-compartment
 * scope is the wrong shape for that (Schedule/Slot/HealthcareService are not Patient-compartment
 * resources at all), so scheduling resources move to practice scope — mirroring the v0.6c
 * dispensary practice-scope precedent (decision 2026-07-05 §2).
 */

function rulesFor(roleId: PracticeRoleId, resourceType: string): AccessPolicyResource[] {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
  return (policy.resource ?? []).filter((rule) => rule.resourceType === resourceType);
}

const BILLING_IDENTITY_CRITERIA =
  "Basic?code=https://odos2020.com/fhir/CodeSystem/billing-identity-config|odos-billing-identity-config";

function billingIdentityRulesFor(roleId: PracticeRoleId): AccessPolicyResource[] {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
  return (policy.resource ?? []).filter((rule) =>
    rule.resourceType === "*" ||
    (rule.resourceType === "Basic" &&
      (rule.criteria === undefined || rule.criteria === BILLING_IDENTITY_CRITERIA))
  );
}

test("front-desk reads the visit-type catalog (HealthcareService) at practice scope", () => {
  const rules = rulesFor("front-desk", "HealthcareService");
  assert.equal(rules.length, 1);
  const rule = rules[0]!;
  assert.equal(rule.criteria, undefined);
  assert.ok(rule.interaction?.includes("read"));
  assert.ok(rule.interaction?.includes("search"));
  assert.ok(!rule.interaction?.includes("create"));
  assert.ok(!rule.interaction?.includes("update"));
  assert.ok(!rule.interaction?.includes("delete"));
});

test("front-desk reads the frame catalog but cannot manage DeviceDefinition", () => {
  const rules = rulesFor("front-desk", "DeviceDefinition");
  assert.equal(rules.length, 1);
  const rule = rules[0]!;
  assert.equal(rule.criteria, undefined);
  assert.deepEqual(rule.interaction, ["read", "search", "history", "vread"]);
  assert.ok(!rule.interaction?.includes("create"));
  assert.ok(!rule.interaction?.includes("update"));
  assert.ok(!rule.interaction?.includes("delete"));
});

test("front-desk reads Schedule and Slot (the resource columns + availability) at practice scope", () => {
  for (const resourceType of ["Schedule", "Slot"]) {
    const rules = rulesFor("front-desk", resourceType);
    assert.equal(rules.length, 1, `${resourceType} should have exactly one rule`);
    const rule = rules[0]!;
    assert.equal(rule.criteria, undefined, `${resourceType} must not be compartment-scoped`);
    assert.ok(rule.interaction?.includes("read"));
    assert.ok(rule.interaction?.includes("search"));
    assert.ok(!rule.interaction?.includes("create"), `${resourceType} is admin-managed, not desk-writable`);
    assert.ok(!rule.interaction?.includes("delete"));
  }
});

test("front-desk books/edits Appointments for the whole practice day (create/read/update, no delete)", () => {
  const rules = rulesFor("front-desk", "Appointment");
  assert.equal(rules.length, 1, "exactly one Appointment rule — no leftover compartment rule");
  const rule = rules[0]!;
  assert.equal(rule.criteria, undefined, "Appointment must be practice-scoped for the day grid");
  for (const interaction of ["create", "read", "update", "search"]) {
    assert.ok(rule.interaction?.includes(interaction as never), `Appointment needs ${interaction}`);
  }
  assert.ok(!rule.interaction?.includes("delete"), "cancel is a status change, never a delete");
});

test("front-desk demographic/financial-context resources stay patient-compartment scoped (unchanged)", () => {
  for (const resourceType of ["Patient", "RelatedPerson", "Coverage", "Account", "Encounter"]) {
    const rules = rulesFor("front-desk", resourceType);
    assert.equal(rules.length, 1, `${resourceType} should have exactly one rule`);
    assert.equal(
      rules[0]!.criteria,
      `${resourceType}?_compartment=%patient_compartment`,
      `${resourceType} keeps the compartment criteria`,
    );
  }
});

test("the scheduling.manage business action and the role↔policy meta.tag link are preserved", () => {
  const role = getRoleDeclaration("front-desk");
  assert.ok(role.businessActions.includes("scheduling.manage"));
  const policy = buildMedplumAccessPolicy(role);
  const tag = policy.meta?.tag?.find((candidate) => candidate.system === ODOS_PRACTICE_ROLE_SYSTEM);
  assert.equal(tag?.code, "front-desk");
});

test("clinician gains no scheduling grants from this slice (regression guard)", () => {
  assert.equal(rulesFor("clinician", "Appointment").length, 0);
  assert.equal(rulesFor("clinician", "HealthcareService").length, 0);
  assert.equal(rulesFor("clinician", "Schedule").length, 0);
});

test("front-desk Basic grants stay criteria-scoped to approved inventory, config, and billing records", () => {
  const rules = rulesFor("front-desk", "Basic");
  const billingIdentityCriteria = BILLING_IDENTITY_CRITERIA;
  const writeTierCriteria = [
    "Basic?code=https://odos2020.com/fhir/CodeSystem/floor-config|odos-floor-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/insurance-config|odos-insurance-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-era-import|odos-era-import",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-manual-eob|odos-manual-eob",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-variant-settings",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/scheduling-config|odos-scheduling-config",
  ];
  const readTierCriteria = [
    billingIdentityCriteria,
    "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/visit-type-config|odos-visit-type-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/statement-message-config|odos-statement-message-config",
  ];
  const createOnceCriteria = [
    "Basic?code=https://odos2020.com/fhir/CodeSystem/day-seal|day-seal",
  ];
  assert.deepEqual(
    rules.map((rule) => rule.criteria).sort(),
    [...writeTierCriteria, ...readTierCriteria, ...createOnceCriteria].sort(),
  );

  for (const criteria of writeTierCriteria) {
    const rule = rules.find((candidate) => candidate.criteria === criteria);
    assert.ok(rule, criteria);
    for (const interaction of ["create", "read", "update", "search"]) {
      assert.ok(rule.interaction?.includes(interaction as never), `Basic resource needs ${interaction}`);
    }
    assert.ok(!rule.interaction?.includes("delete"));
  }

  for (const criteria of readTierCriteria) {
    const rule = rules.find((candidate) => candidate.criteria === criteria);
    assert.ok(rule, criteria);
    assert.ok(rule.interaction?.includes("read"));
    assert.ok(rule.interaction?.includes("search"));
    assert.ok(!rule.interaction?.includes("create"));
    assert.ok(!rule.interaction?.includes("update"));
    assert.ok(!rule.interaction?.includes("delete"));
  }

  for (const criteria of createOnceCriteria) {
    const rule = rules.find((candidate) => candidate.criteria === criteria);
    assert.ok(rule, criteria);
    for (const interaction of ["create", "read", "search"]) {
      assert.ok(rule.interaction?.includes(interaction as never), `DaySeal Basic needs ${interaction}`);
    }
    assert.ok(!rule.interaction?.includes("update"));
    assert.ok(!rule.interaction?.includes("delete"));
  }

  for (const kind of [
    "practice-frame-inventory",
    "practice-frame-inventory-unit",
    "practice-frame-variant-settings",
  ]) {
    const inventoryCriteria =
      `Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|${kind}`;
    const inventoryRule = rules.find((candidate) => candidate.criteria === inventoryCriteria);
    assert.ok(inventoryRule?.interaction?.includes("create"), kind);
    assert.ok(inventoryRule?.interaction?.includes("read"), kind);
    assert.ok(inventoryRule?.interaction?.includes("update"), kind);
    assert.ok(inventoryRule?.interaction?.includes("search"), kind);
    assert.ok(!inventoryRule?.interaction?.includes("delete"), kind);
  }
  assert.equal(
    rules.some(
      (candidate) =>
        candidate.criteria === undefined ||
        candidate.criteria ===
          "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|frames-data-subscription",
    ),
    false,
    "no blanket Basic or frames-data-subscription grant may bypass the inventory criteria fence",
  );
});

test("clinician gets only the read-only practice appearance Basic grant", () => {
  const rules = rulesFor("clinician", "Basic");
  assert.equal(rules.length, 1);
  assert.equal(
    rules[0]?.criteria,
    "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config",
  );
  assert.deepEqual(rules[0]?.interaction, ["read", "search", "history", "vread"]);
});

test("every non-admin app role can read but never write the appearance singleton", () => {
  const criteria =
    "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config";
  for (const role of ["front-desk", "clinician", "auditor", "aesthetics-provider"] as const) {
    const rule = rulesFor(role, "Basic").find((candidate) => candidate.criteria === criteria);
    assert.ok(rule, role);
    assert.deepEqual(rule.interaction, ["read", "search", "history", "vread"]);
  }
});

test("no non-admin role can create or update the billing identity singleton", () => {
  for (const role of ["front-desk", "clinician", "auditor", "aesthetics-provider"] as const) {
    const rules = billingIdentityRulesFor(role);
    for (const interaction of ["create", "update"] as const) {
      assert.equal(
        rules.some((rule) => rule.interaction?.includes(interaction)),
        false,
        `${role} must not receive ${interaction} access to billing identity`,
      );
    }
  }
});

test("front-desk can read billing identity while practice-admin can write it through the wildcard", () => {
  const frontDeskRules = billingIdentityRulesFor("front-desk");
  assert.equal(frontDeskRules.length, 1);
  assert.equal(frontDeskRules[0]?.criteria, BILLING_IDENTITY_CRITERIA);
  assert.deepEqual(frontDeskRules[0]?.interaction, ["read", "search", "history", "vread"]);

  const adminRules = billingIdentityRulesFor("practice-admin");
  assert.equal(adminRules.length, 1);
  assert.equal(adminRules[0]?.resourceType, "*");
  assert.equal(adminRules[0]?.criteria, undefined);
  assert.deepEqual(adminRules[0]?.interaction, [
    "create",
    "read",
    "update",
    "delete",
    "search",
    "history",
    "vread",
  ]);
});
