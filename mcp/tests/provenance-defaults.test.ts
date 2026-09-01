import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Encounter, Observation, Patient, Provenance } from "@medplum/fhirtypes";
import {
  connectMcpServer,
  createLiveAuthorizationClients,
  loadRepoEnv,
  parseToolOutput,
  requireMedplumAdmin,
} from "./integration-helpers.js";

interface CreateEncounterToolOutput {
  encounter: Encounter;
  provenance?: Provenance;
}

interface CreateObservationToolOutput {
  observation: Observation;
  provenance?: Provenance;
}

interface UpdatePatientToolOutput {
  patient: Patient;
  provenance?: Provenance;
}

interface CreateRawAssetReferenceToolOutput {
  documentReference: { resourceType: "DocumentReference"; id?: string };
  provenance?: Provenance;
}

interface CreateVisionPrescriptionToolOutput {
  visionPrescription: { resourceType: "VisionPrescription"; id?: string };
  provenance?: Provenance;
}

test("clinical MCP write tools default Provenance ON", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const credentials = requireMedplumAdmin(t, "provenance-defaults");
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
    name: [{ family: `ProvDefaults${Date.now()}`, given: ["Test"] }],
  });
  assert.ok(patient.id, "Expected created Patient to have an id.");

  const mcp = await connectMcpServer({
    baseUrl,
    email,
    password,
    accessToken,
    clientName: "odos-mcp-provenance-defaults-test",
  });
  t.after(async () => {
    await mcp.client.close();
  });

  const encounterOutput = parseToolOutput<CreateEncounterToolOutput>(
    await mcp.client.callTool({
      name: "create_encounter",
      arguments: {
        patient_id: patient.id,
        class_code: "AMB",
        status: "in-progress",
        period_start: new Date().toISOString(),
      },
    }),
  );
  assert.ok(encounterOutput.provenance, "create_encounter should default Provenance ON.");
  assert.equal(
    encounterOutput.provenance.target[0]?.reference,
    `Encounter/${encounterOutput.encounter.id}`,
  );

  const observationOutput = parseToolOutput<CreateObservationToolOutput>(
    await mcp.client.callTool({
      name: "create_observation",
      arguments: {
        type: "iop",
        patient_id: patient.id,
        encounter_id: encounterOutput.encounter.id,
        laterality: "OD",
        value: 14,
        method: "GAT",
      },
    }),
  );
  assert.ok(observationOutput.provenance, "create_observation should default Provenance ON.");
  assert.equal(observationOutput.observation.status, "preliminary");
  assert.equal(
    observationOutput.provenance.target[0]?.reference,
    `Observation/${observationOutput.observation.id}`,
  );

  const updatePatientOutput = parseToolOutput<UpdatePatientToolOutput>(
    await mcp.client.callTool({
      name: "update_patient",
      arguments: {
        patient_id: patient.id,
        active: false,
      },
    }),
  );
  assert.equal(updatePatientOutput.patient.id, patient.id);
  assert.equal(updatePatientOutput.provenance, undefined, "update_patient stays Provenance opt-in.");

  const rawAssetOutput = parseToolOutput<CreateRawAssetReferenceToolOutput>(
    await mcp.client.callTool({
      name: "create_raw_asset_reference",
      arguments: {
        patient_id: patient.id,
        encounter_id: encounterOutput.encounter.id,
        content_type: "text/plain",
        title: "Provenance default smoke",
        data: "c21va2U=",
      },
    }),
  );
  assert.ok(rawAssetOutput.provenance, "create_raw_asset_reference should default Provenance ON.");
  assert.equal(
    rawAssetOutput.provenance.target[0]?.reference,
    `DocumentReference/${rawAssetOutput.documentReference.id}`,
  );

  const sectionResponse = parseToolOutput<Bundle>(
    await mcp.client.callTool({
      name: "save_section_observations",
      arguments: {
        patient_id: patient.id,
        encounter_id: encounterOutput.encounter.id,
        section: "va",
        entries: [{ laterality: "OD", snellen: "20/20", chart_type: "SNELLEN", correction: "SC" }],
      },
    }),
  );
  assert.ok(
    sectionResponse.entry?.some((entry) => entry.resource?.resourceType === "Provenance"),
    "save_section_observations should always include Provenance entries.",
  );

  const finalRxOutput = parseToolOutput<CreateObservationToolOutput>(
    await mcp.client.callTool({
      name: "create_observation",
      arguments: {
        type: "refraction",
        patient_id: patient.id,
        encounter_id: encounterOutput.encounter.id,
        laterality: "OD",
        refraction_type: "FINAL_RX",
        sphere: -1.25,
      },
    }),
  );
  const visionPrescriptionOutput = parseToolOutput<CreateVisionPrescriptionToolOutput>(
    await mcp.client.callTool({
      name: "create_vision_prescription",
      arguments: {
        patient_id: patient.id,
        refraction_observation_id: finalRxOutput.observation.id,
        prescriber_reference: "Practitioner/odos-test",
      },
    }),
  );
  assert.ok(visionPrescriptionOutput.provenance, "create_vision_prescription should default Provenance ON.");
  assert.equal(
    visionPrescriptionOutput.provenance.target[0]?.reference,
    `VisionPrescription/${visionPrescriptionOutput.visionPrescription.id}`,
  );
});
