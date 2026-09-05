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
  const rules = rulesFor("staff", "HealthcareService");
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
  const rules = rulesFor("staff", "DeviceDefinition");
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
    const rules = rulesFor("staff", resourceType);
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
  const rules = rulesFor("staff", "Appointment");
  assert.equal(rules.length, 2, "read and write rules stay separate");
  const rule = rules.find((candidate) => candidate.interaction?.includes("update"))!;
  assert.equal(rule.criteria, undefined, "Appointment must be practice-scoped for the day grid");
  for (const interaction of ["create", "update"]) {
    assert.ok(rule.interaction?.includes(interaction as never), `Appointment needs ${interaction}`);
  }
  assert.ok(!rule.interaction?.includes("delete"), "cancel is a status change, never a delete");
});

test("front-desk demographic/financial-context resources stay patient-compartment scoped (unchanged)", () => {
  for (const resourceType of ["Patient", "RelatedPerson", "Coverage", "Account", "Encounter"]) {
    const rules = rulesFor("staff", resourceType);
    assert.equal(rules.length, 2, `${resourceType} should have separate read and write rules`);
    const writeRule = rules.find((candidate) => candidate.interaction?.includes("update"));
    assert.equal(
      writeRule?.criteria,
      `${resourceType}?_compartment=%patient_compartment`,
      `${resourceType} keeps the compartment criteria`,
    );
  }
});

test("the scheduling.manage business action and the role↔policy meta.tag link are preserved", () => {
  const role = getRoleDeclaration("staff");
  assert.ok(role.businessActions.includes("scheduling.manage"));
  const policy = buildMedplumAccessPolicy(role);
  const tag = policy.meta?.tag?.find((candidate) => candidate.system === ODOS_PRACTICE_ROLE_SYSTEM);
  assert.equal(tag?.code, "staff");
});

test("Provider has practice-wide scheduling reads but no scheduling writes", () => {
  for (const resourceType of ["Appointment", "HealthcareService", "Schedule"]) {
    const rules = rulesFor("provider", resourceType);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.interaction?.includes("read"), true);
    assert.equal(rules[0]?.interaction?.includes("create"), false);
    assert.equal(rules[0]?.interaction?.includes("update"), false);
  }
});

test("front-desk Basic grants stay criteria-scoped to approved records and the practitioner tally", () => {
  const rules = rulesFor("staff", "Basic");
  const billingIdentityCriteria = BILLING_IDENTITY_CRITERIA;
  const writeTierCriteria = [
    "Basic?code=https://odos2020.com/fhir/CodeSystem/floor-config|odos-floor-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/insurance-config|odos-insurance-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-era-import|odos-era-import",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-manual-eob|odos-manual-eob",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/scheduling-config|odos-scheduling-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-dx-pick-tally|odos-dx-pick-tally&identifier=https://odos2020.com/fhir/NamingSystem/dx-pick-tally-practitioner|%profile",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-encounter-complaint|odos-encounter-complaint",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-section-group|odos-encounter-section-override",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/history-bulk-denial|history-bulk-denial-ledger",
    // The per-encounter Undo ledger: staff may clear, so staff writes the slot (2026-09-02).
    // This pin catches silent widening; the grant itself is proven on real Medplum by
    // encounterUndoLedgerAuthzLive.test.ts.
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-encounter-undo-ledger|odos-encounter-undo-ledger",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-plan-action-instance",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-application",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-charge-proposal",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-finding-instance",
  ];
  const readTierCriteria = [
    billingIdentityCriteria,
    "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/visit-type-config|odos-visit-type-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/statement-message-config|odos-statement-message-config",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-variant-settings",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/day-seal|day-seal",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/osod-complaint-definition|osod-complaint-definition",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-definition|odos-finding-definition",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-section-group|odos-finding-section-group",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-diagnosis-definition|odos-diagnosis-definition",
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-procedure-definition|odos-procedure-definition",
  ];
  const createOnceCriteria: string[] = [];
  assert.deepEqual(
    rules.map((rule) => rule.criteria).sort(),
    [...writeTierCriteria, ...writeTierCriteria, ...readTierCriteria, ...createOnceCriteria].sort(),
  );

  for (const criteria of writeTierCriteria) {
    const rule = rules.find((candidate) =>
      candidate.criteria === criteria && candidate.interaction?.includes("update"));
    assert.ok(rule, criteria);
    for (const interaction of ["create", "update"]) {
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

  const unitCriteria = "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit";
  const unitWrite = rules.find((candidate) =>
    candidate.criteria === unitCriteria && candidate.interaction?.includes("update"));
  assert.equal(unitWrite?.interaction?.includes("create"), true);
  assert.equal(unitWrite?.interaction?.includes("delete"), false);
  for (const kind of ["practice-frame-inventory", "practice-frame-variant-settings"]) {
    const inventoryCriteria = `Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|${kind}`;
    const inventoryRules = rules.filter((candidate) => candidate.criteria === inventoryCriteria);
    assert.equal(inventoryRules.some((candidate) => candidate.interaction?.includes("create")), false, kind);
    assert.equal(inventoryRules.some((candidate) => candidate.interaction?.includes("update")), false, kind);
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

test("clinician appearance access remains one read-only coded Basic grant", () => {
  const rules = rulesFor("provider", "Basic");
  const appearanceRules = rules.filter(
    (rule) =>
      rule.criteria ===
      "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config",
  );
  assert.equal(appearanceRules.length, 1);
  assert.equal(
    appearanceRules[0]?.criteria,
    "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config",
  );
  assert.deepEqual(appearanceRules[0]?.interaction, ["read", "search", "history", "vread"]);
});

test("every non-admin app role can read but never write the appearance singleton", () => {
  const criteria =
    "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config";
  for (const role of ["staff", "provider"] as const) {
    const rule = rulesFor(role, "Basic").find((candidate) => candidate.criteria === criteria);
    assert.ok(rule, role);
    assert.deepEqual(rule.interaction, ["read", "search", "history", "vread"]);
  }
});

test("no non-admin role can create or update the billing identity singleton", () => {
  for (const role of ["staff", "provider"] as const) {
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

test("Staff can read billing identity while Admin has an explicit criteria-fenced write rule", () => {
  const frontDeskRules = billingIdentityRulesFor("staff");
  assert.equal(frontDeskRules.length, 1);
  assert.equal(frontDeskRules[0]?.criteria, BILLING_IDENTITY_CRITERIA);
  assert.deepEqual(frontDeskRules[0]?.interaction, ["read", "search", "history", "vread"]);

  const adminRules = billingIdentityRulesFor("admin");
  assert.equal(adminRules.length, 2);
  const adminWrite = adminRules.find((rule) => rule.interaction?.includes("update"));
  assert.equal(adminWrite?.resourceType, "Basic");
  assert.equal(adminWrite?.criteria, BILLING_IDENTITY_CRITERIA);
  assert.deepEqual(adminWrite?.interaction, ["create", "update"]);
});
