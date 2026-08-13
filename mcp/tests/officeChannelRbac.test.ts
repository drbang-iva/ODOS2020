import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";

test("Clinic and Desk roles can exchange category-fenced Office messages and acknowledgement events", () => {
  for (const roleId of ["provider", "staff"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    const expectedCriteria = new Map([
      ["Communication", "Communication?category=https://odos2020.com/fhir/CodeSystem/communication-category|internal-office"],
      ["Provenance", "Provenance?_tag=https://odos2020.com/fhir/CodeSystem/office-message-kind|acknowledgement"],
    ]);
    for (const resourceType of ["Communication", "Provenance"]) {
      const rule = policy.resource?.find((candidate) => candidate.resourceType === resourceType && candidate.criteria === expectedCriteria.get(resourceType));
      assert.ok(rule, `${roleId} needs fenced ${resourceType}`);
      assert.deepEqual(rule.interaction, ["create"]);
      const readRule = policy.resource?.find((candidate) =>
        candidate.resourceType === resourceType && candidate.criteria === undefined);
      assert.deepEqual(readRule?.interaction, ["read", "search", "history", "vread"]);
      assert.equal(rule.interaction?.includes("update"), false);
      assert.equal(rule.interaction?.includes("delete"), false);
    }
    for (const resourceType of ["Practitioner", "PractitionerRole"]) {
      const directory = policy.resource?.find((candidate) => candidate.resourceType === resourceType && candidate.criteria === undefined);
      assert.deepEqual(directory?.interaction, ["read", "search", "history", "vread"]);
    }
  }
});

test("Admin retains the practice-admin Office Communication and acknowledgement grants", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  const communication = policy.resource?.find((rule) =>
    rule.resourceType === "Communication" && rule.criteria?.includes("internal-office"));
  const provenance = policy.resource?.find((rule) =>
    rule.resourceType === "Provenance" && rule.criteria?.includes("acknowledgement"));
  assert.equal(communication?.interaction?.includes("create"), true);
  assert.equal(provenance?.interaction?.includes("create"), true);
});
