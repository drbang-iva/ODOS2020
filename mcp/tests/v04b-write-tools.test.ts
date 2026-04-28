import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AdverseEvent,
  Device,
  DocumentReference,
  MedicationStatement,
  Observation,
  Patient,
  Procedure,
  Provenance,
  QuestionnaireResponse,
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

type QuestionnaireOutput = ToolOutput & {
  questionnaireResponse: QuestionnaireResponse;
  scoreObservation: Observation;
};
type MeibographyOutput = ToolOutput & {
  documentReference?: DocumentReference;
  observation: Observation;
};
type TreatmentProcedureOutput = ToolOutput & { procedure: Procedure };
type TreatmentSeriesOutput = ToolOutput & {
  seriesProcedure: Procedure;
  sessionProcedures: Procedure[];
};
type MedicationOutput = ToolOutput & { medicationStatement: MedicationStatement };
type AdverseEventOutput = ToolOutput & { adverseEvent: AdverseEvent };

test("v0.4b dry-eye MCP write tools create resources with mandatory Provenance", { timeout: 180_000 }, async (t) => {
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
    name: [{ family: `V04DryEye${Date.now()}`, given: ["Test"] }],
  });
  const treatmentDevice = await fhir.create<Device>({
    resourceType: "Device",
    status: "active",
    deviceName: [{ name: "Test IPL", type: "user-friendly-name" }],
    patient: { reference: `Patient/${patient.id}` },
  });

  const mcp = await connectMcpServer({
    baseUrl,
    email,
    password,
    accessToken,
    clientName: "osod-mcp-v04b-write-tools-test",
  });
  t.after(async () => {
    await mcp.client.close();
  });

  let seriesSession: Procedure;
  let medicationStatement: MedicationStatement;

  await t.test("create_dry_eye_questionnaire_response writes QuestionnaireResponse, score Observation, and Provenance", async () => {
    const output = parseToolOutput<QuestionnaireOutput>(
      await mcp.client.callTool({
        name: "create_dry_eye_questionnaire_response",
        arguments: {
          patient_id: patient.id,
          instrument: "SPEED",
          answers: [
            { link_id: "speed-1", value_integer: 1 },
            { link_id: "speed-2", value_integer: 2 },
            { link_id: "speed-3", value_integer: 3 },
            { link_id: "speed-4", value_integer: 4 },
          ],
        },
      }),
    );

    assert.equal(output.questionnaireResponse.resourceType, "QuestionnaireResponse");
    assert.equal(output.scoreObservation.derivedFrom?.[0]?.reference, `QuestionnaireResponse/${output.questionnaireResponse.id}`);
    assertProvenance(output.provenance, `QuestionnaireResponse/${output.questionnaireResponse.id}`);
    assertProvenance(output.provenance, `Observation/${output.scoreObservation.id}`);
  });

  await t.test("create_meibography_observation writes DocumentReference-linked Observation and Provenance", async () => {
    const output = parseToolOutput<MeibographyOutput>(
      await mcp.client.callTool({
        name: "create_meibography_observation",
        arguments: {
          patient_id: patient.id,
          eye: "OD",
          lid: "upper",
          scoring_system: "meiboscore",
          total_score: 4,
          content_type: "image/png",
          url: "https://osod.dev/test-assets/meibography.png",
          title: "Test meibography",
        },
      }),
    );

    assert.equal(output.documentReference?.resourceType, "DocumentReference");
    assert.equal(output.observation.derivedFrom?.[0]?.reference, `DocumentReference/${output.documentReference?.id}`);
    assertProvenance(output.provenance, `Observation/${output.observation.id}`);
  });

  await t.test("create_dry_eye_treatment_series writes parent and Procedure.partOf children", async () => {
    const output = parseToolOutput<TreatmentSeriesOutput>(
      await mcp.client.callTool({
        name: "create_dry_eye_treatment_series",
        arguments: {
          patient_id: patient.id,
          treatment_type: "IPL",
          total_sessions: 4,
          treatment_device_id: treatmentDevice.id,
          energy_mj: 14,
          wavelength_nm: 590,
          spot_count: 42,
        },
      }),
    );

    seriesSession = output.sessionProcedures[0];
    assert.equal(output.sessionProcedures.length, 4);
    assert.equal(output.sessionProcedures[0].partOf?.[0]?.reference, `Procedure/${output.seriesProcedure.id}`);
    assert.equal(output.sessionProcedures[0].usedReference?.[0]?.reference, `Device/${treatmentDevice.id}`);
    assertProvenance(output.provenance, `Procedure/${output.seriesProcedure.id}`);
  });

  await t.test("create_dry_eye_treatment_procedure writes a single session", async () => {
    const output = parseToolOutput<TreatmentProcedureOutput>(
      await mcp.client.callTool({
        name: "create_dry_eye_treatment_procedure",
        arguments: {
          patient_id: patient.id,
          treatment_type: "RF",
          treatment_device_id: treatmentDevice.id,
          status: "in-progress",
        },
      }),
    );

    assert.equal(output.procedure.resourceType, "Procedure");
    assert.equal(output.procedure.usedReference?.[0]?.reference, `Device/${treatmentDevice.id}`);
    assertProvenance(output.provenance, `Procedure/${output.procedure.id}`);
  });

  await t.test("update_dry_eye_treatment_procedure_status uses version-aware PATCH and Provenance", async () => {
    const output = parseToolOutput<TreatmentProcedureOutput>(
      await mcp.client.callTool({
        name: "update_dry_eye_treatment_procedure_status",
        arguments: {
          procedure_id: seriesSession.id,
          status: "completed",
        },
      }),
    );

    assert.equal(output.procedure.status, "completed");
    assertProvenance(output.provenance, `Procedure/${output.procedure.id}`);
  });

  await t.test("create_ophthalmic_medication_statement writes MedicationStatement and Provenance", async () => {
    const output = parseToolOutput<MedicationOutput>(
      await mcp.client.callTool({
        name: "create_ophthalmic_medication_statement",
        arguments: {
          patient_id: patient.id,
          medication_text: "Restasis",
          supply_type: "rx",
          dosage_text: "One drop twice daily",
        },
      }),
    );

    medicationStatement = output.medicationStatement;
    assert.equal(output.medicationStatement.resourceType, "MedicationStatement");
    assert.equal(output.medicationStatement.dosage?.[0]?.route?.text, "Ophthalmic route");
    assertProvenance(output.provenance, `MedicationStatement/${output.medicationStatement.id}`);
  });

  await t.test("update_dry_eye_medication_status uses version-aware PATCH and Provenance", async () => {
    const output = parseToolOutput<MedicationOutput>(
      await mcp.client.callTool({
        name: "update_dry_eye_medication_status",
        arguments: {
          medication_statement_id: medicationStatement.id,
          status: "resolved",
        },
      }),
    );

    assert.equal(output.medicationStatement.status, "completed");
    assertProvenance(output.provenance, `MedicationStatement/${output.medicationStatement.id}`);
  });

  await t.test("create_dry_eye_adverse_event writes AdverseEvent and Provenance", async () => {
    const output = parseToolOutput<AdverseEventOutput>(
      await mcp.client.callTool({
        name: "create_dry_eye_adverse_event",
        arguments: {
          patient_id: patient.id,
          event_text: "Corneal edema",
          suspect_entity_references: [`Procedure/${seriesSession.id}`],
        },
      }),
    );

    assert.equal(output.adverseEvent.resourceType, "AdverseEvent");
    assert.equal(output.adverseEvent.suspectEntity?.[0]?.instance.reference, `Procedure/${seriesSession.id}`);
    assertProvenance(output.provenance, `AdverseEvent/${output.adverseEvent.id}`);
  });
});

function assertProvenance(provenance: Provenance | undefined, targetReference: string): void {
  assert.ok(provenance, `Expected Provenance for ${targetReference}.`);
  assert.ok(
    provenance.target.some((target) => target.reference === targetReference),
    `Expected Provenance target ${targetReference}.`,
  );
}
