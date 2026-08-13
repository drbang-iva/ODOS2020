import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectMembership } from "@medplum/fhirtypes";
import {
  handleStaffInviteRequest,
  parseStaffInviteInput,
  type StaffInviteDeps,
} from "../src/desk/staff-invite.js";

const membership: ProjectMembership = {
  resourceType: "ProjectMembership",
  id: "membership-1",
  meta: { versionId: "1" },
  project: { reference: "Project/practice" },
  user: { reference: "User/invitee" },
  profile: { reference: "Practitioner/invitee" },
};
const body = { email: "New.Staff@example.test", firstName: "New", lastName: "Staff", roleId: "front-desk" };

test("staff invite preserves 401 unauthenticated and 403 wrong-role semantics", async () => {
  assert.equal((await handleStaffInviteRequest(deps({ authenticate: async () => null }), { authHeader: undefined, body })).status, 401);
  assert.equal((await handleStaffInviteRequest(deps({ authenticate: async () => staff("clinician") }), { authHeader: "Bearer user", body })).status, 403);
});

test("staff invite validates roleId and rejects caller-supplied policy references", () => {
  assert.match((parseStaffInviteInput({ ...body, roleId: "owner" }) as { error: string }).error, /roleId must be one of/);
  assert.match((parseStaffInviteInput({ ...body, accessPolicy: { reference: "AccessPolicy/admin" } }) as { error: string }).error, /Caller-supplied policy/);
  assert.match((parseStaffInviteInput({ ...body, membership: { access: [] } }) as { error: string }).error, /Caller-supplied policy/);
});

test("existing membership maps the Medplum conflict to 409 naming the account", async () => {
  const result = await handleStaffInviteRequest(deps({
    invite: async () => { throw Object.assign(new Error("conflict"), { status: 409 }); },
  }), { authHeader: "Bearer admin", body });
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /new\.staff@example\.test/i);
});

test("invite response membership is granted directly and exactly one staff.invite audit is recorded", async () => {
  const calls: string[] = [];
  let grantedMembership: ProjectMembership | undefined;
  const audits: unknown[] = [];
  const result = await handleStaffInviteRequest(deps({
    invite: async () => { calls.push("invite"); return membership; },
    grantRole: async (received, email, roleId) => {
      calls.push("grant");
      grantedMembership = received;
      assert.equal(email, "new.staff@example.test");
      assert.equal(roleId, "front-desk");
    },
    recordAudit: async (row) => { calls.push("audit"); audits.push(row); },
  }), { authHeader: "Bearer admin", body });
  assert.equal(result.status, 201);
  assert.equal(grantedMembership, membership);
  assert.deepEqual(calls, ["invite", "grant", "audit"]);
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as { eventType: string }).eventType, "staff.invite");
});

test("grant failure returns the explicit invited-without-role half-state and repair command", async () => {
  let audits = 0;
  const grantError = new Error("policy unavailable");
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  let result;
  try {
    result = await handleStaffInviteRequest(deps({
      grantRole: async () => { throw grantError; },
      recordAudit: async () => { audits += 1; },
    }), { authHeader: "Bearer admin", body });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.status, 500);
  assert.match(String(result.body.error), /invited-without-role half-state/);
  assert.match(String(result.body.error), /npm run repair-practice-roles -- --email new\.staff@example\.test/);
  assert.deepEqual(logged, [["odos-mcp: staff invite role grant failed:", grantError]]);
  assert.equal(audits, 0);
});

function deps(overrides: Partial<StaffInviteDeps> = {}): StaffInviteDeps {
  return {
    authenticateService: async () => undefined,
    authenticate: async () => staff("practice-admin"),
    invite: async () => membership,
    grantRole: async () => undefined,
    recordAudit: async () => undefined,
    ...overrides,
  };
}

function staff(role: "practice-admin" | "clinician") {
  return { staffReference: "Practitioner/admin", roles: [role] };
}
