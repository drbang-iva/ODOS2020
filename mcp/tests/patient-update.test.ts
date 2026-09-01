import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import {
  connectMcpServer,
  createLiveAuthorizationClients,
  loadRepoEnv,
  parseToolOutput,
  requireMedplumAdmin,
  toolText,
} from "./integration-helpers.js";

interface UpdatePatientToolOutput {
  patient: Patient;
}

test("update_patient MCP write tool integrates with Medplum", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const credentials = requireMedplumAdmin(t, "patient-update");
  if (!credentials) {
    return;
  }
  const { email, password } = credentials;

  const { seederFhir: fhir, callerAccessToken: accessToken } = await createLiveAuthorizationClients({
    baseUrl,
    email,
    password,
  });
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    active: true,
    gender: "unknown",
    name: [{ use: "official", family: "Smith", given: ["Mary"] }],
  });
  assert.ok(patient.id, "Expected created Patient to have an id.");

  const mcp = await connectMcpServer({
    baseUrl,
    email,
    password,
    accessToken,
    clientName: "odos-mcp-patient-update-test",
  });
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
