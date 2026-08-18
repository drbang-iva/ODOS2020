import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findOperatorMembershipRecord,
  verifyOperatorMembershipRecord,
  type OperatorMembershipDatabase,
} from "../src/authz/operatorMembershipVerification.js";

const BASE_ROW = {
  id: "membership-1",
  project: "Project/practice-1",
  user: "ClientApplication/operator-client",
  profile: "ClientApplication/operator-client",
  admin: null,
  accessPolicy: null,
  content: JSON.stringify({
    resourceType: "ProjectMembership",
    id: "membership-1",
    project: { reference: "Project/practice-1" },
    user: { reference: "ClientApplication/operator-client" },
    profile: { reference: "ClientApplication/operator-client" },
  }),
};

test("local membership resolution returns the one active membership for an exact project and client", async () => {
  const database = fakeDatabase([BASE_ROW]);
  assert.equal(
    await findOperatorMembershipRecord({ database, projectId: "practice-1", clientId: "operator-client" }),
    "membership-1",
  );
  assert.deepEqual(database.calls[0]!.values, ["practice-1", "ClientApplication/operator-client"]);
});

test("local membership resolution rejects missing and duplicate active rows", async () => {
  for (const rows of [[], [BASE_ROW, { ...BASE_ROW, id: "membership-2" }]]) {
    await assert.rejects(
      findOperatorMembershipRecord({ database: fakeDatabase(rows), projectId: "practice-1", clientId: "operator-client" }),
      /exactly one active row/i,
    );
  }
});

test("local membership verification accepts one exact non-admin policy-free operator row", async () => {
  const database = fakeDatabase([BASE_ROW]);
  await verifyOperatorMembershipRecord({
    database,
    projectId: "practice-1",
    clientId: "operator-client",
    membershipId: "membership-1",
  });
  assert.equal(database.calls.length, 1);
  assert.doesNotMatch(database.calls[0]!.sql, /secret|password|token/i);
});

test("local membership verification rejects admin, access, policy, and identity drift", async () => {
  for (const row of [
    { ...BASE_ROW, admin: true },
    { ...BASE_ROW, accessPolicy: ["AccessPolicy/policy-1"] },
    { ...BASE_ROW, content: JSON.stringify({ ...JSON.parse(BASE_ROW.content), access: [{}] }) },
    { ...BASE_ROW, profile: "ClientApplication/other-client" },
  ]) {
    await assert.rejects(
      verifyOperatorMembershipRecord({
        database: fakeDatabase([row]),
        projectId: "practice-1",
        clientId: "operator-client",
        membershipId: "membership-1",
      }),
      /exact non-admin client and project|no access entries and no attached access policy/i,
    );
  }
});

function fakeDatabase(rows: unknown[]): OperatorMembershipDatabase & { calls: Array<{ sql: string; values: unknown[] }> } {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    query: async (sql, values) => {
      calls.push({ sql, values: [...values] });
      return { rows };
    },
  };
}
