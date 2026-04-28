import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CarePlan,
  Device,
  EpisodeOfCare,
  MedicationStatement,
  Observation,
  Patient,
  Procedure,
  Provenance,
} from "@medplum/fhirtypes";
import {
  connectMcpServer,
  createAuthenticatedFhirClient,
  loadRepoEnv,
  parseToolOutput,
} from "./integration-helpers.js";

interface ToolOutput {
  provenance: Provenance;
}

type DeviceOutput = ToolOutput & { device: Device };
type ProcedureOutput = ToolOutput & { procedure: Procedure };
type ObservationOutput = ToolOutput & { observation: Observation };
type EpisodeOutput = ToolOutput & { episodeOfCare: EpisodeOfCare };
type CarePlanOutput = ToolOutput & { carePlan: CarePlan };
type MedicationOutput = ToolOutput & { medicationStatement: MedicationStatement };

test("v0.4c Ortho-K and myopia MCP write tools create resources with mandatory Provenance", { timeout: 180_000 }, async (t) => {
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
    active: true,
    name: [{ family: `V04C${Date.now()}`, given: ["Test"] }],
  });
  assert.ok(patient.id);

  const mcp = await connectMcpServer({
    baseUrl,
    email,
    password,
    accessToken,
    clientName: "osod-mcp-v04c-write-tools-test",
  });
  t.after(async () => {
    await mcp.client.close();
  });

  let lensDevice: Device;
  let seriesProcedure: Procedure;
  let episode: EpisodeOfCare;
  let carePlan: CarePlan;
  let atropine: MedicationStatement;

  await t.test("create_ortho_k_lens_device writes Device-OrthoKLens", async () => {
    const output = parseToolOutput<DeviceOutput>(
      await mcp.client.callTool({
        name: "create_ortho_k_lens_device",
        arguments: {
          patient_id: patient.id,
          device_name: "OD Ortho-K trial",
          properties: [
            { code: "base-curve-mm", value_number: 7.8, unit_code: "mm" },
            { code: "reverse-curve-depth-um", value_number: 550, unit_code: "um" },
            { code: "optic-zone-diameter-mm", value_number: 6.2, unit_code: "mm" },
            { code: "diameter-mm", value_number: 10.6, unit_code: "mm" },
          ],
        },
      }),
    );

    lensDevice = output.device;
    assert.equal(output.device.resourceType, "Device");
    assert.equal(output.device.patient?.reference, `Patient/${patient.id}`);
    assertProvenance(output.provenance, `Device/${output.device.id}`);
  });

  await t.test("record_ortho_k_fitting_event writes Procedure.usedReference", async () => {
    const output = parseToolOutput<ProcedureOutput>(
      await mcp.client.callTool({
        name: "record_ortho_k_fitting_event",
        arguments: {
          patient_id: patient.id,
          lens_device_id: lensDevice.id,
          note_text: "Initial fitting trail",
        },
      }),
    );

    seriesProcedure = output.procedure;
    assert.equal(output.procedure.usedReference?.[0]?.reference, `Device/${lensDevice.id}`);
    assertProvenance(output.provenance, `Procedure/${output.procedure.id}`);
  });

  await t.test("record_ortho_k_trial writes child Procedure.partOf", async () => {
    const output = parseToolOutput<ProcedureOutput>(
      await mcp.client.callTool({
        name: "record_ortho_k_trial",
        arguments: {
          patient_id: patient.id,
          lens_device_id: lensDevice.id,
          series_procedure_id: seriesProcedure.id,
          trial_number: 1,
          outcome_text: "Accepted for overnight dispense",
        },
      }),
    );

    assert.equal(output.procedure.partOf?.[0]?.reference, `Procedure/${seriesProcedure.id}`);
    assertProvenance(output.provenance, `Procedure/${output.procedure.id}`);
  });

  await t.test("record_ortho_k_fit_observation writes Observation.focus", async () => {
    const output = parseToolOutput<ObservationOutput>(
      await mcp.client.callTool({
        name: "record_ortho_k_fit_observation",
        arguments: {
          patient_id: patient.id,
          lens_device_id: lensDevice.id,
          finding_code: "centration",
          value_code: "well-centered",
          value_display: "Well-centered",
        },
      }),
    );

    assert.equal(output.observation.focus?.[0]?.reference, `Device/${lensDevice.id}`);
    assert.equal(output.observation.derivedFrom, undefined);
    assertProvenance(output.provenance, `Observation/${output.observation.id}`);
  });

  await t.test("update_ortho_k_lens_parameters uses version-aware PATCH", async () => {
    const output = parseToolOutput<DeviceOutput>(
      await mcp.client.callTool({
        name: "update_ortho_k_lens_parameters",
        arguments: {
          lens_device_id: lensDevice.id,
          properties: [{ code: "alignment-curve-mm", value_number: 8.3, unit_code: "mm" }],
        },
      }),
    );

    lensDevice = output.device;
    assert.ok(output.device.property?.some((property) => property.type.coding?.[0]?.code === "alignment-curve-mm"));
    assertProvenance(output.provenance, `Device/${output.device.id}`);
  });

  await t.test("create_myopia_management_episode writes EpisodeOfCare", async () => {
    const output = parseToolOutput<EpisodeOutput>(
      await mcp.client.callTool({
        name: "create_myopia_management_episode",
        arguments: { patient_id: patient.id },
      }),
    );

    episode = output.episodeOfCare;
    assert.equal(output.episodeOfCare.type?.[0]?.coding?.[0]?.code, "myopia-management");
    assertProvenance(output.provenance, `EpisodeOfCare/${output.episodeOfCare.id}`);
  });

  await t.test("create_atropine_medication_statement writes concentration doseAndRate", async () => {
    const output = parseToolOutput<MedicationOutput>(
      await mcp.client.callTool({
        name: "create_atropine_medication_statement",
        arguments: {
          patient_id: patient.id,
          episode_of_care_id: episode.id,
          concentration: "0.025%",
          frequency_text: "1 drop OU qhs",
        },
      }),
    );

    atropine = output.medicationStatement;
    assert.equal(output.medicationStatement.dosage?.[0]?.doseAndRate?.[0]?.doseQuantity?.code, "0.025%");
    assertProvenance(output.provenance, `MedicationStatement/${output.medicationStatement.id}`);
  });

  await t.test("create_or_update_myopia_plan writes CarePlan.activity entries", async () => {
    const output = parseToolOutput<CarePlanOutput>(
      await mcp.client.callTool({
        name: "create_or_update_myopia_plan",
        arguments: {
          patient_id: patient.id,
          episode_of_care_id: episode.id,
          activities: [
            { intervention_code: "ortho-K", resource_reference: `Device/${lensDevice.id}` },
            { intervention_code: "atropine-medium-dose", resource_reference: `MedicationStatement/${atropine.id}` },
          ],
        },
      }),
    );

    carePlan = output.carePlan;
    assert.equal(output.carePlan.activity?.length, 2);
    assertProvenance(output.provenance, `CarePlan/${output.carePlan.id}`);
  });

  await t.test("create_or_update_myopia_plan patches an existing CarePlan", async () => {
    const output = parseToolOutput<CarePlanOutput>(
      await mcp.client.callTool({
        name: "create_or_update_myopia_plan",
        arguments: {
          patient_id: patient.id,
          care_plan_id: carePlan.id,
          activities: [
            { intervention_code: "MiSight", status: "scheduled" },
            { intervention_code: "atropine-medium-dose", resource_reference: `MedicationStatement/${atropine.id}` },
          ],
        },
      }),
    );

    carePlan = output.carePlan;
    assert.equal(output.carePlan.activity?.[0]?.detail?.code?.coding?.[0]?.code, "MiSight");
    assertProvenance(output.provenance, `CarePlan/${output.carePlan.id}`);
  });

  await t.test("update_atropine_medication_status uses version-aware PATCH", async () => {
    const output = parseToolOutput<MedicationOutput>(
      await mcp.client.callTool({
        name: "update_atropine_medication_status",
        arguments: {
          medication_statement_id: atropine.id,
          status: "resolved",
        },
      }),
    );

    assert.equal(output.medicationStatement.status, "completed");
    assertProvenance(output.provenance, `MedicationStatement/${output.medicationStatement.id}`);
  });

  await t.test("record_myopia_axial_length_measurement writes mm Observation", async () => {
    const output = parseToolOutput<ObservationOutput>(
      await mcp.client.callTool({
        name: "record_myopia_axial_length_measurement",
        arguments: {
          patient_id: patient.id,
          encounter_id: "v04c-no-encounter",
          eye: "OD",
          value_mm: 24.12,
        },
      }),
    );

    assert.equal(output.observation.valueQuantity?.code, "mm");
    assertProvenance(output.provenance, `Observation/${output.observation.id}`);
  });
});

function assertProvenance(provenance: Provenance | undefined, targetReference: string): void {
  assert.ok(provenance, `Expected Provenance for ${targetReference}.`);
  assert.ok(
    provenance.target.some((target) => target.reference === targetReference),
    `Expected Provenance target ${targetReference}.`,
  );
}
