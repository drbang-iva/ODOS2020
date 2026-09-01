import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASELINE_BUSINESS_ACTIONS,
  businessActionClass,
  effectiveBusinessActions,
  resolveBusinessActionRole,
  staffHasBusinessAction,
} from "../src/authz/roles.js";
import {
  ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL,
  readMembershipBusinessActionDeltas,
} from "../src/authz/membership-business-actions.js";

test("person-level OFF removes a role-level action while baseline remains revoke-immune", () => {
  const result = effectiveBusinessActions(
    ["admin"],
    [],
    ["payment.void", "chart.read"],
  );

  assert.equal(result.actions.includes("payment.void"), false);
  assert.equal(result.actions.includes("chart.read"), true);
  assert.deepEqual(result.ignoredRevoked, ["chart.read"]);
});

test("a credential-bound grant is ignored instead of making Staff a clinician", () => {
  const result = effectiveBusinessActions(["staff"], ["clinical.sign"], []);

  assert.equal(result.actions.includes("clinical.sign"), false);
  assert.deepEqual(result.ignoredGranted, ["clinical.sign"]);
});

test("malformed person-level data falls back to the plain role union and never widens it", () => {
  const result = effectiveBusinessActions(
    ["staff"],
    ["payment.void", "not-an-action"],
    ["chart.write"],
  );

  assert.equal(result.malformed, true);
  assert.equal(result.actions.includes("payment.void"), false);
  assert.equal(result.actions.includes("chart.write"), true);
});

test("the baseline is the explicit eight-action intersection of the three role declarations", () => {
  assert.deepEqual(BASELINE_BUSINESS_ACTIONS, [
    "chart.read",
    "patients.register",
    "billing-context.read",
    "document.fax-send",
    "communications.read",
    "communications.content.read",
    "communications.send",
    "communications.call",
  ]);
});

test("ProjectMembership action deltas use one ODOS extension with repeated granted and revoked codes", () => {
  const parsed = readMembershipBusinessActionDeltas({
    resourceType: "ProjectMembership",
    project: { reference: "Project/p1" },
    user: { reference: "User/u1" },
    profile: { reference: "Practitioner/pr1" },
    extension: [{
      url: ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL,
      extension: [
        { url: "granted", valueCode: "payment.void" },
        { url: "granted", valueCode: "margin.read" },
        { url: "revoked", valueCode: "chart.write" },
      ],
    }],
  });

  assert.deepEqual(parsed, {
    granted: ["payment.void", "margin.read"],
    revoked: ["chart.write"],
    malformed: false,
  });
});

test("a missing ProjectMembership action extension is a valid empty delta", () => {
  const parsed = readMembershipBusinessActionDeltas({
    resourceType: "ProjectMembership",
    project: { reference: "Project/p1" },
    user: { reference: "User/u1" },
    profile: { reference: "Practitioner/pr1" },
  });

  assert.deepEqual(parsed, { granted: [], revoked: [], malformed: false });
});

test("malformed ProjectMembership action extension data is marked and supplies no deltas", () => {
  const parsed = readMembershipBusinessActionDeltas({
    resourceType: "ProjectMembership",
    project: { reference: "Project/p1" },
    user: { reference: "User/u1" },
    profile: { reference: "Practitioner/pr1" },
    extension: [{
      url: ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL,
      extension: [{ url: "granted", valueString: "payment.void" }],
    }],
  });

  assert.deepEqual(parsed, { granted: [], revoked: [], malformed: true });
});

test("overlapping granted and revoked membership actions are malformed instead of applying an ambiguous delta", () => {
  const parsed = readMembershipBusinessActionDeltas({
    resourceType: "ProjectMembership",
    project: { reference: "Project/p1" },
    user: { reference: "User/u1" },
    profile: { reference: "Practitioner/pr1" },
    extension: [{
      url: ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL,
      extension: [
        { url: "granted", valueCode: "payment.void" },
        { url: "revoked", valueCode: "payment.void" },
      ],
    }],
  });

  assert.deepEqual(parsed, { granted: [], revoked: [], malformed: true });
});

test("business-action role resolution honors granted and revoked person-level actions", () => {
  assert.equal(
    resolveBusinessActionRole(["staff"], "payment.void", ["payment.void"]),
    "staff",
  );
  assert.equal(
    resolveBusinessActionRole(["admin"], "payment.void", []),
    undefined,
  );
});

test("operator-ruling action classes keep protocols credential-bound, identity owner-only, and day seal grantable", () => {
  assert.equal(businessActionClass("protocols.author"), "credential-bound");
  assert.equal(businessActionClass("identity.manage"), "owner-only");
  assert.equal(businessActionClass("payment.seal-day"), "grantable");
});

test("staff action checks prefer authenticated effective actions over the static actor role", () => {
  const staff = {
    actorRole: "admin" as const,
    roles: ["admin"] as const,
    businessActions: ["chart.read"] as const,
  };
  assert.equal(staffHasBusinessAction(staff, "chart.read"), true);
  assert.equal(staffHasBusinessAction(staff, "payment.void"), false);
});
