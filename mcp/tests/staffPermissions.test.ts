import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStaffPermissionMember,
  handleStaffPermissionsList,
  handleStaffPermissionsMutation,
  type StaffPermissionMember,
  type StaffPermissionsDependencies,
} from "../src/desk/staff-permissions.js";
import { ODOS_PRACTICE_ROLE_SYSTEM } from "../src/authz/roles.js";
import { ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL } from "../src/authz/membership-business-actions.js";

const MEMBER: StaffPermissionMember = {
  membershipReference: "ProjectMembership/member-1",
  display: "Hannah Desk",
  roles: ["staff"],
  roleActions: ["chart.read", "claims.manage"],
  granted: ["payment.void"],
  revoked: ["claims.manage"],
  effective: ["chart.read", "payment.void"],
  ignoredGranted: [],
  ignoredRevoked: [],
  malformed: false,
  owner: false,
  toggleImmune: false,
};

function dependencies(overrides: Partial<StaffPermissionsDependencies> = {}): StaffPermissionsDependencies {
  return {
    authenticate: async () => ({
      staffReference: "Practitioner/owner",
      userReference: "User/owner",
      projectId: "p1",
      businessActions: ["identity.manage"],
    }),
    resolveProjectOwnerUserReference: async () => "User/owner",
    listMembers: async () => [MEMBER],
    updateMember: async () => MEMBER,
    ...overrides,
  };
}

test("staff permission routes require the identity.manage action and the actual project owner", async () => {
  let reads = 0;
  const nonOwner = await handleStaffPermissionsList(dependencies({
    authenticate: async () => ({
      staffReference: "Practitioner/admin",
      userReference: "User/admin",
      projectId: "p1",
      businessActions: ["identity.manage"],
    }),
    listMembers: async () => {
      reads += 1;
      return [MEMBER];
    },
  }), { authHeader: "Bearer admin" });
  assert.deepEqual(nonOwner, { status: 403, body: { error: "Practice owner access is required." } });
  assert.equal(reads, 0);

  const withoutAction = await handleStaffPermissionsList(dependencies({
    authenticate: async () => ({
      staffReference: "Practitioner/owner",
      userReference: "User/owner",
      projectId: "p1",
      businessActions: [],
    }),
  }), { authHeader: "Bearer owner" });
  assert.deepEqual(withoutAction, { status: 403, body: { error: "identity.manage action required." } });
});

test("owner list response exposes every action class and the server-derived member state", async () => {
  const result = await handleStaffPermissionsList(dependencies(), { authHeader: "Bearer owner" });

  assert.equal(result.status, 200);
  const body = result.body as { actions: Array<{ action: string; class: string }>; members: StaffPermissionMember[] };
  assert.deepEqual(body.members, [MEMBER]);
  assert.equal(body.actions.find((row) => row.action === "protocols.author")?.class, "credential-bound");
  assert.equal(body.actions.find((row) => row.action === "identity.manage")?.class, "owner-only");
  assert.equal(body.actions.find((row) => row.action === "payment.seal-day")?.class, "grantable");
});

test("owner mutation accepts only server business-action arrays and returns the updated member", async () => {
  const updates: unknown[] = [];
  const result = await handleStaffPermissionsMutation(dependencies({
    updateMember: async (_caller, membershipId, granted, revoked) => {
      updates.push({ membershipId, granted, revoked });
      return { ...MEMBER, granted: [...granted], revoked: [...revoked] };
    },
  }), {
    authHeader: "Bearer owner",
    membershipId: "member-1",
    body: { granted: ["payment.void"], revoked: ["claims.manage"] },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(updates, [{
    membershipId: "member-1",
    granted: ["payment.void"],
    revoked: ["claims.manage"],
  }]);
  assert.deepEqual((result.body as { member: StaffPermissionMember }).member.granted, ["payment.void"]);
});

test("member projection derives roles only from bound policy tags and surfaces ignored credential grants", () => {
  const member = buildStaffPermissionMember({
    membership: {
      resourceType: "ProjectMembership",
      id: "member-2",
      project: { reference: "Project/p1" },
      user: { reference: "User/u2" },
      profile: { reference: "Practitioner/pr2", display: "Taylor Tech" },
      access: [{ policy: { reference: "AccessPolicy/staff-policy" } }],
      extension: [{
        url: ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL,
        extension: [
          { url: "granted", valueCode: "clinical.sign" },
          { url: "revoked", valueCode: "claims.manage" },
        ],
      }],
    },
    policies: [{
      resourceType: "AccessPolicy",
      id: "staff-policy",
      meta: { tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "staff" }] },
    }],
    ownerUserReference: "User/owner",
  });

  assert.equal(member.display, "Taylor Tech");
  assert.deepEqual(member.roles, ["staff"]);
  assert.equal(member.roleActions.includes("claims.manage"), true);
  assert.equal(member.effective.includes("claims.manage"), false);
  assert.equal(member.effective.includes("clinical.sign"), false);
  assert.deepEqual(member.ignoredGranted, ["clinical.sign"]);
  assert.equal(member.toggleImmune, false);
});
