import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, Bundle } from "@medplum/fhirtypes";
import {
  formatPracticeRoleBootFailure,
  logProtocolSeedBootFailure,
  logPracticeRoleBootVerification,
  logSsePracticeRoleBootVerification,
  missingPracticeRolePolicies,
  readPracticeRolePolicySyncStatus,
  readPracticeRolePolicySyncStatusReport,
} from "../src/authz/boot-role-verification.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  PRACTICE_ROLE_IDS,
} from "../src/authz/roles.js";

test("boot role verification names missing policies and missing practice-role tags", async () => {
  const client = {
    search: async <T,>(_resourceType: string, params: Record<string, string>): Promise<Bundle<T>> => {
      const name = params["name:exact"];
      if (name === "ODOS Staff") {
        return { resourceType: "Bundle", type: "searchset" } as Bundle<T>;
      }
      const role = name === "ODOS Admin / Manager" ? "admin" : "provider";
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
      if (role === "provider") policy.meta = undefined;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: policy as unknown as T }],
      } as Bundle<T>;
    },
  };
  const missing = await missingPracticeRolePolicies(client as never);
  assert.deepEqual(missing, [
    "provider: AccessPolicy \"ODOS Provider\" lacks its practice-role meta.tag",
    "staff: AccessPolicy \"ODOS Staff\" is missing",
  ]);
  const output = formatPracticeRoleBootFailure(missing);
  assert.match(output, /^\u001b\[31m\n/);
  assert.match(output, /ODOS PRACTICE ROLE BOOT VERIFICATION FAILED/);
  assert.match(output, /staff: AccessPolicy "ODOS Staff" is missing/);
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

test("server startup continues and logs loudly when the built-in protocol seed fails", async () => {
  const messages: string[] = [];
  let serverStarted = false;

  await logProtocolSeedBootFailure({
    seed: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8103"); },
    log: (message) => messages.push(message),
  });
  serverStarted = true;

  assert.equal(serverStarted, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^\u001b\[31m\n/);
  assert.match(messages[0]!, /ODOS PROTOCOL SEED FAILED/);
  assert.match(messages[0]!, /connect ECONNREFUSED 127\.0\.0\.1:8103/);
  assert.match(messages[0]!, /server will continue/i);
});

const CANONICAL_ADMIN_ACCESS_POLICY_INTERACTIONS = ["history", "read", "search", "vread"];

function deployedPolicies(
  adminAccessPolicyInteractions: readonly string[] = CANONICAL_ADMIN_ACCESS_POLICY_INTERACTIONS,
): AccessPolicy[] {
  return PRACTICE_ROLE_IDS.map((role) => {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
    policy.id = `${role}-policy`;
    if (role === "admin") {
      policy.resource = structuredClone(policy.resource);
      const index = policy.resource!.findIndex((rule) => rule.resourceType === "AccessPolicy");
      policy.resource![index] = {
        ...policy.resource![index],
        interaction: [...adminAccessPolicyInteractions] as AccessPolicy["resource"][number]["interaction"],
      };
    }
    return policy;
  });
}

test("canonical policy fixture reports every declared role in sync", async () => {
  const status = await readPracticeRolePolicySyncStatus(policySearchClient(deployedPolicies()) as never);
  assert.equal(status.inSync, true, JSON.stringify(status));
  assert.equal(status.policies.length, PRACTICE_ROLE_IDS.length);
  assert.ok(status.policies.every((policy) => policy.status === "match"));
});

function policySearchClient(policies: readonly AccessPolicy[], onWrite?: () => void) {
  return {
    search: async <T,>(_resourceType: string, params: Record<string, string>): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: policies
        .filter((policy) => policy.name === params["name:exact"])
        .map((resource) => ({ resource: resource as unknown as T })),
    } as Bundle<T>),
    create: async () => { onWrite?.(); throw new Error("unexpected create"); },
    patch: async () => { onWrite?.(); throw new Error("unexpected patch"); },
    update: async () => { onWrite?.(); throw new Error("unexpected update"); },
  };
}

test("read-only policy sync status names the policy and exact resource rule drift", async () => {
  let writes = 0;
  const status = await readPracticeRolePolicySyncStatus(
    policySearchClient(deployedPolicies(["read"]), () => { writes += 1; }) as never,
  );

  assert.equal(status.inSync, false);
  assert.equal(writes, 0);
  const admin = status.policies.find((policy) => policy.role === "admin");
  assert.equal(admin?.policyName, "ODOS Admin / Manager");
  assert.equal(admin?.status, "drift");
  assert.match(JSON.stringify(admin?.missingRules), /AccessPolicy/);
  assert.match(JSON.stringify(admin?.unexpectedRules), /interaction/);
});

test("policy sync status remains reachable and reports unavailable when its identity gets a 403", async () => {
  const report = await readPracticeRolePolicySyncStatusReport({
    search: async () => { throw new Error("FHIR search failed (403)"); },
  } as never);

  assert.deepEqual(report, {
    availability: "unavailable",
    inSync: null,
    error: "FHIR search failed (403)",
  });
});

test("boot warns with named resource rule drift and continues starting", async () => {
  const messages: string[] = [];
  let serverStarted = false;

  await logPracticeRoleBootVerification(
    policySearchClient(deployedPolicies(["read"])) as never,
    (message) => messages.push(message),
  );
  serverStarted = true;

  assert.equal(serverStarted, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /ODOS Admin \/ Manager/);
  assert.match(messages[0]!, /missing rule .*AccessPolicy/);
  assert.match(messages[0]!, /unexpected rule .*interaction/);
  assert.match(messages[0]!, /server will continue/i);
});
