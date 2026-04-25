import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMedplumClient } from "../src/fhir-client.js";

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

export async function createAuthenticatedFhirClient(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<{ fhir: ReturnType<typeof createMedplumClient>; accessToken: string }> {
  const accessToken = await loginForAccessToken(input);
  return {
    fhir: createMedplumClient({ baseUrl: input.baseUrl, accessToken }),
    accessToken,
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
      OSOD_MCP_TRANSPORT: "stdio",
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
    throw new Error(`Failed to connect to osod-mcp test server.${detail}`, {
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
