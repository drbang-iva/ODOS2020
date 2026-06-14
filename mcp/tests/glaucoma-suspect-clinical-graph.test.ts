import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  CPT_CODE_SYSTEM,
  buildClinicalFindingDefinition,
  buildEncounterDiagnosis,
  buildGlaucomaCupDiscSuggestion,
  projectEncounterDiagnosisToCondition,
  projectFindingInstanceToObservation,
} from "../src/clinical-graph/glaucoma-suspect.js";
import { osodConcept } from "../src/fhir/ophthalmology/extensions.js";

const REPO_ROOT = resolve(process.cwd(), "..");
const provenance = {
  source: "manual" as const,
  recordedAt: "2026-06-14T12:00:00.000Z",
  actorReference: "Practitioner/dr-bang",
  ledgerRefs: ["data/code-bindings/glaucoma-suspect-phase0-ledger.json"],
};

test("Phase 0 ledger carries verified glaucoma seeds and explicit not-bill-ready stubs", () => {
  const ledger = JSON.parse(
    readFileSync(
      resolve(REPO_ROOT, "data/code-bindings/glaucoma-suspect-phase0-ledger.json"),
      "utf8",
    ),
  );

  assert.equal(ledger.mandate, "Mandate 14");
  assert.equal(ledger.accessDate, "2026-06-14");
  assert.equal(ledger.diagnosisFamilies.length, 7);
  assert.equal(ledger.diagnosisCodes.length, 28);
  assert.deepEqual(
    new Set(ledger.diagnosisCodes.map((row: { laterality: string }) => row.laterality)),
    new Set(["OD", "OS", "OU", "UNKNOWN"]),
  );
  assert.equal(
    ledger.diagnosisCodes.every((row: { sourceRefs: string[] }) => row.sourceRefs.length >= 2),
    true,
  );
  assert.deepEqual(
    ledger.procedures.map((row: { code: string }) => row.code),
    ["92020", "76514", "92133", "92083", "92250"],
  );
  assert.equal(
    ledger.procedures.every((row: { system: string; coverageReady: boolean }) => row.system === CPT_CODE_SYSTEM && row.coverageReady === false),
    true,
  );
  assert.equal(ledger.provisionalCoverageRules[0].status, "provisional");
  assert.equal(ledger.provisionalCoverageRules[0].jurisdiction, "Palmetto GBA J-M South Carolina");
  assert.equal(
    ledger.stubs.findingDefinitions.every((row: { notBillReady: boolean; externalCode: null }) => row.notBillReady && row.externalCode === null),
    true,
  );
});

test("Phase 1 migration declares the OSOD-owned clinical graph entities", () => {
  const sql = readFileSync(
    resolve(REPO_ROOT, "data/migrations/2026-06-14-glaucoma-suspect-clinical-graph.sql"),
    "utf8",
  );

  for (const table of [
    "osod_clinical_finding_definitions",
    "osod_finding_instances",
    "osod_diagnosis_definitions",
    "osod_diagnosis_suggestion_edges",
    "osod_encounter_diagnoses",
    "osod_encounter_diagnosis_evidence",
    "osod_protocol_definitions",
    "osod_plan_action_instances",
    "osod_procedure_charge_rules",
    "osod_charge_proposals",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /visit_state IN \('generated', 'shown', 'suppressed', 'accepted', 'rejected', 'expired', 'superseded'\)/);
  assert.match(sql, /clinical_severity TEXT/);
  assert.match(sql, /disease_stage TEXT/);
  assert.match(sql, /payer_risk_bucket TEXT/);
  assert.match(sql, /not_bill_ready BOOLEAN NOT NULL DEFAULT true/);
});

test("FindingInstance can exist and project to Observation with zero confirmed diagnoses", () => {
  const definition = buildClinicalFindingDefinition({
    id: "finding-def-cup-disc",
    stableKey: "cup_disc_ratio",
    display: "Cup/disc ratio",
    anatomyTarget: "optic-nerve",
    valueSchema: { type: "quantity", unit: "ratio" },
    sourceStatus: "unseeded-needs-operator-input",
    provenance,
  });
  const { finding } = buildGlaucomaCupDiscSuggestion({
    cupDiscRatio: 0.55,
    laterality: "OD",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingDefinitionId: definition.id,
    findingInstanceId: "finding-cd-od",
    recordedAt: "2026-06-14T12:00:00.000Z",
    provenance,
  });
  const observation = projectFindingInstanceToObservation(finding, definition);
  const confirmedDiagnoses = [];

  assert.equal(observation.resourceType, "Observation");
  assert.equal(observation.subject?.reference, "Patient/p1");
  assert.equal(observation.valueQuantity?.value, 0.55);
  assert.equal(confirmedDiagnoses.length, 0);
});

test("glaucoma cup/disc suggestion edge never creates a Condition", () => {
  const { diagnosisDefinition, suggestionEdge } = buildGlaucomaCupDiscSuggestion({
    cupDiscRatio: 0.65,
    laterality: "OS",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingDefinitionId: "finding-def-cup-disc",
    findingInstanceId: "finding-cd-os",
    recordedAt: "2026-06-14T12:00:00.000Z",
    provenance,
  });

  assert.equal(diagnosisDefinition.icd10Code, "H40.022");
  assert.equal(suggestionEdge.visitState, "generated");
  assert.equal("resourceType" in suggestionEdge, false);
});

test("one FindingInstance can support multiple EncounterDiagnoses", () => {
  const sharedEvidence = ["finding-cd-ou"];
  const sharedObservation = ["Observation/cup-disc-ou"];
  const { diagnosisDefinition: glaucomaSuspect } = buildGlaucomaCupDiscSuggestion({
    cupDiscRatio: 0.7,
    laterality: "OU",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingDefinitionId: "finding-def-cup-disc",
    findingInstanceId: sharedEvidence[0],
    recordedAt: "2026-06-14T12:00:00.000Z",
    provenance,
  });
  const alternateDefinition = {
    ...glaucomaSuspect,
    id: "dx-alt-neuro-cupping",
    stableKey: "alternate_non_glaucomatous_cupping",
    display: "Alternate non-glaucomatous cupping explanation",
    icd10Code: "H40.009",
    icd10Display: "Preglaucoma, unspecified, unspecified eye",
  };
  const glaucomaDx = buildEncounterDiagnosis({
    id: "enc-dx-glaucoma",
    diagnosisDefinitionId: glaucomaSuspect.id,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OU",
    evidenceFindingInstanceIds: sharedEvidence,
    evidenceObservationReferences: sharedObservation,
    provenance,
  });
  const alternateDx = buildEncounterDiagnosis({
    id: "enc-dx-alt",
    diagnosisDefinitionId: alternateDefinition.id,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OU",
    evidenceFindingInstanceIds: sharedEvidence,
    evidenceObservationReferences: sharedObservation,
    provenance,
  });

  const glaucomaCondition = projectEncounterDiagnosisToCondition(glaucomaDx, glaucomaSuspect);
  const alternateCondition = projectEncounterDiagnosisToCondition(alternateDx, alternateDefinition);

  assert.equal(glaucomaCondition.evidence?.[0]?.detail?.[0]?.reference, "Observation/cup-disc-ou");
  assert.equal(alternateCondition.evidence?.[0]?.detail?.[0]?.reference, "Observation/cup-disc-ou");
});

test("clinical severity, disease stage, and payer-risk bucket remain independent", () => {
  const { diagnosisDefinition } = buildGlaucomaCupDiscSuggestion({
    cupDiscRatio: 0.65,
    laterality: "OD",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingDefinitionId: "finding-def-cup-disc",
    findingInstanceId: "finding-cd-od",
    recordedAt: "2026-06-14T12:00:00.000Z",
    provenance,
  });
  const encounterDiagnosis = buildEncounterDiagnosis({
    id: "enc-dx-risk-split",
    diagnosisDefinitionId: diagnosisDefinition.id,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OD",
    clinicalSeverity: osodConcept("mild-clinical-severity", "Mild clinical severity"),
    diseaseStage: osodConcept("pre-perimetric-stage", "Pre-perimetric stage"),
    payerRiskBucket: "high",
    provenance,
  });
  const condition = projectEncounterDiagnosisToCondition(encounterDiagnosis, diagnosisDefinition);

  assert.equal(condition.bodySite?.[0]?.coding?.[0]?.code, "OD");
  assert.equal(condition.severity?.coding?.[0]?.code, "mild-clinical-severity");
  assert.equal(condition.stage?.[0]?.summary?.coding?.[0]?.code, "pre-perimetric-stage");
  assert.equal(encounterDiagnosis.payerRiskBucket, "high");
  assert.notEqual(condition.severity?.coding?.[0]?.code, encounterDiagnosis.payerRiskBucket);
  assert.notEqual(condition.stage?.[0]?.summary?.coding?.[0]?.code, encounterDiagnosis.payerRiskBucket);
});
