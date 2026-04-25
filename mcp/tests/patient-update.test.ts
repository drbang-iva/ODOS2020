import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMedplumClient } from "../src/fhir-client.js";

interface UpdatePatientToolOutput {
  patient: Patient;
}

test("update_patient MCP write tool integrates with Medplum", { timeout: 90_000 }, async (t) => {
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
    active: true,
    gender: "unknown",
    name: [{ use: "official", family: "Smith", given: ["Mary"] }],
  });
  assert.ok(patient.id, "Expected created Patient to have an id.");

  const mcp = await connectMcpServer({ baseUrl, email, password });
  t.after(async () => {
    await mcp.client.close();
  });

  await t.test("updates gender only and preserves existing name and active", async () => {
    const output = parseToolOutput<UpdatePatientToolOutput>(
      await mcp.client.callTool({
        name: "update_patient",
        arguments: {
          patient_id: `Patient/${patient.id}`,
          gender: "female",
        },
      }),
    );

    assert.equal(output.patient.gender, "female");
    assert.equal(output.patient.name?.[0]?.family, "Smith");
    assert.deepEqual(output.patient.name?.[0]?.given, ["Mary"]);
    assert.equal(output.patient.active, true);
  });

  await t.test("updates name only and preserves prior gender", async () => {
    const output = parseToolOutput<UpdatePatientToolOutput>(
      await mcp.client.callTool({
        name: "update_patient",
        arguments: {
          patient_id: patient.id,
          name: {
            family: "Jones",
            given: ["Mary"],
          },
        },
      }),
    );

    assert.equal(output.patient.name?.[0]?.family, "Jones");
    assert.deepEqual(output.patient.name?.[0]?.given, ["Mary"]);
    assert.equal(output.patient.name?.[0]?.use, "official");
    assert.equal(output.patient.gender, "female");
  });

  await t.test("rejects update with no fields", async () => {
    const result = await mcp.client.callTool({
      name: "update_patient",
      arguments: {
        patient_id: patient.id,
      },
    });

    assert.equal(result.isError, true);
    assert.match(toolText(result), /update_patient requires at least one field to update/);
  });

  await t.test("rejects invalid birth_date format at Zod parse", async () => {
    const result = await mcp.client.callTool({
      name: "update_patient",
      arguments: {
        patient_id: patient.id,
        birth_date: "1985/04/12",
      },
    });

    assert.equal(result.isError, true);
    assert.match(toolText(result), /birth_date must use YYYY-MM-DD format/);
  });

  await t.test("rejects invalid uppercase gender at Zod parse", async () => {
    const result = await mcp.client.callTool({
      name: "update_patient",
      arguments: {
        patient_id: patient.id,
        gender: "Male",
      },
    });

    assert.equal(result.isError, true);
    assert.match(toolText(result), /Invalid enum value/);
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

  const client = new Client({ name: "osod-mcp-patient-update-test", version: "0.0.0" });

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
