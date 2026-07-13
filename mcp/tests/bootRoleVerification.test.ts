import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, Bundle } from "@medplum/fhirtypes";
import {
  formatPracticeRoleBootFailure,
  logPracticeRoleBootVerification,
  logSsePracticeRoleBootVerification,
  missingPracticeRolePolicies,
} from "../src/authz/boot-role-verification.js";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";

test("boot role verification names missing policies and missing practice-role tags", async () => {
  const client = {
    search: async <T,>(_resourceType: string, params: Record<string, string>): Promise<Bundle<T>> => {
      const name = params["name:exact"];
      if (name === "OSOD Front Desk") {
        return { resourceType: "Bundle", type: "searchset" } as Bundle<T>;
      }
      const role = name === "OSOD Clinician" ? "clinician"
        : name === "OSOD Practice Admin" ? "practice-admin"
          : name === "OSOD Auditor" ? "auditor"
            : "aesthetics-provider";
      const policy: AccessPolicy = role === "clinician"
        ? { resourceType: "AccessPolicy", name }
        : buildMedplumAccessPolicy(getRoleDeclaration(role));
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: policy as unknown as T }],
      } as Bundle<T>;
    },
  };
  const missing = await missingPracticeRolePolicies(client as never);
  assert.deepEqual(missing, [
    "clinician: AccessPolicy \"OSOD Clinician\" lacks its practice-role meta.tag",
    "front-desk: AccessPolicy \"OSOD Front Desk\" is missing",
  ]);
  const output = formatPracticeRoleBootFailure(missing);
  assert.match(output, /^\u001b\[31m\n/);
  assert.match(output, /OSOD PRACTICE ROLE BOOT VERIFICATION FAILED/);
  assert.match(output, /front-desk: AccessPolicy "OSOD Front Desk" is missing/);
});

test("boot role verification logs a red failure block without throwing when the service lookup fails", async () => {
  const messages: string[] = [];
  await logPracticeRoleBootVerification(
    { search: async () => { throw new Error("FHIR unavailable"); } } as never,
    (message) => messages.push(message),
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /verification unavailable: FHIR unavailable/);
  assert.match(messages[0]!, /server will continue/i);
});

test("SSE startup logs authentication failure in the red boot block and continues starting", async () => {
  const messages: string[] = [];
  let verifyCalled = false;
  let serverStarted = false;

  await logSsePracticeRoleBootVerification({
    authenticate: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8103"); },
    verify: async () => { verifyCalled = true; },
    log: (message) => messages.push(message),
  });
  serverStarted = true;

  assert.equal(serverStarted, true);
  assert.equal(verifyCalled, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^\u001b\[31m\n/);
  assert.match(messages[0]!, /verification unavailable: connect ECONNREFUSED 127\.0\.0\.1:8103/);
  assert.match(messages[0]!, /server will continue/i);
});
