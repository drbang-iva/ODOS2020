import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AccessPolicy } from "@medplum/fhirtypes";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../../mcp/src/authz/roles.js";
import type { JsonPatchOperation, MedplumClient } from "../../mcp/src/fhir-client.js";
import {
  LivePracticeRolePolicyRuleSyncAdapter,
  formatPracticeRolePolicyRuleSync,
  requiredPracticeRolePolicyRuleSyncProjectId,
  resolvePracticeRolePolicyRuleSyncCredentials,
  syncPracticeRolePolicyRules,
  type PracticeRolePolicyRuleSyncAdapter,
} from "../../scripts/sync-practice-role-policy-rules.js";

const PROJECT_ID = "practice-1";

class FakePolicyRuleSyncAdapter implements PracticeRolePolicyRuleSyncAdapter {
  readonly policies: AccessPolicy[];
  readonly events: string[];
  readonly patchRequests: {
    id: string;
    operations: JsonPatchOperation[];
    versionId: string;
  }[] = [];
  stalePolicyId?: string;

  constructor(policies = canonicalPolicies(), events: string[] = []) {
    this.policies = structuredClone(policies);
    this.events = events;
  }

  async readPolicies(projectId: string): Promise<AccessPolicy[]> {
    assert.equal(projectId, PROJECT_ID);
    this.events.push("read");
    return structuredClone(this.policies);
  }

  async patchPolicy(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<AccessPolicy> {
    this.events.push(`patch:${id}`);
    this.patchRequests.push({ id, operations: structuredClone(operations), versionId });
    const policy = this.policies.find((candidate) => candidate.id === id);
    assert.ok(policy);
    if (id === this.stalePolicyId || policy.meta?.versionId !== versionId) {
      throw new Error(`AccessPolicy/${id} update failed: 412 Precondition Failed`);
    }
    applyPatch(policy, operations);
    policy.meta = { ...policy.meta, versionId: String(Number(versionId) + 1) };
    return structuredClone(policy);
  }
}

test("dry-run reports literal missing and unexpected canonicalized rules without writing", async () => {
  const policies = canonicalPolicies();
  const admin = policies.find((policy) => hasRole(policy, "admin"));
  assert.ok(admin);
  const healthcareWrite = admin.resource?.find((rule) =>
    rule.resourceType === "HealthcareService" && rule.interaction?.includes("create")
  );
  assert.ok(healthcareWrite);
  healthcareWrite.interaction = ["update"];
  const events: string[] = [];
  const adapter = new FakePolicyRuleSyncAdapter(policies, events);

  const result = await syncPracticeRolePolicyRules(adapter, {
    projectId: PROJECT_ID,
    assertProjectScope: async () => { events.push("guard"); },
  });

  assert.deepEqual(events, ["guard", "read"]);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.policiesUpdated, 0);
  assert.deepEqual(result.policies.map(({ role, status }) => ({ role, status })), [
    { role: "provider", status: "match" },
    { role: "staff", status: "match" },
    { role: "admin", status: "drift" },
  ]);
  assert.deepEqual(result.policies[2]?.missingRules, [{
    interaction: ["create", "update"],
    resourceType: "HealthcareService",
  }]);
  assert.deepEqual(result.policies[2]?.unexpectedRules, [{
    interaction: ["update"],
    resourceType: "HealthcareService",
  }]);
  assert.equal(adapter.patchRequests.length, 0);
  const report = formatPracticeRolePolicyRuleSync(result);
  assert.match(report, /provider: MATCH AccessPolicy\/provider-policy/);
  assert.match(report, /admin: DRIFT AccessPolicy\/admin-policy/);
  assert.match(report, /missing .*HealthcareService/);
  assert.match(report, /unexpected .*HealthcareService/);
  assert.match(report, /Dry run only.*--apply/);
});

test("apply patches only resource, preserves all other fields, and converges on rerun", async () => {
  const policies = canonicalPolicies();
  const admin = policies.find((policy) => hasRole(policy, "admin"));
  assert.ok(admin);
  admin.name = "Practice-owned admin label";
  admin.extension = [{ url: "https://example.test/extension", valueString: "preserve-me" }];
  admin.resource = admin.resource?.filter((rule) => rule.resourceType !== "AuditEvent");
  const original = structuredClone(admin);
  const adapter = new FakePolicyRuleSyncAdapter(policies);
  const guard = async (): Promise<void> => {};

  const first = await syncPracticeRolePolicyRules(adapter, {
    projectId: PROJECT_ID,
    apply: true,
    assertProjectScope: guard,
  });

  assert.equal(first.policiesUpdated, 1);
  assert.equal(adapter.patchRequests.length, 1);
  const updated = adapter.policies.find((policy) => policy.id === "admin-policy");
  assert.ok(updated);
  assert.equal(updated.id, original.id);
  assert.equal(updated.name, original.name);
  assert.deepEqual(updated.meta?.tag, original.meta?.tag);
  assert.deepEqual(updated.meta?.security, original.meta?.security);
  assert.equal(updated.meta?.project, original.meta?.project);
  assert.deepEqual(updated.extension, original.extension);
  assert.deepEqual(adapter.patchRequests[0], {
    id: "admin-policy",
    operations: [{
      op: "replace",
      path: "/resource",
      value: buildMedplumAccessPolicy(getRoleDeclaration("admin")).resource,
    }],
    versionId: "7",
  });

  const second = await syncPracticeRolePolicyRules(adapter, {
    projectId: PROJECT_ID,
    apply: true,
    assertProjectScope: guard,
  });
  assert.equal(second.policiesUpdated, 0);
  assert.equal(adapter.patchRequests.length, 1);
  assert.ok(second.policies.every((policy) => policy.status === "match"));
});

test("sync refuses missing, duplicate, versionless, or ambiguously tagged policies before writing", async () => {
  const cases: { label: string; policies: AccessPolicy[]; pattern: RegExp }[] = [
    {
      label: "missing",
      policies: canonicalPolicies().filter((policy) => !hasRole(policy, "staff")),
      pattern: /Expected exactly one tagged staff AccessPolicy; found 0/,
    },
    {
      label: "duplicate",
      policies: [...canonicalPolicies(), canonicalPolicy("staff", "staff-duplicate")],
      pattern: /Expected exactly one tagged staff AccessPolicy; found 2/,
    },
    {
      label: "versionless",
      policies: canonicalPolicies().map((policy) => hasRole(policy, "provider")
        ? { ...policy, meta: { ...policy.meta, versionId: undefined } }
        : policy),
      pattern: /AccessPolicy\/provider-policy is missing meta.versionId/,
    },
    {
      label: "one policy tagged as two canonical roles",
      policies: canonicalPolicies()
        .filter((policy) => !hasRole(policy, "staff"))
        .map((policy) => hasRole(policy, "provider")
          ? {
              ...policy,
              meta: {
                ...policy.meta,
                tag: [
                  ...(policy.meta?.tag ?? []),
                  { system: ODOS_PRACTICE_ROLE_SYSTEM, code: "staff" },
                ],
              },
            }
          : policy),
      pattern: /AccessPolicy\/provider-policy has ambiguous practice-role tags: provider, staff/,
    },
  ];

  for (const { label, policies, pattern } of cases) {
    const adapter = new FakePolicyRuleSyncAdapter(policies);
    await assert.rejects(
      syncPracticeRolePolicyRules(adapter, {
        projectId: PROJECT_ID,
        apply: true,
        assertProjectScope: async () => {},
      }),
      pattern,
      label,
    );
    assert.equal(adapter.patchRequests.length, 0, label);
  }
});

test("a project mismatch refuses before policy reads or writes", async () => {
  const events: string[] = [];
  const adapter = new FakePolicyRuleSyncAdapter(canonicalPolicies(), events);

  await assert.rejects(
    syncPracticeRolePolicyRules(adapter, {
      projectId: PROJECT_ID,
      apply: true,
      assertProjectScope: async () => {
        events.push("guard");
        throw new Error("Authenticated session project super-admin does not match target project practice-1.");
      },
    }),
    /does not match target project/,
  );

  assert.deepEqual(events, ["guard"]);
  assert.equal(adapter.patchRequests.length, 0);
});

test("a stale version fails cleanly without retry or overwrite", async () => {
  const policies = canonicalPolicies();
  const provider = policies.find((policy) => hasRole(policy, "provider"));
  assert.ok(provider);
  provider.resource = provider.resource?.slice(1);
  const adapter = new FakePolicyRuleSyncAdapter(policies);
  adapter.stalePolicyId = "provider-policy";
  const before = structuredClone(adapter.policies);

  await assert.rejects(
    syncPracticeRolePolicyRules(adapter, {
      projectId: PROJECT_ID,
      apply: true,
      assertProjectScope: async () => {},
    }),
    /412 Precondition Failed/,
  );

  assert.equal(adapter.patchRequests.length, 1);
  assert.equal(adapter.patchRequests[0]?.versionId, "7");
  assert.deepEqual(adapter.policies, before);
});

test("a later stale failure reports earlier successful updates and safe rerun guidance", async () => {
  const policies = canonicalPolicies();
  const provider = policies.find((policy) => hasRole(policy, "provider"));
  const staff = policies.find((policy) => hasRole(policy, "staff"));
  assert.ok(provider);
  assert.ok(staff);
  provider.resource = provider.resource?.slice(1);
  staff.resource = staff.resource?.slice(1);
  const adapter = new FakePolicyRuleSyncAdapter(policies);
  adapter.stalePolicyId = "staff-policy";

  await assert.rejects(
    syncPracticeRolePolicyRules(adapter, {
      projectId: PROJECT_ID,
      apply: true,
      assertProjectScope: async () => {},
    }),
    /AccessPolicy\/staff-policy update failed after 1 policy update.*Re-run.*412 Precondition Failed/,
  );

  assert.equal(adapter.patchRequests.length, 2);
  const updatedProvider = adapter.policies.find((policy) => policy.id === "provider-policy");
  assert.deepEqual(
    updatedProvider?.resource,
    buildMedplumAccessPolicy(getRoleDeclaration("provider")).resource,
  );
  const unchangedStaff = adapter.policies.find((policy) => policy.id === "staff-policy");
  assert.deepEqual(unchangedStaff?.resource, staff.resource);
});

test("live adapter sends the deployed version as a weak If-Match header", async () => {
  let captured:
    | { resourceType: string; id: string; operations: JsonPatchOperation[]; headers?: Record<string, string> }
    | undefined;
  const fhir = {
    patch: async (
      resourceType: string,
      id: string,
      operations: JsonPatchOperation[],
      headers?: Record<string, string>,
    ) => {
      captured = { resourceType, id, operations, headers };
      return canonicalPolicy("admin", id);
    },
  } as unknown as MedplumClient;
  const adapter = new LivePracticeRolePolicyRuleSyncAdapter(fhir);
  const operations: JsonPatchOperation[] = [{ op: "replace", path: "/resource", value: [] }];

  await adapter.patchPolicy("admin-policy", operations, "19");

  assert.deepEqual(captured, {
    resourceType: "AccessPolicy",
    id: "admin-policy",
    operations,
    headers: { "If-Match": 'W/"19"' },
  });
});

test("project id is required from --project or MEDPLUM_PROJECT_ID", () => {
  assert.equal(
    requiredPracticeRolePolicyRuleSyncProjectId(["--project", " practice-explicit "], "practice-env"),
    "practice-explicit",
  );
  assert.equal(requiredPracticeRolePolicyRuleSyncProjectId([], " practice-env "), "practice-env");
  assert.throws(
    () => requiredPracticeRolePolicyRuleSyncProjectId([], undefined),
    /Supply --project <project-id> or MEDPLUM_PROJECT_ID/,
  );
  assert.throws(
    () => requiredPracticeRolePolicyRuleSyncProjectId(
      ["--bootstrap-service-identity"],
      "practice-env",
      true,
    ),
    /--bootstrap-service-identity.*explicit --project <project-id>/,
  );
});

test("bootstrap credentials use only the configured service login without targeting the practice project", async () => {
  const calls: Array<{ baseUrl: string; email: string; password: string; projectId?: string }> = [];
  const result = await resolvePracticeRolePolicyRuleSyncCredentials({
    baseUrl: "http://localhost:8103",
    projectId: PROJECT_ID,
    bootstrapServiceIdentity: true,
    adminEmail: " service@example.test ",
    adminPassword: "not-a-real-password",
    login: async (input) => {
      calls.push(input);
      return "service-token";
    },
  });

  assert.deepEqual(calls, [{
    baseUrl: "http://localhost:8103",
    email: "service@example.test",
    password: "not-a-real-password",
  }]);
  assert.deepEqual(result, {
    accessToken: "service-token",
    source: "bootstrap-service-identity",
  });

  await assert.rejects(
    () => resolvePracticeRolePolicyRuleSyncCredentials({
      baseUrl: "http://localhost:8103",
      projectId: PROJECT_ID,
      bootstrapServiceIdentity: true,
      accessToken: "ambiguous-token",
      adminEmail: "service@example.test",
      adminPassword: "not-a-real-password",
      login: async () => "unused",
    }),
    /--bootstrap-service-identity.*MEDPLUM_ACCESS_TOKEN.*service identity/i,
  );
});

test("bootstrap service identity completes dry-run after the ordinary operator path is denied AccessPolicy read", async () => {
  await withPolicySyncServer(async (server) => {
    const ordinary = await runPolicySyncCli(server.baseUrl, {
      MEDPLUM_ADMIN_EMAIL: "service@example.test",
      MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
    }, ["--project", PROJECT_ID]);
    assert.equal(ordinary.code, 1);
    assert.match(ordinary.stderr, /FHIR 403 Forbidden/);

    const bootstrap = await runPolicySyncCli(server.baseUrl, {
      MEDPLUM_ADMIN_EMAIL: "service@example.test",
      MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
    }, ["--project", PROJECT_ID, "--bootstrap-service-identity"]);
    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    assert.match(bootstrap.stderr, /BREAK-GLASS.*BOOTSTRAP SERVICE IDENTITY/i);
    assert.match(bootstrap.stdout, /Mode: dry-run/);
    assert.match(bootstrap.stdout, /Dry run only/);
    assert.deepEqual(server.loginProjectIds, [PROJECT_ID, undefined]);
    assert.equal(server.operatorPolicyReads, 1);
    assert.equal(server.servicePolicyReads, 1);
    assert.equal(server.patchCalls, 0);
  });
});

test("bootstrap service identity refuses a foreign-project policy before composing or sending a patch", async () => {
  await withPolicySyncServer(async (server) => {
    const result = await runPolicySyncCli(server.baseUrl, {
      MEDPLUM_ADMIN_EMAIL: "service@example.test",
      MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
    }, ["--project", PROJECT_ID, "--bootstrap-service-identity", "--apply"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /AccessPolicy\/provider-policy.*foreign-project.*practice-1/i);
    assert.equal(server.patchCalls, 0);
  }, { policyProjectId: "foreign-project", driftAdminPolicy: true });
});

test("bootstrap service identity still refuses a non-local Medplum URL before login", async () => {
  const result = await runPolicySyncCli("https://medplum.example.test", {
    MEDPLUM_ADMIN_EMAIL: "service@example.test",
    MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
  }, ["--project", PROJECT_ID, "--bootstrap-service-identity"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /local or private HTTP\(S\) Medplum server/i);
});

function canonicalPolicies(): AccessPolicy[] {
  return PRACTICE_ROLE_IDS.map((role) => canonicalPolicy(role, `${role}-policy`));
}

function canonicalPolicy(role: PracticeRoleId, id: string): AccessPolicy {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
  return {
    ...policy,
    id,
    meta: {
      ...policy.meta,
      project: PROJECT_ID,
      versionId: "7",
      tag: [
        { system: "https://example.test/tags", code: "keep-tag" },
        ...(policy.meta?.tag ?? []),
      ],
      security: [{ system: "https://example.test/security", code: "keep-security" }],
    },
  };
}

function hasRole(policy: AccessPolicy, role: PracticeRoleId): boolean {
  return policy.meta?.tag?.some((tag) =>
    tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === role
  ) ?? false;
}

function applyPatch(policy: AccessPolicy, operations: readonly JsonPatchOperation[]): void {
  for (const operation of operations) {
    if (operation.op === "replace" && operation.path === "/resource") {
      policy.resource = structuredClone(operation.value) as AccessPolicy["resource"];
      continue;
    }
    if (operation.op === "add" && operation.path === "/resource") {
      policy.resource = structuredClone(operation.value) as AccessPolicy["resource"];
      continue;
    }
    if (operation.op === "remove" && operation.path === "/meta/tag") {
      if (policy.meta) delete policy.meta.tag;
      continue;
    }
    assert.fail(`Unexpected patch operation: ${JSON.stringify(operation)}`);
  }
}

async function runPolicySyncCli(
  baseUrl: string,
  suppliedEnv: Record<string, string>,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const name of [
    "MEDPLUM_ACCESS_TOKEN",
    "MEDPLUM_ADMIN_EMAIL",
    "MEDPLUM_ADMIN_PASSWORD",
    "MEDPLUM_PROJECT_ID",
  ]) delete env[name];
  Object.assign(env, suppliedEnv, { MEDPLUM_BASE_URL: baseUrl });
  const script = fileURLToPath(new URL("../../scripts/sync-practice-role-policy-rules.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withPolicySyncServer(
  run: (fixture: {
    baseUrl: string;
    readonly loginProjectIds: readonly (string | undefined)[];
    readonly operatorPolicyReads: number;
    readonly servicePolicyReads: number;
    readonly patchCalls: number;
  }) => Promise<void>,
  options: { policyProjectId?: string; driftAdminPolicy?: boolean } = {},
): Promise<void> {
  const loginProjectIds: Array<string | undefined> = [];
  let operatorPolicyReads = 0;
  let servicePolicyReads = 0;
  let patchCalls = 0;
  const policies = canonicalPolicies().map((policy) => ({
    ...policy,
    meta: { ...policy.meta, project: options.policyProjectId ?? PROJECT_ID },
  }));
  if (options.driftAdminPolicy) {
    const admin = policies.find((policy) => hasRole(policy, "admin"));
    assert.ok(admin);
    admin.resource = admin.resource?.filter((rule) => rule.resourceType !== "AuditEvent");
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/auth/login") {
      const login = JSON.parse(body) as Record<string, string>;
      assert.equal(login.email, "service@example.test");
      assert.equal(login.password, "not-a-real-password");
      loginProjectIds.push(login.projectId);
      return json(response, { code: login.projectId ? "operator-code" : "service-code" });
    }
    if (url.pathname === "/oauth2/token") {
      const token = new URLSearchParams(body);
      return json(response, {
        access_token: token.get("code") === "service-code" ? "service-token" : "operator-token",
      });
    }
    if (url.pathname === "/auth/me") {
      const service = request.headers.authorization === "Bearer service-token";
      return json(response, {
        project: {
          resourceType: "Project",
          id: service ? "super-admin" : PROJECT_ID,
          name: service ? "Super Admin" : "ODOS Local Practice",
        },
        membership: { resourceType: "ProjectMembership", id: service ? "service-membership" : "operator-membership" },
      });
    }
    if (url.pathname === "/fhir/R4/AccessPolicy" && request.method === "GET") {
      assert.equal(url.searchParams.get("_project"), PROJECT_ID);
      assert.equal(request.headers["x-medplum"], "extended");
      if (request.headers.authorization === "Bearer operator-token") {
        operatorPolicyReads += 1;
        response.statusCode = 403;
        response.statusMessage = "Forbidden";
        return response.end("operator policy read denied");
      }
      assert.equal(request.headers.authorization, "Bearer service-token");
      servicePolicyReads += 1;
      return json(response, {
        resourceType: "Bundle",
        type: "searchset",
        entry: policies.map((resource) => ({ resource })),
      });
    }
    if (url.pathname.startsWith("/fhir/R4/AccessPolicy/") && request.method === "PATCH") {
      patchCalls += 1;
      return json(response, policies.find((policy) => url.pathname.endsWith(`/${policy.id}`)));
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get loginProjectIds() { return loginProjectIds; },
    get operatorPolicyReads() { return operatorPolicyReads; },
    get servicePolicyReads() { return servicePolicyReads; },
    get patchCalls() { return patchCalls; },
  };
  try {
    await run(fixture);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function json(response: import("node:http").ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}
