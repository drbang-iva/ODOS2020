import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";

test("Clinic and Desk roles can exchange practice-scoped Office messages and acknowledgement events", () => {
  for (const roleId of ["clinician", "front-desk"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    for (const resourceType of ["Communication", "Provenance"]) {
      const rule = policy.resource?.find((candidate) => candidate.resourceType === resourceType && candidate.criteria === undefined);
      assert.ok(rule, `${roleId} needs practice-scoped ${resourceType}`);
      for (const interaction of ["create", "read", "search", "history", "vread"]) {
        assert.ok(rule.interaction?.includes(interaction as never), `${roleId} ${resourceType} needs ${interaction}`);
      }
      assert.equal(rule.interaction?.includes("update"), false);
      assert.equal(rule.interaction?.includes("delete"), false);
    }
    for (const resourceType of ["Practitioner", "PractitionerRole"]) {
      const directory = policy.resource?.find((candidate) => candidate.resourceType === resourceType && candidate.criteria === undefined);
      assert.deepEqual(directory?.interaction, ["read", "search", "history", "vread"]);
    }
  }
});

test("auditor does not gain Office Communication access or Provenance write access", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("auditor"));
  assert.equal(policy.resource?.some((rule) => rule.resourceType === "Communication"), false);
  const provenance = policy.resource?.find((rule) => rule.resourceType === "Provenance");
  assert.equal(provenance?.interaction?.includes("create"), false);
});
