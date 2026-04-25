import assert from "node:assert/strict";
import { test } from "node:test";
import type { Encounter, Patient, Provenance } from "@medplum/fhirtypes";
import {
  connectMcpServer,
  createAuthenticatedFhirClient,
  loadRepoEnv,
  parseToolOutput,
  toolText,
} from "./integration-helpers.js";

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

  const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    name: [{ family: `McpEncounter${Date.now()}`, given: ["Test"] }],
  });
  assert.ok(patient.id, "Expected created Patient to have an id.");

  const mcp = await connectMcpServer({
    baseUrl,
    email,
    password,
    accessToken,
    clientName: "osod-mcp-encounter-test",
  });
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
