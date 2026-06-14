import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  CPT_CODE_SYSTEM,
  buildClinicalFindingDefinition,
  buildDiagnosisDefinition,
  buildEncounterDiagnosis,
  buildGlaucomaFindingDefinitionStubs,
  buildGlaucomaCupDiscSuggestion,
  buildGlaucomaOpenAngleDiagnosisDefinition,
  captureGlaucomaFinding,
  evaluateGlaucomaDiagnosisSuggestions,
  projectEncounterDiagnosisToCondition,
  projectFindingInstanceToObservation,
  rejectDiagnosisSuggestionEdge,
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
    ledger.procedures.map((row: { conceptKey: string }) => row.conceptKey),
    ["gonioscopy", "corneal-pachymetry", "scodi-optic-nerve", "visual-field-threshold", "fundus-photography"],
  );
  assert.equal(
    ledger.procedures.every((row: { cptBinding: { status: string; system: string }; coverageReady: boolean }) =>
      row.cptBinding.status === "deferred-to-licensed-adapter" &&
      row.cptBinding.system === CPT_CODE_SYSTEM &&
      row.coverageReady === false),
    true,
  );
  assert.equal(ledger.procedures.every((row: { code?: string; cmsPfsShortDescriptor?: string }) => row.code === undefined && row.cmsPfsShortDescriptor === undefined), true);
  assert.equal(ledger.provisionalCoverageRules[0].status, "provisional");
  assert.equal(ledger.provisionalCoverageRules[0].procedureCode, "scodi-optic-nerve");
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
  assert.match(sql, /verification_status TEXT NOT NULL DEFAULT 'unconfirmed'/);
  assert.match(sql, /confirmed_at TIMESTAMPTZ,/);
  assert.match(sql, /CONSTRAINT encounter_diagnosis_confirmation_gate CHECK/);
  assert.match(sql, /CONSTRAINT verified_diagnosis_requires_icd10_code CHECK/);
});

test("Phase 2 and 3 migration adds evidence capture and unreviewed suggestion fields", () => {
  const sql = readFileSync(
    resolve(REPO_ROOT, "data/migrations/2026-06-14-glaucoma-suspect-evidence-suggestions.sql"),
    "utf8",
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS method JSONB/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS performer_references TEXT\[\] NOT NULL DEFAULT '\{\}'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS source_references TEXT\[\] NOT NULL DEFAULT '\{\}'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS score NUMERIC\(6,3\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS evidence_finding_instance_ids UUID\[\] NOT NULL DEFAULT '\{\}'/);
  assert.match(sql, /ALTER COLUMN visit_state SET DEFAULT 'unreviewed'/);
  assert.match(sql, /visit_state IN \('unreviewed', 'generated', 'shown', 'suppressed', 'accepted', 'rejected', 'expired', 'superseded'\)/);
});

test("glaucoma finding definitions stay operator-gated stubs except the canon cup-disc predicate", () => {
  const definitions = buildGlaucomaFindingDefinitionStubs({ provenance });
  const byKey = new Map(definitions.map((definition) => [definition.stableKey, definition]));
  const cupDisc = byKey.get("cup_disc_ratio");

  assert.deepEqual(
    definitions.map((definition) => definition.stableKey),
    ["cup_disc_ratio", "intraocular_pressure", "pachymetry_um", "rnfl_gcc"],
  );
  assert.equal(definitions.every((definition) => definition.sourceStatus === "unseeded-needs-operator-input"), true);
  assert.equal(definitions.every((definition) => definition.notBillReady), true);
  assert.equal(definitions.every((definition) => definition.fhirObservationCode === undefined), true);
  assert.match(String(cupDisc?.valueSchema.units), /TODO: operator input required/);
  assert.deepEqual(cupDisc?.valueSchema.seededPredicateExamples, [
    {
      predicateKey: "glaucoma_suspect_cup_disc_threshold_v0",
      threshold: 0.6,
      source: "canon Phase-1 predicate example",
    },
  ]);
  assert.deepEqual(byKey.get("intraocular_pressure")?.valueSchema.seededPredicateExamples, []);
});

test("Phase 2 capture projects standalone glaucoma evidence to Observation plus Provenance", () => {
  const definition = buildGlaucomaFindingDefinitionStubs({ provenance })
    .find((row) => row.stableKey === "cup_disc_ratio");
  assert.ok(definition);

  const captured = captureGlaucomaFinding({
    definition,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-cd-od-runtime",
    observationId: "observation-cd-od-runtime",
    laterality: "OD",
    value: { type: "quantity", value: 0.64, unit: "ratio", code: "1" },
    method: osodConcept("manual-entry", "Manual entry"),
    performerReferences: ["Practitioner/dr-bang"],
    recordedAt: "2026-06-14T13:00:00.000Z",
    provenance,
  });
  const confirmedDiagnoses = [];

  assert.equal(captured.finding.laterality, "OD");
  assert.equal(captured.finding.observationReference, "Observation/observation-cd-od-runtime");
  assert.equal(captured.observation.resourceType, "Observation");
  assert.equal(captured.observation.id, "observation-cd-od-runtime");
  assert.equal(captured.observation.valueQuantity?.value, 0.64);
  assert.equal(captured.observation.bodySite?.coding?.[0]?.code, "OD");
  assert.equal(captured.observation.method?.coding?.[0]?.code, "manual-entry");
  assert.equal(captured.observation.performer?.[0]?.reference, "Practitioner/dr-bang");
  assert.equal(captured.observation.effectiveDateTime, "2026-06-14T13:00:00.000Z");
  assert.equal(captured.provenance.resourceType, "Provenance");
  assert.equal(captured.provenance.target[0]?.reference, "Observation/observation-cd-od-runtime");
  assert.equal(confirmedDiagnoses.length, 0);
});

test("Phase 2 capture supports component Observations without seeded RNFL/GCC thresholds", () => {
  const definition = buildGlaucomaFindingDefinitionStubs({ provenance })
    .find((row) => row.stableKey === "rnfl_gcc");
  assert.ok(definition);

  const captured = captureGlaucomaFinding({
    definition,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-rnfl-gcc-od",
    laterality: "OD",
    value: {
      type: "components",
      components: [
        {
          code: "operator-provided-rnfl-measurement",
          display: "Operator-provided RNFL measurement",
          value: "operator-provided measurement pending unit binding",
        },
      ],
    },
    recordedAt: "2026-06-14T13:05:00.000Z",
    provenance,
  });

  assert.equal(definition.notBillReady, true);
  assert.match(String(definition.valueSchema.normalRange), /TODO: operator input required/);
  assert.equal(captured.observation.component?.length, 1);
  assert.equal(
    captured.observation.component?.[0]?.valueString,
    "operator-provided measurement pending unit binding",
  );
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
  assert.equal(suggestionEdge.visitState, "unreviewed");
  assert.equal(suggestionEdge.score, 0.8);
  assert.deepEqual(suggestionEdge.evidenceFindingInstanceIds, ["finding-cd-os"]);
  assert.equal("resourceType" in suggestionEdge, false);
});

test("Phase 3 pure evaluator turns large C/D into an unreviewed suggestion, not a Condition", () => {
  const definitions = buildGlaucomaFindingDefinitionStubs({ provenance });
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const captured = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-ms-cupping-od",
    laterality: "OD",
    value: { type: "quantity", value: 0.72, unit: "ratio", code: "1" },
    recordedAt: "2026-06-14T13:10:00.000Z",
    provenance,
  });
  const conditions = [];
  const suggestions = evaluateGlaucomaDiagnosisSuggestions({
    findings: [captured.finding],
    findingDefinitions: definitions,
    encounterReference: "Encounter/e1",
    provenance,
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].diagnosisDefinition.icd10Code, "H40.021");
  assert.equal(suggestions[0].suggestionEdge.visitState, "unreviewed");
  assert.equal(suggestions[0].suggestionEdge.targetDiagnosisDefinitionId, suggestions[0].diagnosisDefinition.id);
  assert.deepEqual(suggestions[0].suggestionEdge.evidenceFindingInstanceIds, ["finding-ms-cupping-od"]);
  assert.equal("resourceType" in suggestions[0].suggestionEdge, false);
  assert.equal(conditions.length, 0);
});

test("rejecting the large-C/D glaucoma suggestion leaves the finding and no glaucoma Condition", () => {
  const definitions = buildGlaucomaFindingDefinitionStubs({ provenance });
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const captured = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-ms-cupping-os",
    laterality: "OS",
    value: { type: "quantity", value: 0.74, unit: "ratio", code: "1" },
    recordedAt: "2026-06-14T13:15:00.000Z",
    provenance,
  });
  const [suggestion] = evaluateGlaucomaDiagnosisSuggestions({
    findings: [captured.finding],
    findingDefinitions: definitions,
    provenance,
  });
  const rejected = rejectDiagnosisSuggestionEdge(suggestion.suggestionEdge, {
    rejectedAt: "2026-06-14T13:16:00.000Z",
    provenance,
    reason: "Large cup/disc retained as neutral evidence for non-glaucomatous cupping differential.",
  });
  const findings = [captured.finding];
  const glaucomaConditions = [];

  assert.equal(rejected.visitState, "rejected");
  assert.equal(rejected.rejectedAt, "2026-06-14T13:16:00.000Z");
  assert.equal(findings.some((finding) => finding.id === "finding-ms-cupping-os"), true);
  assert.equal(glaucomaConditions.length, 0);
});

test("Phase 3 evaluator is pure and deterministic over the same evidence", () => {
  const definitions = buildGlaucomaFindingDefinitionStubs({ provenance });
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const captured = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-pure-ou",
    laterality: "OU",
    value: { type: "quantity", value: 0.61, unit: "ratio", code: "1" },
    recordedAt: "2026-06-14T13:20:00.000Z",
    provenance,
  });
  const first = evaluateGlaucomaDiagnosisSuggestions({
    findings: [captured.finding],
    findingDefinitions: definitions,
    provenance,
  });
  const second = evaluateGlaucomaDiagnosisSuggestions({
    findings: [captured.finding],
    findingDefinitions: definitions,
    provenance,
  });
  const conditions = [];

  assert.deepEqual(second, first);
  assert.equal(first[0].suggestionEdge.id, "suggestion-finding-pure-ou-glaucoma-suspect-open-angle-high-ou");
  assert.equal(first[0].diagnosisDefinition.id, "dx-def-glaucoma-suspect-open-angle-high-ou");
  assert.equal(conditions.length, 0);
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
    verificationStatus: "confirmed",
    confirmedAt: provenance.recordedAt,
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
    verificationStatus: "confirmed",
    confirmedAt: provenance.recordedAt,
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
    verificationStatus: "confirmed",
    confirmedAt: provenance.recordedAt,
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

test("Condition projection requires explicit confirmed EncounterDiagnosis", () => {
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
  const base = {
    id: "enc-dx-confirm-gate",
    diagnosisDefinitionId: diagnosisDefinition.id,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OD" as const,
    evidenceObservationReferences: ["Observation/cup-disc-od"],
    provenance,
  };
  const unconfirmed = buildEncounterDiagnosis(base);
  const provisional = buildEncounterDiagnosis({ ...base, id: "enc-dx-provisional", verificationStatus: "provisional" });
  const confirmed = buildEncounterDiagnosis({
    ...base,
    id: "enc-dx-confirmed",
    verificationStatus: "confirmed",
    confirmedAt: provenance.recordedAt,
  });

  assert.equal(unconfirmed.verificationStatus, "unconfirmed");
  assert.equal(unconfirmed.confirmedAt, undefined);
  assert.throws(
    () => projectEncounterDiagnosisToCondition(unconfirmed, diagnosisDefinition),
    /Only confirmed EncounterDiagnosis rows can project to FHIR Condition/,
  );
  assert.throws(
    () => projectEncounterDiagnosisToCondition(provisional, diagnosisDefinition),
    /Only confirmed EncounterDiagnosis rows can project to FHIR Condition/,
  );
  assert.equal(projectEncounterDiagnosisToCondition(confirmed, diagnosisDefinition).resourceType, "Condition");
  assert.throws(
    () => buildEncounterDiagnosis({ ...base, id: "enc-dx-bad-confirmed", verificationStatus: "confirmed" }),
    /Confirmed EncounterDiagnosis requires confirmedAt/,
  );
  assert.throws(
    () => buildEncounterDiagnosis({ ...base, id: "enc-dx-bad-unconfirmed", confirmedAt: provenance.recordedAt }),
    /Only confirmed EncounterDiagnosis rows can carry confirmedAt/,
  );
});

test("provisional coverage rule diagnosis families resolve to declared ledger keys", () => {
  const ledger = JSON.parse(
    readFileSync(
      resolve(REPO_ROOT, "data/code-bindings/glaucoma-suspect-phase0-ledger.json"),
      "utf8",
    ),
  );
  const declaredFamilies = new Set(ledger.diagnosisFamilies.map((row: { family: string }) => row.family));
  const ruleFamilies = ledger.provisionalCoverageRules[0].diagnosisFamilies;

  assert.deepEqual(ruleFamilies, Array.from(declaredFamilies));
  assert.equal(ruleFamilies.every((family: string) => declaredFamilies.has(family)), true);
});

test("verified DiagnosisDefinition requires an ICD-10-CM code", () => {
  assert.throws(
    () => buildDiagnosisDefinition({
      stableKey: "missing_verified_code",
      display: "Missing verified code",
      clinicalFamily: "glaucoma-suspect",
      codingStatus: "verified",
      lateralityRequired: true,
      provenance,
    }),
    /Verified DiagnosisDefinition requires an ICD-10-CM code/,
  );
});

test("glaucoma open-angle diagnosis verifies only through the Phase 0 ledger", () => {
  const verified = buildGlaucomaOpenAngleDiagnosisDefinition({
    laterality: "OD",
    riskBucket: "low",
    provenance,
  });
  const placeholder = buildGlaucomaOpenAngleDiagnosisDefinition({
    laterality: "OD",
    riskBucket: "low",
    provenance,
    ledger: { diagnosisCodes: [] },
  });

  assert.equal(verified.codingStatus, "verified");
  assert.equal(verified.icd10Code, "H40.011");
  assert.equal(verified.icd10Display, "Open angle with borderline findings, low risk, right eye");
  assert.equal(placeholder.codingStatus, "placeholder");
  assert.equal(placeholder.icd10Code, undefined);
  assert.match(placeholder.provenance.note ?? "", /Mandate-14 TODO/);
});
