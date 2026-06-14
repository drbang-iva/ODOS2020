import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AllergyIntolerance,
  BodyStructure,
  CareTeam,
  Condition,
  Encounter,
  EpisodeOfCare,
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
  toolText,
} from "./integration-helpers.js";
import { CONDITION_BODY_SITE_EXTENSION_URL } from "../src/fhir/condition.js";
import { PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL } from "../src/fhir/procedure.js";
import {
  DEFERRED_PROCEDURE_CONCEPT_SYSTEM,
  SCODI_OPTIC_NERVE,
} from "./fixtures/deferred-procedure-constants.js";

interface ToolOutput<T extends object> {
  provenance?: Provenance;
}

type CreateEpisodeOutput = ToolOutput<{}> & { episodeOfCare: EpisodeOfCare };
type CreateConditionOutput = ToolOutput<{}> & { condition: Condition; encounter?: Encounter };
type UpdateConditionTierOutput = ToolOutput<{}> & { condition: Condition; encounter: Encounter };
type CreateAllergyOutput = ToolOutput<{}> & { allergyIntolerance: AllergyIntolerance };
type CreateSmokingOutput = ToolOutput<{}> & { observation: Observation };
type CreateCareTeamOutput = ToolOutput<{}> & { careTeam: CareTeam };
type CreateProcedureOutput = ToolOutput<{}> & { procedure: Procedure };

test("v0.35 MCP write tools create version-aware FHIR resources with Provenance", { timeout: 180_000 }, async (t) => {
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
    name: [{ family: `V035Write${Date.now()}`, given: ["Test"] }],
  });
  assert.ok(patient.id);

  const encounter = await fhir.create<Encounter>({
    resourceType: "Encounter",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${patient.id}` },
    period: { start: "2026-04-25T12:00:00.000Z" },
  });
  assert.ok(encounter.id);

  const bodyStructure = await fhir.create<BodyStructure>({
    resourceType: "BodyStructure",
    active: true,
    location: {
      coding: [{ system: "http://snomed.info/sct", code: "18944008", display: "Right eye" }],
      text: "Right eye",
    },
    patient: { reference: `Patient/${patient.id}` },
  });
  assert.ok(bodyStructure.id);

  const bodyStructureReference = `BodyStructure/${bodyStructure.id}`;
  const mcp = await connectMcpServer({
    baseUrl,
    email,
    password,
    accessToken,
    clientName: "osod-mcp-v035-write-tools-test",
  });
  t.after(async () => {
    await mcp.client.close();
  });

  let episodeOfCare: EpisodeOfCare;
  let encounterDiagnosis: Condition;
  let problemListCondition: Condition;
  let procedure: Procedure;

  await t.test("create_episode_of_care writes EpisodeOfCare and Provenance", async () => {
    const output = parseToolOutput<CreateEpisodeOutput>(
      await mcp.client.callTool({
        name: "create_episode_of_care",
        arguments: {
          patient_id: patient.id,
          type_code: "glaucoma",
          status: "active",
          period_start: "2026-04-25T12:00:00.000Z",
        },
      }),
    );

    episodeOfCare = output.episodeOfCare;
    assert.equal(output.episodeOfCare.patient.reference, `Patient/${patient.id}`);
    assert.equal(output.episodeOfCare.type?.[0]?.coding?.[0]?.code, "glaucoma");
    assertProvenance(output.provenance, `EpisodeOfCare/${output.episodeOfCare.id}`);
  });

  await t.test("update_episode_of_care uses version-aware PATCH", async () => {
    const output = parseToolOutput<CreateEpisodeOutput>(
      await mcp.client.callTool({
        name: "update_episode_of_care",
        arguments: {
          episode_of_care_id: episodeOfCare.id,
          type_code: "dry-eye",
          period_end: "2026-04-25T13:00:00.000Z",
        },
      }),
    );

    episodeOfCare = output.episodeOfCare;
    assert.equal(output.episodeOfCare.type?.[0]?.coding?.[0]?.code, "dry-eye");
    assert.equal(output.episodeOfCare.period?.end, "2026-04-25T13:00:00.000Z");
    assertProvenance(output.provenance, `EpisodeOfCare/${output.episodeOfCare.id}`);
  });

  await t.test("create_condition_with_tier creates encounter diagnosis and Encounter rank", async () => {
    const output = parseToolOutput<CreateConditionOutput>(
      await mcp.client.callTool({
        name: "create_condition_with_tier",
        arguments: {
          patient_id: patient.id,
          encounter_id: encounter.id,
          code_system: "http://hl7.org/fhir/sid/icd-10-cm",
          code: "H40.013",
          code_display: "Open angle with borderline findings, low risk, bilateral",
          tier: 1,
          body_structure_reference: bodyStructureReference,
        },
      }),
    );

    encounterDiagnosis = output.condition;
    assert.equal(output.condition.category?.[0]?.coding?.[0]?.code, "encounter-diagnosis");
    assert.equal(output.condition.encounter?.reference, `Encounter/${encounter.id}`);
    assert.equal(output.encounter?.diagnosis?.[0]?.rank, 1);
    assertProvenance(output.provenance, `Condition/${output.condition.id}`);
  });

  await t.test("update_condition_tier only updates Encounter.diagnosis.rank", async () => {
    const output = parseToolOutput<UpdateConditionTierOutput>(
      await mcp.client.callTool({
        name: "update_condition_tier",
        arguments: {
          condition_id: encounterDiagnosis.id,
          encounter_id: encounter.id,
          tier: 2,
        },
      }),
    );

    assert.equal(output.encounter.diagnosis?.[0]?.rank, 2);
    assert.equal(output.condition.category?.[0]?.coding?.[0]?.code, "encounter-diagnosis");
    assertProvenance(output.provenance, `Encounter/${output.encounter.id}`);
  });

  await t.test("update_condition_body_site patches the standard Condition bodySite extension", async () => {
    const output = parseToolOutput<CreateConditionOutput>(
      await mcp.client.callTool({
        name: "update_condition_body_site",
        arguments: {
          condition_id: encounterDiagnosis.id,
          body_structure_reference: bodyStructureReference,
          body_site_text: "Right eye",
        },
      }),
    );

    encounterDiagnosis = output.condition;
    assert.equal(output.condition.bodySite?.[0]?.extension?.[0]?.url, CONDITION_BODY_SITE_EXTENSION_URL);
    assert.equal(
      output.condition.bodySite?.[0]?.extension?.[0]?.valueReference?.reference,
      bodyStructureReference,
    );
    assertProvenance(output.provenance, `Condition/${output.condition.id}`);
  });

  await t.test("update_condition_code captures prior code in Provenance entity", async () => {
    const output = parseToolOutput<CreateConditionOutput>(
      await mcp.client.callTool({
        name: "update_condition_code",
        arguments: {
          condition_id: encounterDiagnosis.id,
          code_system: "http://hl7.org/fhir/sid/icd-10-cm",
          code: "H40.003",
          code_display: "Preglaucoma, unspecified, bilateral",
        },
      }),
    );

    encounterDiagnosis = output.condition;
    assert.equal(output.condition.code?.coding?.[0]?.code, "H40.003");
    assert.ok(
      JSON.stringify(output.provenance?.entity ?? []).includes("H40.013"),
      "Expected prior code value in Provenance.entity.",
    );
    assertProvenance(output.provenance, `Condition/${output.condition.id}`);
  });

  await t.test("update_condition_status patches clinicalStatus", async () => {
    const output = parseToolOutput<CreateConditionOutput>(
      await mcp.client.callTool({
        name: "update_condition_status",
        arguments: {
          condition_id: encounterDiagnosis.id,
          clinical_status: "resolved",
        },
      }),
    );

    encounterDiagnosis = output.condition;
    assert.equal(output.condition.clinicalStatus?.coding?.[0]?.code, "resolved");
    assertProvenance(output.provenance, `Condition/${output.condition.id}`);
  });

  await t.test("mark_condition_entered_in_error preserves resource and marks verificationStatus", async () => {
    const output = parseToolOutput<CreateConditionOutput>(
      await mcp.client.callTool({
        name: "mark_condition_entered_in_error",
        arguments: { condition_id: encounterDiagnosis.id },
      }),
    );

    const reloaded = await fhir.read<Condition>("Condition", encounterDiagnosis.id!);
    assert.equal(output.condition.id, encounterDiagnosis.id);
    assert.equal(reloaded.verificationStatus?.coding?.[0]?.code, "entered-in-error");
    assert.equal(reloaded.clinicalStatus, undefined);
    assertProvenance(output.provenance, `Condition/${output.condition.id}`);
  });

  await t.test("create_problem_list_condition creates longitudinal Condition", async () => {
    const output = parseToolOutput<CreateConditionOutput>(
      await mcp.client.callTool({
        name: "create_problem_list_condition",
        arguments: {
          patient_id: patient.id,
          code_system: "http://snomed.info/sct",
          code: "73211009",
          code_display: "Diabetes mellitus",
        },
      }),
    );

    problemListCondition = output.condition;
    assert.equal(output.condition.category?.[0]?.coding?.[0]?.code, "problem-list-item");
    assert.equal(output.condition.encounter, undefined);
    assertProvenance(output.provenance, `Condition/${output.condition.id}`);
  });

  await t.test("update_condition_tier rejects problem-list category flips", async () => {
    const result = await mcp.client.callTool({
      name: "update_condition_tier",
      arguments: {
        condition_id: problemListCondition.id,
        encounter_id: encounter.id,
        tier: 1,
      },
    });

    assert.equal(result.isError, true);
    assert.match(toolText(result), /Category changes require creating a new Condition/);
  });

  await t.test("create_allergy_intolerance uses code-first no-known-allergy pattern", async () => {
    const output = parseToolOutput<CreateAllergyOutput>(
      await mcp.client.callTool({
        name: "create_allergy_intolerance",
        arguments: {
          patient_id: patient.id,
          no_known_allergy: true,
        },
      }),
    );

    assert.equal(output.allergyIntolerance.code?.coding?.[0]?.code, "716186003");
    assertProvenance(output.provenance, `AllergyIntolerance/${output.allergyIntolerance.id}`);
  });

  await t.test("create_smoking_status_observation writes LOINC 72166-2", async () => {
    const output = parseToolOutput<CreateSmokingOutput>(
      await mcp.client.callTool({
        name: "create_smoking_status_observation",
        arguments: {
          patient_id: patient.id,
          status_code: "266919005",
          effective_date_time: "2026-04-25T12:30:00.000Z",
        },
      }),
    );

    assert.equal(output.observation.code.coding?.[0]?.code, "72166-2");
    assert.equal(output.observation.valueCodeableConcept?.coding?.[0]?.code, "266919005");
    assertProvenance(output.provenance, `Observation/${output.observation.id}`);
  });

  await t.test("create_care_team prefers PractitionerRole references", async () => {
    const output = parseToolOutput<CreateCareTeamOutput>(
      await mcp.client.callTool({
        name: "create_care_team",
        arguments: {
          patient_id: patient.id,
          participants: [
            {
              role_text: "Primary optometrist",
              practitioner_role_reference: "PractitionerRole/osod-test-role",
              practitioner_reference: "Practitioner/osod-test-practitioner",
            },
          ],
        },
      }),
    );

    assert.equal(output.careTeam.participant?.[0]?.member?.reference, "PractitionerRole/osod-test-role");
    assertProvenance(output.provenance, `CareTeam/${output.careTeam.id}`);
  });

  await t.test("create_procedure writes optional target BodyStructure extension", async () => {
    const output = parseToolOutput<CreateProcedureOutput>(
      await mcp.client.callTool({
        name: "create_procedure",
        arguments: {
          patient_id: patient.id,
          encounter_id: encounter.id,
          status: "completed",
          code_system: DEFERRED_PROCEDURE_CONCEPT_SYSTEM,
          code: SCODI_OPTIC_NERVE.conceptKey,
          body_structure_reference: bodyStructureReference,
        },
      }),
    );

    procedure = output.procedure;
    assert.equal(SCODI_OPTIC_NERVE.cptBinding.status, "deferred-to-licensed-adapter");
    assert.equal(output.procedure.code?.coding?.[0]?.code, "scodi-optic-nerve");
    assert.equal(output.procedure.extension?.[0]?.url, PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL);
    assert.equal(output.procedure.extension?.[0]?.valueReference?.reference, bodyStructureReference);
    assertProvenance(output.provenance, `Procedure/${output.procedure.id}`);
  });

  await t.test("update_procedure_body_site patches procedure-targetBodyStructure extension", async () => {
    const output = parseToolOutput<CreateProcedureOutput>(
      await mcp.client.callTool({
        name: "update_procedure_body_site",
        arguments: {
          procedure_id: procedure.id,
          body_structure_reference: bodyStructureReference,
        },
      }),
    );

    assert.equal(output.procedure.extension?.[0]?.url, PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL);
    assert.equal(output.procedure.extension?.[0]?.valueReference?.reference, bodyStructureReference);
    assertProvenance(output.provenance, `Procedure/${output.procedure.id}`);
  });
});

function assertProvenance(provenance: Provenance | undefined, targetReference: string): void {
  assert.ok(provenance, `Expected Provenance for ${targetReference}.`);
  assert.ok(
    provenance.target.some((target) => target.reference === targetReference),
    `Expected Provenance target ${targetReference}.`,
  );
}
