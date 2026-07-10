import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicyResource } from "@medplum/fhirtypes";
import {
  OSOD_PRACTICE_ROLE_SYSTEM,
  buildMedplumAccessPolicy,
  getRoleDeclaration,
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

function rulesFor(roleId: "front-desk" | "clinician", resourceType: string): AccessPolicyResource[] {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
  return (policy.resource ?? []).filter((rule) => rule.resourceType === resourceType);
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
  const tag = policy.meta?.tag?.find((candidate) => candidate.system === OSOD_PRACTICE_ROLE_SYSTEM);
  assert.equal(tag?.code, "front-desk");
});

test("clinician gains no scheduling grants from this slice (regression guard)", () => {
  assert.equal(rulesFor("clinician", "Appointment").length, 0);
  assert.equal(rulesFor("clinician", "HealthcareService").length, 0);
  assert.equal(rulesFor("clinician", "Schedule").length, 0);
});

test("front-desk Basic grants stay criteria-scoped to scheduling config and ERA import records", () => {
  const rules = rulesFor("front-desk", "Basic");
  assert.deepEqual(
    rules.map((rule) => rule.criteria).sort(),
    [
      "Basic?code=https://osod.dev/fhir/CodeSystem/osod-era-import|osod-era-import",
      "Basic?code=https://osod.dev/fhir/CodeSystem/scheduling-config|osod-scheduling-config",
    ],
  );
  for (const rule of rules) {
    for (const interaction of ["create", "read", "update", "search"]) {
      assert.ok(rule.interaction?.includes(interaction as never), `Basic resource needs ${interaction}`);
    }
    assert.ok(!rule.interaction?.includes("delete"));
  }
});

test("clinician and auditor get no Basic grant (regression guard)", () => {
  assert.equal(rulesFor("clinician", "Basic").length, 0);
});
