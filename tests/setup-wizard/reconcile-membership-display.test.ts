import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ProjectMembership, Resource, User } from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../../mcp/src/fhir-client.ts";
import { reconcileMembershipDisplays } from "../../scripts/reconcile-membership-display.ts";

class FakeMembershipDisplayFhir {
  readonly memberships: ProjectMembership[];
  readonly users: User[];
  patchWrites = 0;

  constructor(input: { memberships: ProjectMembership[]; users: User[] }) {
    this.memberships = structuredClone(input.memberships);
    this.users = structuredClone(input.users);
  }

  async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    assert.equal(resourceType, "ProjectMembership");
    return bundle(this.memberships as T[]);
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    assert.equal(resourceType, "User");
    const user = this.users.find((candidate) => candidate.id === id);
    assert.ok(user, `Missing User/${id} fixture`);
    return structuredClone(user) as T;
  }

  async patch<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    operations: JsonPatchOperation[],
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    assert.equal(resourceType, "ProjectMembership");
    const membership = this.memberships.find((candidate) => candidate.id === id);
    assert.ok(membership);
    assert.equal(extraHeaders["If-Match"], `W/"${membership.meta?.versionId}"`);
    assert.deepEqual(operations, [{
      op: membership.user.display === undefined ? "add" : "replace",
      path: "/user/display",
      value: this.users.find((candidate) => candidate.id === membership.user.reference?.slice("User/".length))?.email,
    }]);
    membership.user.display = operations[0]!.value as string;
    membership.meta = {
      ...membership.meta,
      versionId: String(Number(membership.meta?.versionId) + 1),
    };
    this.patchWrites += 1;
    return structuredClone(membership) as T;
  }
}

test("reconciliation patches stale and missing displays from User.email and is idempotent", async () => {
  const fhir = new FakeMembershipDisplayFhir({
    memberships: [
      membership("stale", "1", "old@example.test"),
      membership("correct", "2", "current-2@example.test"),
      membership("missing", "3"),
    ],
    users: [
      user("stale", "current-1@example.test"),
      user("correct", "current-2@example.test"),
      user("missing", "current-3@example.test"),
    ],
  });

  const dryRun = await reconcileMembershipDisplays(fhir, false);
  assert.deepEqual(dryRun, {
    membershipsInspected: 3,
    userMembershipsInspected: 3,
    nonUserMembershipsSkipped: 0,
    correctionsNeeded: 2,
    corrected: 0,
  });
  assert.equal(fhir.patchWrites, 0);

  const applied = await reconcileMembershipDisplays(fhir, true);
  assert.deepEqual(applied, {
    membershipsInspected: 3,
    userMembershipsInspected: 3,
    nonUserMembershipsSkipped: 0,
    correctionsNeeded: 2,
    corrected: 2,
  });
  assert.deepEqual(fhir.memberships.map((candidate) => candidate.user.display), [
    "current-1@example.test",
    "current-2@example.test",
    "current-3@example.test",
  ]);

  const repeated = await reconcileMembershipDisplays(fhir, true);
  assert.deepEqual(repeated, {
    membershipsInspected: 3,
    userMembershipsInspected: 3,
    nonUserMembershipsSkipped: 0,
    correctionsNeeded: 0,
    corrected: 0,
  });
  assert.equal(fhir.patchWrites, 2);
});

test("reconciliation skips service memberships that reference a non-User principal", async () => {
  const servicePrincipalType = ["Client", "Application"].join("");
  const serviceMembership: ProjectMembership = {
    resourceType: "ProjectMembership",
    id: "membership-service",
    meta: { versionId: "1" },
    project: { reference: "Project/iris" },
    user: { reference: `${servicePrincipalType}/service-client`, display: "service-client" },
    profile: {},
  };
  const fhir = new FakeMembershipDisplayFhir({ memberships: [serviceMembership], users: [] });

  assert.deepEqual(await reconcileMembershipDisplays(fhir, true), {
    membershipsInspected: 1,
    userMembershipsInspected: 0,
    nonUserMembershipsSkipped: 1,
    correctionsNeeded: 0,
    corrected: 0,
  });
  assert.equal(fhir.patchWrites, 0);
});

test("reconciliation validates every planned correction before making the first write", async () => {
  const fhir = new FakeMembershipDisplayFhir({
    memberships: [
      membership("valid", "1", "old@example.test"),
      membership("unsafe", undefined, "old@example.test"),
    ],
    users: [
      user("valid", "current@example.test"),
      user("unsafe", "current@example.test"),
    ],
  });

  await assert.rejects(
    () => reconcileMembershipDisplays(fhir, true),
    /Every ProjectMembership must carry id and meta.versionId/,
  );
  assert.equal(fhir.patchWrites, 0);
});

test("reconciliation refuses to replace a display when canonical User.email is missing", async () => {
  const fhir = new FakeMembershipDisplayFhir({
    memberships: [membership("missing-email", "1", "old@example.test")],
    users: [{ resourceType: "User", id: "missing-email" }],
  });

  await assert.rejects(
    () => reconcileMembershipDisplays(fhir, true),
    /referenced User must carry a non-blank email/,
  );
  assert.equal(fhir.patchWrites, 0);
});

function membership(userId: string, versionId: string | undefined, display?: string): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id: `membership-${userId}`,
    meta: versionId ? { versionId } : undefined,
    project: { reference: "Project/iris" },
    user: { reference: `User/${userId}`, display },
    profile: { reference: `Practitioner/${userId}` },
  };
}

function user(id: string, email: string): User {
  return { resourceType: "User", id, email };
}

function bundle<T extends Resource>(resources: T[]): Bundle<T> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.map((resource) => ({ resource })),
  };
}
