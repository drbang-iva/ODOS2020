import assert from "node:assert/strict";
import { test } from "node:test";
import type { Practitioner, ProjectMembership, Resource, User } from "@medplum/fhirtypes";
import { cleanupMembershipOperations, resolveMembershipTargetEmail } from "../../scripts/cleanup-practice-role-memberships.ts";

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

test("cleanup preserves a parameterized-only grant without creating an unrestricted binding", () => {
  const membership = fixture({
    access: [{
      policy: { reference: "AccessPolicy/clinical" },
      parameter: [
        { name: "provider_profile", valueReference: { reference: "Practitioner/p1" } },
        { name: "patient_compartment", valueString: "Patient/patient-1" },
      ],
    }],
  });

  assert.deepEqual(cleanupMembershipOperations({ membership, policyRoles: new Map() }), []);
});

test("cleanup prefers canonical User.email over Practitioner telecom and stale display", async () => {
  const user: User = { resourceType: "User", id: "u1", email: "current@example.test" };
  const email = await resolveMembershipTargetEmail({
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      assert.equal(resourceType, "User");
      assert.equal(id, "u1");
      return user as T;
    },
  }, fixture({ user: { reference: "User/u1", display: "old@example.test" } }));
  assert.equal(email, "current@example.test");
});

test("cleanup uses Practitioner telecom when canonical User.email is absent", async () => {
  const user: User = { resourceType: "User", id: "u1" };
  const practitioner: Practitioner = {
    resourceType: "Practitioner",
    id: "service-profile",
    telecom: [{ system: "email", value: "practitioner@example.test" }],
  };
  const email = await resolveMembershipTargetEmail({
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      if (resourceType === "User") return user as T;
      assert.equal(resourceType, "Practitioner");
      assert.equal(id, "service-profile");
      return practitioner as T;
    },
  }, fixture({ profile: { reference: "Practitioner/service-profile" }, user: { reference: "User/u1", display: "old@example.test" } }));
  assert.equal(email, "practitioner@example.test");
});

test("cleanup uses membership display only when no Practitioner lookup is available", async () => {
  const user: User = { resourceType: "User", id: "u1" };
  const email = await resolveMembershipTargetEmail({
    read: async <T extends Resource>(resourceType: T["resourceType"]): Promise<T> => {
      assert.equal(resourceType, "User");
      return user as T;
    },
  }, fixture({ profile: {}, user: { reference: "User/u1", display: "fallback@example.test" } }));
  assert.equal(email, "fallback@example.test");
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
