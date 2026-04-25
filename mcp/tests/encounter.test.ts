import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Encounter, Patient, Provenance } from "@medplum/fhirtypes";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMedplumClient } from "../src/fhir-client.js";

interface CreateEncounterToolOutput {
  encounter: Encounter;
  provenance?: Provenance;
  warnings?: string[];
}

test("create_encounter MCP write tool integrates with Medplum", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;

  if (!email || !password) {
    t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum integration tests.");
    return;
  }

  const fhir = createMedplumClient({ baseUrl });
  await fhir.login(email, password);
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    name: [{ family: `McpEncounter${Date.now()}`, given: ["Test"] }],
  });
  assert.ok(patient.id, "Expected created Patient to have an id.");

  const mcp = await connectMcpServer({ baseUrl, email, password });
  t.after(async () => {
    await mcp.client.close();
  });

  await t.test("creates an ambulatory in-progress Encounter for a Patient", async () => {
    const output = parseToolOutput<CreateEncounterToolOutput>(
      await mcp.client.callTool({
        name: "create_encounter",
        arguments: {
          patient_id: patient.id,
          class_code: "AMB",
          status: "in-progress",
        },
      }),
    );

    assert.equal(output.encounter.subject?.reference, `Patient/${patient.id}`);
    assert.equal(output.encounter.class.code, "AMB");
    assert.equal(output.encounter.status, "in-progress");
  });

  await t.test("creates Provenance when create_provenance is true", async () => {
    const output = parseToolOutput<CreateEncounterToolOutput>(
      await mcp.client.callTool({
        name: "create_encounter",
        arguments: {
          patient_id: `Patient/${patient.id}`,
          class_code: "AMB",
          status: "in-progress",
          create_provenance: true,
          provenance_agent_display: "OSOD MCP encounter integration test",
        },
      }),
    );

    assert.ok(output.encounter.id, "Expected created Encounter to have an id.");
    assert.equal(
      output.provenance?.target[0]?.reference,
      `Encounter/${output.encounter.id}`,
    );
    assert.ok(output.provenance?.agent[0]?.who, "Expected Provenance.agent[0].who to be present.");
  });

  await t.test("rejects invalid class_code at Zod parse", async () => {
    const result = await mcp.client.callTool({
      name: "create_encounter",
      arguments: {
        patient_id: patient.id,
        class_code: "AMB-X",
        status: "in-progress",
      },
    });

    assert.equal(result.isError, true);
    assert.match(toolText(result), /class_code must be one of: AMB/);
  });

  await t.test("rejects missing patient_id at Zod parse", async () => {
    const result = await mcp.client.callTool({
      name: "create_encounter",
      arguments: {
        class_code: "AMB",
        status: "in-progress",
      },
    });

    assert.equal(result.isError, true);
    assert.match(toolText(result), /patient_id is required/);
  });
});

function loadRepoEnv(): void {
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

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function connectMcpServer(input: {
  baseUrl: string;
  email: string;
  password: string;
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
    },
    stderr: "pipe",
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const client = new Client({ name: "osod-mcp-encounter-test", version: "0.0.0" });

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

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function parseToolOutput<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  assert.equal(result.isError, undefined);
  return JSON.parse(toolText(result)) as T;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  assert.ok("content" in result, "Expected MCP tool result content.");
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return first.text;
}
