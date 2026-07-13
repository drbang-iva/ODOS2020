import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectMembership } from "@medplum/fhirtypes";
import { cleanupMembershipOperations } from "../../scripts/cleanup-practice-role-memberships.ts";

test("cleanup strips the service identity clinical trio while preserving one non-clinical policy", () => {
  const membership = fixture({
    access: [
      { policy: { reference: "AccessPolicy/desk" } },
      { policy: { reference: "AccessPolicy/admin" } },
      { policy: { reference: "AccessPolicy/clinical" } },
      { policy: { reference: "AccessPolicy/auditor" } },
      { policy: { reference: "AccessPolicy/auditor" } },
    ],
  });
  const operations = cleanupMembershipOperations({
    membership,
    policyRoles: new Map([
      ["AccessPolicy/desk", "front-desk"],
      ["AccessPolicy/admin", "practice-admin"],
      ["AccessPolicy/clinical", "clinician"],
      ["AccessPolicy/auditor", "auditor"],
    ]),
    stripRoles: new Set(["front-desk", "practice-admin", "clinician"]),
  });
  assert.deepEqual(operations, [{
    op: "replace",
    path: "/access",
    value: [{ policy: { reference: "AccessPolicy/auditor" } }],
  }]);
});

test("cleanup dedupes access and migrates the legacy field idempotently", () => {
  const membership = fixture({
    accessPolicy: { reference: "AccessPolicy/clinical" },
    access: [
      { policy: { reference: "AccessPolicy/clinical" } },
      { policy: { reference: "AccessPolicy/clinical" } },
    ],
  });
  const operations = cleanupMembershipOperations({ membership, policyRoles: new Map() });
  assert.deepEqual(operations, [
    {
      op: "replace",
      path: "/access",
      value: [{ policy: { reference: "AccessPolicy/clinical" } }],
    },
    { op: "remove", path: "/accessPolicy" },
  ]);
});

function fixture(overrides: Partial<ProjectMembership>): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id: "membership-1",
    meta: { versionId: "1" },
    project: { reference: "Project/p1" },
    user: { reference: "User/u1" },
    profile: { reference: "Practitioner/p1" },
    ...overrides,
  };
}
