import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AccessPolicy, Bundle, ProjectMembership, ProjectMembershipAccess, Resource } from "@medplum/fhirtypes";
import {
  executeThreeRoleMigration,
  planThreeRoleMigration,
  resolveAuthenticatedSessionProjectId,
  resolveThreeRoleMigrationCredentials,
  resolveThreeRoleMigrationProjectId,
  type ThreeRoleMigrationAdapter,
} from "../../scripts/migrate-three-role-model.js";
import { ODOS_PRACTICE_ROLE_SYSTEM } from "../../mcp/src/authz/roles.js";

const PROJECT = "practice-1";

test("planner folds five legacy roles into three new policies and preserves access parameters", () => {
  const policies = [
    legacyPolicy("pa", "practice-admin"),
    legacyPolicy("audit", "auditor"),
    legacyPolicy("clinical", "clinician"),
    legacyPolicy("aesthetic", "aesthetics-provider"),
    legacyPolicy("desk", "front-desk"),
    unrelatedPolicy("other"),
  ];
  const parameter = [{ name: "patient_compartment", valueString: "Patient/synthetic-1" }];
  const membership = membershipFixture([
    access("pa", parameter),
    access("audit"),
    access("clinical", parameter),
    access("aesthetic"),
    access("desk"),
    access("other"),
  ]);

  const plan = planThreeRoleMigration({ projectId: PROJECT, policies, memberships: [membership] });

  assert.deepEqual(plan.canonicalRolesToCreate, ["provider", "staff", "admin"]);
  assert.deepEqual(plan.memberships[0]?.access, [
    { kind: "canonical", role: "admin", parameter },
    { kind: "canonical", role: "admin" },
    { kind: "canonical", role: "provider", parameter },
    { kind: "canonical", role: "provider" },
    { kind: "canonical", role: "staff" },
    { kind: "preserve", access: access("other") },
  ]);
  assert.deepEqual(membership.access?.[0]?.parameter, parameter);
});

test("planner deduplicates only identical canonical role and parameter entries", () => {
  const parameter = [{ name: "patient_compartment", valueString: "Patient/synthetic-1" }];
  const plan = planThreeRoleMigration({
    projectId: PROJECT,
    policies: [legacyPolicy("pa", "practice-admin"), legacyPolicy("audit", "auditor")],
    memberships: [membershipFixture([access("pa", parameter), access("audit", parameter), access("audit")])],
  });
  assert.deepEqual(plan.memberships[0]?.access, [
    { kind: "canonical", role: "admin", parameter },
    { kind: "canonical", role: "admin" },
  ]);
});

test("planner stops on ambiguous tags, ownership mismatch, missing version, and unmappable access", () => {
  const ambiguous = legacyPolicy("ambiguous", "clinician");
  ambiguous.meta!.tag!.push({ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "front-desk" });
  assert.throws(
    () => planThreeRoleMigration({ projectId: PROJECT, policies: [ambiguous], memberships: [membershipFixture([access("ambiguous")])] }),
    /ambiguous practice-role tags/,
  );

  const wrongProject = legacyPolicy("wrong-project", "front-desk");
  wrongProject.meta!.project = "other";
  assert.throws(
    () => planThreeRoleMigration({ projectId: PROJECT, policies: [wrongProject], memberships: [membershipFixture([access("wrong-project")])] }),
    /ownership mismatch/,
  );

  const missingVersion = membershipFixture([access("desk")]);
  delete missingVersion.meta;
  assert.throws(
    () => planThreeRoleMigration({ projectId: PROJECT, policies: [legacyPolicy("desk", "front-desk")], memberships: [missingVersion] }),
    /meta.versionId/,
  );

  assert.throws(
    () => planThreeRoleMigration({ projectId: PROJECT, policies: [], memberships: [membershipFixture([access("missing")])] }),
    /unmappable access/,
  );
});

test("dry-run performs zero writes; apply creates policies, conditionally patches, audits, and converges", async () => {
  const fixture = adapterFixture();
  const dryRun = await executeThreeRoleMigration(fixture.adapter, { projectId: PROJECT });
  assert.equal(dryRun.mode, "dry-run");
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.audits, []);

  const applied = await executeThreeRoleMigration(fixture.adapter, { projectId: PROJECT, apply: true });
  assert.equal(applied.mode, "apply");
  assert.deepEqual(fixture.writes.map((write) => write.kind), ["create-policy", "create-policy", "create-policy", "patch-membership"]);
  assert.equal(fixture.writes.at(-1)?.ifMatch, 'W/"7"');
  assert.deepEqual(fixture.audits, [
    "AccessPolicy/provider",
    "AccessPolicy/staff",
    "AccessPolicy/admin",
    "ProjectMembership/membership-1",
  ]);
  assert.deepEqual(fixture.membership.access?.map((entry) => entry.policy.reference), [
    "AccessPolicy/canonical-admin",
    "AccessPolicy/canonical-provider",
    "AccessPolicy/unrelated",
  ]);

  fixture.writes.length = 0;
  fixture.audits.length = 0;
  const second = await executeThreeRoleMigration(fixture.adapter, { projectId: PROJECT, apply: true });
  assert.equal(second.membershipsChanged, 0);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.audits, []);
});

test("migration credentials preserve access-token auth and prefer it over admin credentials", async () => {
  const result = await resolveThreeRoleMigrationCredentials({
    baseUrl: "http://localhost:8103",
    accessToken: " existing-token ",
    adminEmail: "admin@example.test",
    adminPassword: "not-a-real-password",
    login: async () => assert.fail("token auth must not invoke the admin login helper"),
  });

  assert.deepEqual(result, { accessToken: "existing-token", source: "access-token" });
});

test("migration credentials reuse the admin PKCE login when no access token exists", async () => {
  const calls: Array<{ baseUrl: string; email: string; password: string }> = [];
  const result = await resolveThreeRoleMigrationCredentials({
    baseUrl: "http://localhost:8103",
    adminEmail: " admin@example.test ",
    adminPassword: " padded-password ",
    login: async (input) => {
      calls.push(input);
      return "session-token";
    },
  });

  assert.deepEqual(calls, [{
    baseUrl: "http://localhost:8103",
    email: "admin@example.test",
    password: " padded-password ",
  }]);
  assert.deepEqual(result, { accessToken: "session-token", source: "admin-login" });
});

test("migration credentials name both supported options when neither is complete", async () => {
  await assert.rejects(
    () => resolveThreeRoleMigrationCredentials({
      baseUrl: "http://localhost:8103",
      adminEmail: "admin@example.test",
    }),
    /MEDPLUM_ACCESS_TOKEN.*MEDPLUM_ADMIN_EMAIL.*MEDPLUM_ADMIN_PASSWORD/,
  );
});

test("migration project resolution prefers explicit and environment values before session membership", async () => {
  const unavailableSession = async () => assert.fail("an explicit project must not inspect the session");
  assert.equal(await resolveThreeRoleMigrationProjectId({
    explicitProjectId: " cli-project ",
    environmentProjectId: "environment-project",
    resolveSessionProjectId: unavailableSession,
  }), "cli-project");
  assert.equal(await resolveThreeRoleMigrationProjectId({
    environmentProjectId: " environment-project ",
    resolveSessionProjectId: unavailableSession,
  }), "environment-project");
});

test("migration project resolution uses exactly one active membership for the authenticated profile", async () => {
  const activeWithUnsetFlag = sessionMembership("active", "practice-current");
  delete activeWithUnsetFlag.active;
  const client = membershipSearchClient([
    sessionMembership("inactive", "practice-old", false),
    activeWithUnsetFlag,
    {
      ...sessionMembership("other-profile", "practice-other"),
      profile: { reference: "Practitioner/other" },
    },
  ]);
  const projectId = await resolveThreeRoleMigrationProjectId({
    resolveSessionProjectId: () => resolveAuthenticatedSessionProjectId({
      baseUrl: "http://localhost:8103",
      accessToken: "session-token",
      fhir: client,
      request: async (url, init) => {
        assert.equal(String(url), "http://localhost:8103/auth/me");
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer session-token");
        return Response.json({ profile: { reference: "Practitioner/admin" } });
      },
    }),
  });

  assert.equal(projectId, "practice-current");
});

test("migration project resolution refuses ambiguous session memberships and names the explicit override", async () => {
  const client = membershipSearchClient([
    sessionMembership("first", "practice-1"),
    sessionMembership("second", "practice-2"),
  ]);
  await assert.rejects(
    () => resolveAuthenticatedSessionProjectId({
      baseUrl: "http://localhost:8103",
      accessToken: "session-token",
      fhir: client,
      request: async () => Response.json({ profile: { reference: "Practitioner/admin" } }),
    }),
    /found 2.*--project <project-id>.*MEDPLUM_PROJECT_ID/,
  );
});

test("the migration CLI accepts an access token, resolves its session membership, and stays dry-run", async () => {
  await withMigrationServer(async (server) => {
    const result = await runMigrationCli(server.baseUrl, {
      MEDPLUM_ACCESS_TOKEN: "fixture-token",
      MEDPLUM_ADMIN_EMAIL: "admin@example.test",
      MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(server.loginCalls, 0);
    assert.match(result.stdout, /"mode": "dry-run"/);
    assert.match(result.stdout, /Dry run only/);
    assert.equal(server.projectMembershipSearches, 2);
  });
});

test("the migration CLI accepts only admin email and password through the shared PKCE login", async () => {
  await withMigrationServer(async (server) => {
    const result = await runMigrationCli(server.baseUrl, {
      MEDPLUM_ADMIN_EMAIL: "admin@example.test",
      MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(server.loginCalls, 1);
    assert.equal(server.tokenCalls, 1);
    assert.match(result.stdout, /"mode": "dry-run"/);
    assert.match(result.stdout, /Dry run only/);
  });
});

test("the migration CLI rejects missing credentials and names both supported options", async () => {
  const result = await runMigrationCli("http://127.0.0.1:1", {});

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /MEDPLUM_ACCESS_TOKEN.*MEDPLUM_ADMIN_EMAIL.*MEDPLUM_ADMIN_PASSWORD/,
  );
});

function adapterFixture() {
  const policies: AccessPolicy[] = [
    legacyPolicy("legacy-admin", "practice-admin"),
    legacyPolicy("legacy-provider", "clinician"),
    unrelatedPolicy("unrelated"),
  ];
  const membership = membershipFixture([access("legacy-admin"), access("legacy-provider"), access("unrelated")]);
  const writes: Array<{ kind: string; ifMatch?: string }> = [];
  const audits: string[] = [];
  const adapter: ThreeRoleMigrationAdapter = {
    readPolicies: async () => structuredClone(policies),
    readMemberships: async () => [structuredClone(membership)],
    createPolicy: async (role, policy) => {
      writes.push({ kind: "create-policy" });
      const created = {
        ...policy,
        id: `canonical-${role}`,
        meta: { ...policy.meta, project: PROJECT, versionId: "1" },
      };
      policies.push(created);
      return structuredClone(created);
    },
    patchMembership: async (_id, nextAccess, ifMatch) => {
      writes.push({ kind: "patch-membership", ifMatch });
      membership.access = structuredClone(nextAccess);
      membership.meta = { ...membership.meta, versionId: "8" };
      return structuredClone(membership);
    },
    recordMutation: async (target, operation) => {
      audits.push(target);
      return operation();
    },
  };
  return { adapter, audits, membership, writes };
}

function legacyPolicy(id: string, role: string): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    id,
    meta: {
      project: PROJECT,
      versionId: "3",
      tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: role }],
    },
  };
}

function unrelatedPolicy(id: string): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    id,
    meta: { project: PROJECT, versionId: "2", tag: [{ system: "https://example.test/tag", code: "unrelated" }] },
  };
}

function membershipFixture(entries: ProjectMembershipAccess[]): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id: "membership-1",
    meta: { versionId: "7" },
    project: { reference: `Project/${PROJECT}` },
    user: { reference: "User/synthetic-user" },
    profile: { reference: "Practitioner/synthetic-practitioner" },
    access: entries,
  };
}

function access(id: string, parameter?: ProjectMembershipAccess["parameter"]): ProjectMembershipAccess {
  return { policy: { reference: `AccessPolicy/${id}` }, ...(parameter ? { parameter: structuredClone(parameter) } : {}) };
}

function sessionMembership(id: string, projectId: string, active = true): ProjectMembership {
  return {
    resourceType: "ProjectMembership",
    id,
    active,
    project: { reference: `Project/${projectId}` },
    profile: { reference: "Practitioner/admin" },
    user: { reference: "User/admin" },
  };
}

function membershipSearchClient(memberships: ProjectMembership[]) {
  return {
    async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}) {
      assert.equal(resourceType, "ProjectMembership");
      assert.equal(params.profile, "Practitioner/admin");
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: memberships.map((resource) => ({ resource: resource as T })),
      } as Bundle<T>;
    },
  };
}

async function runMigrationCli(
  baseUrl: string,
  suppliedEnv: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const name of [
    "MEDPLUM_ACCESS_TOKEN",
    "MEDPLUM_ADMIN_EMAIL",
    "MEDPLUM_ADMIN_PASSWORD",
    "MEDPLUM_PROJECT_ID",
  ]) delete env[name];
  Object.assign(env, suppliedEnv, { MEDPLUM_BASE_URL: baseUrl });
  const script = fileURLToPath(new URL("../../scripts/migrate-three-role-model.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
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

async function withMigrationServer(
  run: (fixture: {
    baseUrl: string;
    readonly loginCalls: number;
    readonly tokenCalls: number;
    readonly projectMembershipSearches: number;
  }) => Promise<void>,
): Promise<void> {
  let loginCalls = 0;
  let tokenCalls = 0;
  let projectMembershipSearches = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/auth/login") {
      loginCalls += 1;
      const login = JSON.parse(body) as Record<string, string>;
      assert.equal(login.email, "admin@example.test");
      assert.equal(login.password, "not-a-real-password");
      assert.equal(login.codeChallengeMethod, "S256");
      assert.ok(login.codeChallenge);
      return json(response, { code: "fixture-code" });
    }
    if (url.pathname === "/oauth2/token") {
      tokenCalls += 1;
      const token = new URLSearchParams(body);
      assert.equal(token.get("grant_type"), "authorization_code");
      assert.equal(token.get("code"), "fixture-code");
      assert.ok(token.get("code_verifier"));
      return json(response, { access_token: "fixture-token" });
    }
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    if (url.pathname === "/auth/me") {
      return json(response, { profile: { reference: "Practitioner/admin" } });
    }
    if (url.pathname === "/fhir/R4/AccessPolicy") {
      return json(response, { resourceType: "Bundle", type: "searchset", entry: [] });
    }
    if (url.pathname === "/fhir/R4/ProjectMembership") {
      projectMembershipSearches += 1;
      return json(response, {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: sessionMembership("admin-membership", "practice-1") }],
      });
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get loginCalls() { return loginCalls; },
    get tokenCalls() { return tokenCalls; },
    get projectMembershipSearches() { return projectMembershipSearches; },
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
