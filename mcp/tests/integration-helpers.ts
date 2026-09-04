import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  Client as PostgresClient,
  ClientConfig,
  Pool,
  PoolConfig,
} from "pg";
import { createMedplumClient } from "../src/fhir-client.js";
import {
  createPostgresClient,
  createPostgresPool,
  type PostgresErrorLogger,
} from "../src/postgres.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";

export function loadRepoEnv(): void {
  const envPath = resolve(process.cwd(), "../.env");
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = stripEnvQuotes(rawValue.trim());
  }
}

export function exportContractProjectIdForGitHubActions(
  projectId: string,
  env: Pick<NodeJS.ProcessEnv, "GITHUB_ENV"> = process.env,
): void {
  const environmentPath = env.GITHUB_ENV?.trim();
  if (!environmentPath) return;
  appendFileSync(environmentPath, `MEDPLUM_PROJECT_ID=${projectId}\n`, "utf8");
}

export interface PostgresTestDatabase {
  readonly connectionString: string;
  registerDrain(drain: () => Promise<void>): void;
  createPool(
    config?: PoolConfig,
    context?: string,
    logError?: PostgresErrorLogger,
  ): Pool;
  connectClient(
    config?: ClientConfig,
    context?: string,
    logError?: PostgresErrorLogger,
  ): Promise<PostgresClient>;
}

export async function withPostgresTestDatabase<T>(
  input: { readonly adminUrl: string; readonly namePrefix: string },
  run: (database: PostgresTestDatabase) => Promise<T>,
): Promise<T> {
  const adminTarget = new URL(input.adminUrl);
  assert.ok(
    adminTarget.hostname === "localhost" || adminTarget.hostname === "127.0.0.1",
    "PostgreSQL integration fixtures require a localhost admin URL.",
  );
  assert.match(input.namePrefix, /^[a-z][a-z0-9_]*$/);
  const databaseName = `${input.namePrefix}_${randomUUID().replaceAll("-", "")}`;
  const connectionTarget = new URL(adminTarget);
  connectionTarget.pathname = `/${databaseName}`;
  const admin = createPostgresClient(
    { connectionString: input.adminUrl },
    `${input.namePrefix} fixture admin`,
  );
  const drains: Array<() => Promise<void>> = [];
  let databaseCreated = false;
  let result: T | undefined;
  let runError: unknown;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quotePostgresIdentifier(databaseName)} TEMPLATE template0`);
    databaseCreated = true;
    const database: PostgresTestDatabase = {
      connectionString: connectionTarget.toString(),
      registerDrain(drain) {
        drains.push(drain);
      },
      createPool(config = {}, context = `${input.namePrefix} fixture pool`, logError) {
        const pool = createPostgresPool(
          { ...config, connectionString: connectionTarget.toString() },
          context,
          logError,
        );
        drains.push(() => pool.end());
        return pool;
      },
      async connectClient(config = {}, context = `${input.namePrefix} fixture client`, logError) {
        const client = createPostgresClient(
          { ...config, connectionString: connectionTarget.toString() },
          context,
          logError,
        );
        await client.connect();
        drains.push(() => client.end());
        return client;
      },
    };
    try {
      result = await run(database);
    } catch (error) {
      runError = error;
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const drain of drains.reverse()) {
      try {
        await drain();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (databaseCreated) {
      try {
        await waitForPostgresDatabaseDrain(admin, databaseName);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quotePostgresIdentifier(databaseName)} WITH (FORCE)`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await admin.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (runError !== undefined && cleanupErrors.length === 0) {
      throw runError;
    }
    if (runError !== undefined || cleanupErrors.length > 0) {
      throw new AggregateError(
        [runError, ...cleanupErrors].filter((error) => error !== undefined),
        `PostgreSQL integration fixture ${databaseName} failed.`,
      );
    }
  }

  return result as T;
}

export function requireMedplumAdmin(
  t: Pick<TestContext, "skip">,
  surface: string,
  message = "MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum integration tests.",
): { email: string; password: string } | undefined {
  loadRepoEnv();
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (email && password) {
    return { email, password };
  }

  const recordPath = process.env.ODOS_MCP_LIVE_SKIP_RECORD;
  if (recordPath) {
    appendFileSync(recordPath, `${JSON.stringify({ surface })}\n`, "utf8");
  }
  t.skip(message);
  return undefined;
}

export async function createAuthenticatedFhirClient(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<{ fhir: ReturnType<typeof createMedplumClient>; accessToken: string }> {
  const accessToken = await loginForAccessToken(input);
  return {
    fhir: createMedplumClient({
      baseUrl: input.baseUrl,
      accessToken,
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    }),
    accessToken,
  };
}

type LiveAuthorizationIdentity = Awaited<ReturnType<typeof createAuthenticatedFhirClient>>;

export async function createLiveAuthorizationClients(
  input: { baseUrl: string; email: string; password: string },
  dependencies?: {
    loadSeeder(): Promise<LiveAuthorizationIdentity>;
    loadCaller(): Promise<LiveAuthorizationIdentity>;
  },
): Promise<{
  seederFhir: LiveAuthorizationIdentity["fhir"];
  seederAccessToken: string;
  callerFhir: LiveAuthorizationIdentity["fhir"];
  callerAccessToken: string;
}> {
  const caller = await (dependencies?.loadCaller() ?? createAuthenticatedFhirClient(input));
  const seeder = await (dependencies?.loadSeeder() ?? createOperatorSeeder(
    input.baseUrl,
    await caller.fhir.getActiveProjectId(),
  ));
  assert.notEqual(
    seeder.accessToken,
    caller.accessToken,
    "Live authorization seeder and caller must be distinct identities.",
  );
  return {
    seederFhir: seeder.fhir,
    seederAccessToken: seeder.accessToken,
    callerFhir: caller.fhir,
    callerAccessToken: caller.accessToken,
  };
}

export async function connectMcpServer(input: {
  baseUrl: string;
  email: string;
  password: string;
  accessToken: string;
  clientName: string;
}): Promise<{ client: Client }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    env: {
      ...definedEnv(process.env),
      ODOS_MCP_TRANSPORT: "stdio",
      MEDPLUM_BASE_URL: input.baseUrl,
      MEDPLUM_ADMIN_EMAIL: input.email,
      MEDPLUM_ADMIN_PASSWORD: input.password,
      MEDPLUM_ACCESS_TOKEN: input.accessToken,
    },
    stderr: "pipe",
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const client = new Client({ name: input.clientName, version: "0.0.0" });

  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => undefined);
    const stderr = stderrChunks.join("").trim();
    const detail = stderr ? `\nMCP stderr:\n${stderr}` : "";
    throw new Error(`Failed to connect to odos-mcp test server.${detail}`, {
      cause: err,
    });
  }

  return { client };
}

export function parseToolOutput<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  assert.equal(result.isError, undefined);
  return JSON.parse(toolText(result)) as T;
}

export function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  assert.ok("content" in result, "Expected MCP tool result content.");
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return first.text;
}

async function loginForAccessToken(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  const base = input.baseUrl.replace(/\/$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const loginRes = await fetchWithThrottleRetry(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }),
  });
  if (!loginRes.ok) {
    throw new Error(`Medplum login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { code } = (await loginRes.json()) as { code: string };

  const tokenRes = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Medplum token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }

  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };
  return accessToken;
}

async function createOperatorSeeder(
  baseUrl: string,
  callerProjectId: string,
): Promise<LiveAuthorizationIdentity> {
  const projectId = requiredEnv("ODOS_OPERATOR_PROJECT_ID");
  const clientId = requiredEnv("ODOS_OPERATOR_CLIENT_ID");
  const clientSecret = requiredEnv("ODOS_OPERATOR_CLIENT_SECRET");
  assert.equal(
    projectId,
    callerProjectId,
    "Live authorization seeder and caller must belong to the same Medplum project.",
  );
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) {
    throw new Error(`Live authorization seeder token exchange failed: ${response.status} ${await response.text()}`);
  }
  const { access_token: accessToken } = (await response.json()) as { access_token?: string };
  assert.ok(accessToken, "Live authorization seeder token exchange returned no access token.");
  const fhir = createMedplumClient({
    baseUrl,
    accessToken,
    audit: TEST_FHIR_AUDIT_RECORDER,
    auditContext: TEST_FHIR_AUDIT_CONTEXT,
  });
  assert.equal(
    await fhir.getActiveProjectId(),
    projectId,
    "Live authorization seeder credential resolved to a different Medplum project.",
  );
  return { fhir, accessToken };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the privileged live authorization fixture seeder.`);
  }
  return value;
}

async function fetchWithThrottleRetry(
  url: string,
  init: RequestInit,
  attempts = 2,
): Promise<Response> {
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt === attempts) {
      return res;
    }

    const body = await res.text();
    await wait(throttleDelayMs(body));
  }

  throw new Error("unreachable throttle retry state");
}

function throttleDelayMs(body: string): number {
  try {
    const parsed = JSON.parse(body) as { issue?: Array<{ diagnostics?: string }> };
    const diagnostics = parsed.issue?.find((issue) => issue.diagnostics)?.diagnostics;
    if (diagnostics) {
      const detail = JSON.parse(diagnostics) as { _msBeforeNext?: number };
      if (typeof detail._msBeforeNext === "number" && detail._msBeforeNext > 0) {
        return detail._msBeforeNext + 250;
      }
    }
  } catch {
    /* fall through to conservative delay */
  }

  return 5_000;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function waitForPostgresDatabaseDrain(
  admin: PostgresClient,
  databaseName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ connection_count: number }>(`
      SELECT count(*)::int AS connection_count
      FROM pg_stat_activity
      WHERE datname = $1
    `, [databaseName]);
    if (result.rows[0]?.connection_count === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL database ${databaseName} still has active connections after drain.`);
}
