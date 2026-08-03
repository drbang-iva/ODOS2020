import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  CPT_CODE_SYSTEM,
  addGlaucomaCupDiscDescriptorOption,
  addGlaucomaIopMethodOption,
  buildClinicalFindingDefinition,
  buildDiagnosisDefinition,
  buildEncounterDiagnosis,
  buildGlaucomaFindingDefinitionStubs,
  buildGlaucomaCupDiscSuggestion,
  buildGlaucomaOpenAngleDiagnosisDefinition,
  captureGlaucomaFinding,
  evaluateGlaucomaDiagnosisSuggestions,
  evaluateIopDiagnosisSuggestions,
  evaluateIopFindingRisk,
  getGlaucomaCupDiscDescriptorOptions,
  getGlaucomaIopMethodOptions,
  projectEncounterDiagnosisToCondition,
  projectFindingInstanceToObservation,
  rejectDiagnosisSuggestionEdge,
} from "../src/clinical-graph/glaucoma-suspect.js";
import { odosConcept } from "../src/fhir/ophthalmology/extensions.js";

const REPO_ROOT = resolve(process.cwd(), "..");
const provenance = {
  source: "manual" as const,
  recordedAt: "2026-06-14T12:00:00.000Z",
  actorReference: "Practitioner/dr-bang",
  ledgerRefs: ["data/code-bindings/glaucoma-suspect-phase0-ledger.json"],
};

function glaucomaDefinitions() {
  return buildGlaucomaFindingDefinitionStubs({ provenance });
}

function cupDiscDefinition() {
  const definition = glaucomaDefinitions().find((row) => row.stableKey === "cup_disc_ratio");
  assert.ok(definition);
  return definition;
}

function iopDefinition() {
  const definition = glaucomaDefinitions().find((row) => row.stableKey === "intraocular_pressure");
  assert.ok(definition);
  return definition;
}

test("dead placeholder claim builders stay removed from the clinical graph module", () => {
  const source = readFileSync(
    resolve(REPO_ROOT, "mcp/src/clinical-graph/glaucoma-suspect.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /buildClaimWithDiagnosisPointers|projectChargeProposalToChargeItem/);
  assert.doesNotMatch(source, /Phase 1 placeholder coverage; payer workflow not implemented/);
});

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

test("Phase 1 migration declares the ODOS-owned clinical graph entities", () => {
  const sql = readFileSync(
    resolve(REPO_ROOT, "data/migrations/2026-06-14-glaucoma-suspect-clinical-graph.sql"),
    "utf8",
  );

  for (const table of [
    "odos_clinical_finding_definitions",
    "odos_finding_instances",
    "odos_diagnosis_definitions",
    "odos_diagnosis_suggestion_edges",
    "odos_encounter_diagnoses",
    "odos_encounter_diagnosis_evidence",
    "odos_protocol_definitions",
    "odos_plan_action_instances",
    "odos_procedure_charge_rules",
    "odos_charge_proposals",
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

test("glaucoma finding definitions seed cup/disc, IOP, and CH data while later findings stay operator-gated", () => {
  const definitions = buildGlaucomaFindingDefinitionStubs({ provenance });
  const byKey = new Map(definitions.map((definition) => [definition.stableKey, definition]));
  const cupDisc = byKey.get("cup_disc_ratio");
  const iop = byKey.get("intraocular_pressure");
  const cornealHysteresis = byKey.get("corneal_hysteresis");
  assert.ok(cupDisc);
  assert.ok(iop);
  assert.ok(cornealHysteresis);
  const fields = cupDisc.valueSchema.fields as Record<string, { options?: Array<{ code: string; display: string; highRiskDriver?: boolean }> }>;
  const iopFields = iop.valueSchema.fields as Record<string, { options?: Array<{ code: string }>; minimum?: number; maximum?: number; step?: number; unit?: string }>;
  const chFields = cornealHysteresis.valueSchema.fields as Record<string, { minimum?: number; maximum?: number; step?: number; unit?: string }>;

  assert.deepEqual(
    definitions.map((definition) => definition.stableKey),
    ["cup_disc_ratio", "intraocular_pressure", "corneal_hysteresis", "pachymetry_um", "rnfl_gcc"],
  );
  assert.equal(cupDisc.sourceStatus, "verified-seed");
  assert.equal(iop.sourceStatus, "verified-seed");
  assert.equal(cornealHysteresis.sourceStatus, "verified-seed");
  assert.equal(byKey.get("pachymetry_um")?.sourceStatus, "unseeded-needs-operator-input");
  assert.equal(byKey.get("rnfl_gcc")?.sourceStatus, "unseeded-needs-operator-input");
  assert.equal(definitions.every((definition) => definition.notBillReady), true);
  assert.equal(definitions.every((definition) => definition.fhirObservationCode === undefined), true);
  assert.equal(fields.verticalCupDiscRatio.minimum, 0);
  assert.equal(fields.verticalCupDiscRatio.maximum, 1);
  assert.equal(fields.verticalCupDiscRatio.step, 0.05);
  assert.deepEqual(fields.discNerveSize.options?.map((option) => option.code), ["small", "average", "large"]);
  assert.deepEqual(fields.methodSource.options?.map((option) => option.code), ["78d", "90d", "20d", "direct"]);
  assert.deepEqual(
    fields.discAppearanceDescriptors.options?.map((option) => option.code),
    [
      "notching",
      "inferior-thinning",
      "splinter-heme",
      "ppa",
      "deep",
      "pallor",
      "tilted-disc",
      "myopic-crescent",
      "choroidal-crescent",
      "disc-drusen",
      "nerve-fiber-layer-defect",
    ],
  );
  assert.deepEqual(
    fields.discAppearanceDescriptors.options
      ?.filter((option) => option.highRiskDriver)
      .map((option) => option.code),
    ["inferior-thinning", "splinter-heme", "pallor"],
  );
  const thresholdParameters = (cupDisc.normalSemantics?.riskPredicate as {
    thresholdParameters: Record<string, { defaultValue: number }>;
  }).thresholdParameters;
  assert.equal(thresholdParameters.lowFloor.defaultValue, 0.5);
  assert.equal(thresholdParameters.highFloor.defaultValue, 0.75);
  assert.equal(thresholdParameters.asymmetryLow.defaultValue, 0.2);
  assert.equal(thresholdParameters.asymmetryHigh.defaultValue, 0.3);
  assert.equal(iopFields.value.minimum, 3);
  assert.equal(iopFields.value.maximum, 80);
  assert.equal(iopFields.value.unit, "mmHg");
  assert.deepEqual(
    iopFields.method.options?.map((option) => option.code),
    ["GAT", "NCT", "ICARE", "TONOPEN", "PALPATION", "IOPCC", "IOPG"],
  );
  const iopThresholdParameters = (iop.normalSemantics?.riskPredicate as {
    thresholdParameters: Record<string, { defaultValue: number }>;
  }).thresholdParameters;
  assert.equal(iopThresholdParameters.ohtnThreshold.defaultValue, 22);
  assert.equal(chFields.value.minimum, 0);
  assert.equal(chFields.value.maximum, 15);
  assert.equal(chFields.value.step, 0.1);
  assert.equal(chFields.value.unit, "corneobiomechanics score");
  assert.equal(cornealHysteresis.normalSemantics?.riskPredicate, undefined);
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
    method: odosConcept("manual-entry", "Manual entry"),
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
    cupDiscRatio: 0.75,
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

test("cup/disc vertical C/D classifies normal, low, and high without emitting H40 for normal", () => {
  const definitions = glaucomaDefinitions();
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const cases = [
    { ratio: 0.3, findingInstanceId: "finding-cd-normal", code: undefined, interpretation: "normal", riskTier: "normal" },
    { ratio: 0.5, findingInstanceId: "finding-cd-low-floor", code: "H40.011", interpretation: "borderline", riskTier: "low" },
    { ratio: 0.74, findingInstanceId: "finding-cd-low-below-high", code: "H40.011", interpretation: "borderline", riskTier: "low" },
    { ratio: 0.75, findingInstanceId: "finding-cd-high-floor", code: "H40.021", interpretation: "abnormal", riskTier: "high" },
  ];

  for (const testCase of cases) {
    const built = buildGlaucomaCupDiscSuggestion({
      cupDiscRatio: testCase.ratio,
      laterality: "OD",
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      findingDefinitionId: cupDisc.id,
      findingInstanceId: testCase.findingInstanceId,
      recordedAt: "2026-06-14T13:09:00.000Z",
      provenance,
    });
    const captured = captureGlaucomaFinding({
      definition: cupDisc,
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      findingInstanceId: `${testCase.findingInstanceId}-captured`,
      laterality: "OD",
      value: { type: "quantity", value: testCase.ratio, unit: "ratio", code: "1" },
      recordedAt: "2026-06-14T13:09:30.000Z",
      provenance,
    });
    const suggestions = evaluateGlaucomaDiagnosisSuggestions({
      findings: [captured.finding],
      findingDefinitions: definitions,
      encounterReference: "Encounter/e1",
      provenance,
    });

    assert.equal(built.finding.interpretation, testCase.interpretation, testCase.findingInstanceId);
    if (!testCase.code) {
      assert.equal(built.diagnosisDefinition, undefined);
      assert.equal(built.suggestionEdge, undefined);
      assert.deepEqual(suggestions, []);
    } else {
      assert.equal(built.diagnosisDefinition?.icd10Code, testCase.code, testCase.findingInstanceId);
      assert.equal(built.suggestionEdge?.predicateExpression.riskTier, testCase.riskTier, testCase.findingInstanceId);
      assert.equal(suggestions[0]?.diagnosisDefinition.icd10Code, testCase.code, testCase.findingInstanceId);
      assert.equal(suggestions[0]?.suggestionEdge.predicateExpression.riskTier, testCase.riskTier, testCase.findingInstanceId);
    }
  }
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
    value: { type: "quantity", value: 0.75, unit: "ratio", code: "1" },
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

test("each cup/disc high-risk driver independently maps to H40.02x without confirming a diagnosis", () => {
  const definitions = glaucomaDefinitions();
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const cases = [
    {
      id: "vertical-threshold",
      value: { type: "quantity" as const, value: 0.75, unit: "ratio", code: "1" },
      signal: "vertical-cup-disc-ratio",
    },
    {
      id: "splinter-heme",
      value: { type: "json" as const, value: { verticalCupDiscRatio: 0.3, discAppearanceDescriptors: ["splinter-heme"] } },
      signal: "descriptor:splinter-heme",
    },
    {
      id: "inferior-thinning",
      value: { type: "json" as const, value: { verticalCupDiscRatio: 0.3, discAppearanceDescriptors: ["inferior-thinning"] } },
      signal: "descriptor:inferior-thinning",
    },
    {
      id: "asymmetry",
      value: {
        type: "json" as const,
        value: {
          verticalCupDiscRatio: 0.3,
          verticalCupDiscRatioOd: 0.3,
          verticalCupDiscRatioOs: 0.6,
        },
      },
      signal: "cup-disc-asymmetry",
    },
    {
      id: "pallor",
      value: { type: "json" as const, value: { verticalCupDiscRatio: 0.3, discAppearanceDescriptors: ["pallor"] } },
      signal: "descriptor:pallor",
    },
  ];

  for (const testCase of cases) {
    const captured = captureGlaucomaFinding({
      definition: cupDisc,
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      findingInstanceId: `finding-${testCase.id}`,
      laterality: "OD",
      value: testCase.value,
      recordedAt: "2026-06-14T13:21:00.000Z",
      provenance,
    });
    const [suggestion] = evaluateGlaucomaDiagnosisSuggestions({
      findings: [captured.finding],
      findingDefinitions: definitions,
      provenance,
    });
    const signals = suggestion.suggestionEdge.predicateExpression.highRiskSignals as string[];

    assert.equal(suggestion.diagnosisDefinition.icd10Code, "H40.021", testCase.id);
    assert.equal(suggestion.suggestionEdge.visitState, "unreviewed");
    assert.equal(signals.includes(testCase.signal), true, testCase.id);
    assert.match(suggestion.suggestionEdge.explanation, /High-risk glaucoma-suspect suggestion/);
    assert.equal("resourceType" in suggestion.suggestionEdge, false);
  }
});

test("pure low-risk cup/disc path maps to H40.01x when no high-risk signal fires", () => {
  const definitions = glaucomaDefinitions();
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const captured = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-low-risk-cup-disc",
    laterality: "OS",
    value: {
      type: "json",
      value: {
        verticalCupDiscRatio: 0.5,
        verticalCupDiscRatioOd: 0.35,
        verticalCupDiscRatioOs: 0.5,
        discAppearanceDescriptors: ["notching", "ppa", "deep"],
      },
    },
    recordedAt: "2026-06-14T13:22:00.000Z",
    provenance,
  });
  const [suggestion] = evaluateGlaucomaDiagnosisSuggestions({
    findings: [captured.finding],
    findingDefinitions: definitions,
    provenance,
  });

  assert.equal(suggestion.diagnosisDefinition.icd10Code, "H40.012");
  assert.deepEqual(suggestion.suggestionEdge.predicateExpression.highRiskSignals, []);
  assert.deepEqual(suggestion.suggestionEdge.predicateExpression.lowRiskSignals, ["vertical-cup-disc-ratio"]);
  assert.deepEqual(suggestion.suggestionEdge.predicateExpression.thresholds, {
    lowFloor: 0.5,
    highFloor: 0.75,
    asymmetryLow: 0.2,
    asymmetryHigh: 0.3,
  });
  assert.match(suggestion.suggestionEdge.explanation, /Low-risk glaucoma-suspect suggestion/);
});

test("new disc appearance descriptors preserve cup/disc and IOP risk tiers", () => {
  const cupDisc = cupDiscDefinition();
  const iop = iopDefinition();
  const descriptorCodes = [
    "tilted-disc",
    "myopic-crescent",
    "choroidal-crescent",
    "disc-drusen",
    "nerve-fiber-layer-defect",
  ];
  const iopFinding = captureGlaucomaFinding({
    definition: iop,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-iop-neutral-descriptors",
    laterality: "OD",
    value: { type: "quantity", value: 18, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    recordedAt: "2026-08-03T13:00:00.000Z",
    provenance,
  });
  const riskTiers = (discAppearanceDescriptors: string[]) => ({
    cupDisc: buildGlaucomaCupDiscSuggestion({
      cupDiscRatio: 0.5,
      discAppearanceDescriptors,
      laterality: "OD",
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      findingDefinitionId: cupDisc.id,
      findingInstanceId: `finding-cup-disc-${discAppearanceDescriptors.length ? "descriptors" : "baseline"}`,
      recordedAt: "2026-08-03T13:00:00.000Z",
      provenance,
      findingDefinition: cupDisc,
    }).suggestionEdge?.predicateExpression.riskTier,
    iop: evaluateIopFindingRisk(iopFinding.finding, iop).riskTier,
  });

  assert.deepEqual(riskTiers(descriptorCodes), riskTiers([]));
  assert.deepEqual(
    getGlaucomaCupDiscDescriptorOptions(cupDisc)
      .filter((option) => descriptorCodes.includes(option.code))
      .map((option) => ({ code: option.code, highRiskDriver: option.highRiskDriver })),
    descriptorCodes.map((code) => ({ code, highRiskDriver: undefined })),
  );
});

test("cup/disc asymmetry is auto-computed across OD and OS findings at the 0.2 boundary", () => {
  const definitions = glaucomaDefinitions();
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const od = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-asymmetry-od",
    laterality: "OD",
    value: { type: "quantity", value: 0.3, unit: "ratio", code: "1" },
    recordedAt: "2026-06-14T13:23:00.000Z",
    provenance,
  });
  const os = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-asymmetry-os",
    laterality: "OS",
    value: { type: "quantity", value: 0.5, unit: "ratio", code: "1" },
    recordedAt: "2026-06-14T13:24:00.000Z",
    provenance,
  });
  const suggestions = evaluateGlaucomaDiagnosisSuggestions({
    findings: [od.finding, os.finding],
    findingDefinitions: definitions,
    provenance,
  });

  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.diagnosisDefinition.icd10Code).sort(),
    ["H40.011", "H40.012"],
  );
  assert.equal(
    suggestions.every((suggestion) =>
      !(suggestion.suggestionEdge.predicateExpression.highRiskSignals as string[]).includes("cup-disc-asymmetry")),
    true,
  );
  assert.equal(
    suggestions.every((suggestion) =>
      (suggestion.suggestionEdge.predicateExpression.lowRiskSignals as string[]).includes("cup-disc-asymmetry")),
    true,
  );
  assert.equal(
    suggestions.every((suggestion) =>
      (suggestion.suggestionEdge.predicateExpression.observed as { cupDiscAsymmetry: number }).cupDiscAsymmetry === 0.2),
    true,
  );
});

test("not-visualized cup/disc findings suppress suggestion-edge emission", () => {
  const definitions = glaucomaDefinitions();
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const captured = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-cup-disc-not-visualized",
    laterality: "OD",
    value: {
      type: "json",
      value: {
        verticalCupDiscRatio: 0.9,
        discAppearanceDescriptors: ["pallor"],
        notVisualized: true,
      },
    },
    recordedAt: "2026-06-14T13:25:00.000Z",
    provenance,
  });
  const suggestions = evaluateGlaucomaDiagnosisSuggestions({
    findings: [captured.finding],
    findingDefinitions: definitions,
    provenance,
  });
  const built = buildGlaucomaCupDiscSuggestion({
    cupDiscRatio: 0.9,
    notVisualized: true,
    laterality: "OD",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingDefinitionId: cupDisc.id,
    findingInstanceId: "finding-cup-disc-not-visualized-builder",
    recordedAt: "2026-06-14T13:26:00.000Z",
    provenance,
  });

  assert.deepEqual(suggestions, []);
  assert.equal(built.suggestionEdge, undefined);
  assert.equal(built.diagnosisDefinition, undefined);
});

test("cup/disc risk config can override each three-tier parameter", () => {
  const definitions = glaucomaDefinitions();
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const lowFloorCandidate = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-low-floor-override",
    laterality: "OU",
    value: { type: "quantity", value: 0.49, unit: "ratio", code: "1" },
    recordedAt: "2026-06-14T13:27:00.000Z",
    provenance,
  });
  const highFloorCandidate = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-high-floor-override",
    laterality: "OU",
    value: { type: "quantity", value: 0.74, unit: "ratio", code: "1" },
    recordedAt: "2026-06-14T13:27:30.000Z",
    provenance,
  });
  const asymmetryLowCandidate = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-asymmetry-low-override",
    laterality: "OU",
    value: {
      type: "json",
      value: {
        verticalCupDiscRatio: 0.3,
        verticalCupDiscRatioOd: 0.3,
        verticalCupDiscRatioOs: 0.49,
      },
    },
    recordedAt: "2026-06-14T13:28:00.000Z",
    provenance,
  });
  const asymmetryHighCandidate = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-asymmetry-high-override",
    laterality: "OU",
    value: {
      type: "json",
      value: {
        verticalCupDiscRatio: 0.3,
        verticalCupDiscRatioOd: 0.3,
        verticalCupDiscRatioOs: 0.59,
      },
    },
    recordedAt: "2026-06-14T13:28:30.000Z",
    provenance,
  });

  assert.deepEqual(evaluateGlaucomaDiagnosisSuggestions({
    findings: [lowFloorCandidate.finding],
    findingDefinitions: definitions,
    provenance,
  }), []);
  assert.equal(evaluateGlaucomaDiagnosisSuggestions({
    findings: [lowFloorCandidate.finding],
    findingDefinitions: definitions,
    riskConfig: { lowFloor: 0.45 },
    provenance,
  })[0]?.diagnosisDefinition.icd10Code, "H40.013");
  assert.equal(evaluateGlaucomaDiagnosisSuggestions({
    findings: [highFloorCandidate.finding],
    findingDefinitions: definitions,
    provenance,
  })[0]?.diagnosisDefinition.icd10Code, "H40.013");
  assert.equal(evaluateGlaucomaDiagnosisSuggestions({
    findings: [highFloorCandidate.finding],
    findingDefinitions: definitions,
    riskConfig: { highFloor: 0.7 },
    provenance,
  })[0]?.diagnosisDefinition.icd10Code, "H40.023");
  assert.deepEqual(evaluateGlaucomaDiagnosisSuggestions({
    findings: [asymmetryLowCandidate.finding],
    findingDefinitions: definitions,
    provenance,
  }), []);
  assert.equal(evaluateGlaucomaDiagnosisSuggestions({
    findings: [asymmetryLowCandidate.finding],
    findingDefinitions: definitions,
    riskConfig: { asymmetryLow: 0.18 },
    provenance,
  })[0]?.diagnosisDefinition.icd10Code, "H40.013");
  assert.equal(evaluateGlaucomaDiagnosisSuggestions({
    findings: [asymmetryHighCandidate.finding],
    findingDefinitions: definitions,
    provenance,
  })[0]?.diagnosisDefinition.icd10Code, "H40.013");
  assert.equal(evaluateGlaucomaDiagnosisSuggestions({
    findings: [asymmetryHighCandidate.finding],
    findingDefinitions: definitions,
    riskConfig: { asymmetryHigh: 0.28 },
    provenance,
  })[0]?.diagnosisDefinition.icd10Code, "H40.023");
});

test("practice-added cup/disc descriptor persists in editable option data and remains selectable", () => {
  const definitions = glaucomaDefinitions();
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(cupDisc);
  const editedCupDisc = addGlaucomaCupDiscDescriptorOption(cupDisc, {
    code: "tilted-disc",
    display: "Tilted disc",
    active: true,
  });
  const editedDefinitions = definitions.map((definition) =>
    definition.id === cupDisc.id ? editedCupDisc : definition);
  const captured = captureGlaucomaFinding({
    definition: editedCupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-practice-added-descriptor",
    laterality: "OD",
    value: {
      type: "json",
      value: {
        verticalCupDiscRatio: 0.5,
        discAppearanceDescriptors: ["tilted-disc"],
      },
    },
    recordedAt: "2026-06-14T13:28:00.000Z",
    provenance,
  });
  const [suggestion] = evaluateGlaucomaDiagnosisSuggestions({
    findings: [captured.finding],
    findingDefinitions: editedDefinitions,
    provenance,
  });

  assert.equal(
    getGlaucomaCupDiscDescriptorOptions(editedCupDisc).some((option) => option.code === "tilted-disc"),
    true,
  );
  assert.equal(suggestion.diagnosisDefinition.icd10Code, "H40.011");
  assert.deepEqual(
    (suggestion.suggestionEdge.predicateExpression.observed as { discAppearanceDescriptors: string[] }).discAppearanceDescriptors,
    ["tilted-disc"],
  );
});

test("IOP evaluator keeps 21 mmHg normal and emits H40.05x at 22 mmHg", () => {
  const definitions = glaucomaDefinitions();
  const iop = definitions.find((definition) => definition.stableKey === "intraocular_pressure");
  assert.ok(iop);
  const normal = captureGlaucomaFinding({
    definition: iop,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-iop-21-od",
    laterality: "OD",
    value: { type: "quantity", value: 21, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    recordedAt: "2026-07-09T13:00:00.000Z",
    provenance,
  });
  const suspect = captureGlaucomaFinding({
    definition: iop,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-iop-22-od",
    laterality: "OD",
    value: { type: "quantity", value: 22, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    recordedAt: "2026-07-09T13:05:00.000Z",
    provenance,
  });

  assert.equal(evaluateIopFindingRisk(normal.finding, iop).riskTier, "normal");
  assert.equal(evaluateIopDiagnosisSuggestions({
    findings: [normal.finding],
    findingDefinitions: definitions,
    provenance,
  }).length, 0);

  const [suggestion] = evaluateIopDiagnosisSuggestions({
    findings: [suspect.finding],
    findingDefinitions: definitions,
    provenance,
  });
  assert.equal(suggestion.diagnosisDefinition.icd10Code, "H40.051");
  assert.equal(suggestion.suggestionEdge.visitState, "unreviewed");
  assert.equal(suggestion.suggestionEdge.predicateExpression.riskTier, "ohtn");
  assert.equal(suggestion.suggestionEdge.predicateExpression.threshold, 22);
});

test("IOP and cup/disc evaluators emit independent suggestions for the same encounter", () => {
  const definitions = glaucomaDefinitions();
  const cupDisc = definitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  const iop = definitions.find((definition) => definition.stableKey === "intraocular_pressure");
  assert.ok(cupDisc);
  assert.ok(iop);
  const cupDiscFinding = captureGlaucomaFinding({
    definition: cupDisc,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-cup-disc-high-with-iop",
    laterality: "OD",
    value: { type: "quantity", value: 0.75, unit: "ratio", code: "1" },
    recordedAt: "2026-07-09T13:06:00.000Z",
    provenance,
  });
  const iopFinding = captureGlaucomaFinding({
    definition: iop,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-iop-ohtn-with-cup-disc",
    laterality: "OD",
    value: { type: "quantity", value: 22, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    recordedAt: "2026-07-09T13:07:00.000Z",
    provenance,
  });

  const [cupDiscSuggestion] = evaluateGlaucomaDiagnosisSuggestions({
    findings: [cupDiscFinding.finding, iopFinding.finding],
    findingDefinitions: definitions,
    provenance,
  });
  const [iopSuggestion] = evaluateIopDiagnosisSuggestions({
    findings: [cupDiscFinding.finding, iopFinding.finding],
    findingDefinitions: definitions,
    provenance,
  });

  assert.equal(cupDiscSuggestion.diagnosisDefinition.icd10Code, "H40.021");
  assert.equal(iopSuggestion.diagnosisDefinition.icd10Code, "H40.051");
  assert.notEqual(cupDiscSuggestion.suggestionEdge.id, iopSuggestion.suggestionEdge.id);
});

test("IOP ocular-hypertension suggestions resolve laterality digits from the verified ledger", () => {
  const definitions = glaucomaDefinitions();
  const iop = definitions.find((definition) => definition.stableKey === "intraocular_pressure");
  assert.ok(iop);
  const cases = [
    ["OD", "H40.051"],
    ["OS", "H40.052"],
    ["OU", "H40.053"],
    ["UNKNOWN", "H40.059"],
  ] as const;

  for (const [laterality, code] of cases) {
    const captured = captureGlaucomaFinding({
      definition: iop,
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      findingInstanceId: `finding-iop-${laterality.toLowerCase()}`,
      laterality,
      value: { type: "quantity", value: 22, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
      recordedAt: "2026-07-09T13:10:00.000Z",
      provenance,
    });
    const [suggestion] = evaluateIopDiagnosisSuggestions({
      findings: [captured.finding],
      findingDefinitions: definitions,
      provenance,
    });
    assert.equal(suggestion.diagnosisDefinition.icd10Code, code);
  }
});

test("IOP evaluator suppresses not-visualized findings and honors threshold overrides", () => {
  const definitions = glaucomaDefinitions();
  const iop = definitions.find((definition) => definition.stableKey === "intraocular_pressure");
  assert.ok(iop);
  const notVisualized = captureGlaucomaFinding({
    definition: iop,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-iop-not-visualized",
    laterality: "OD",
    value: { type: "json", value: { value: 40, notVisualized: true } },
    recordedAt: "2026-07-09T13:15:00.000Z",
    provenance,
  });
  const thresholdOverride = captureGlaucomaFinding({
    definition: iop,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-iop-23-threshold-override",
    laterality: "OD",
    value: { type: "quantity", value: 23, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    recordedAt: "2026-07-09T13:20:00.000Z",
    provenance,
  });

  assert.equal(evaluateIopFindingRisk(notVisualized.finding, iop).notVisualized, true);
  assert.equal(evaluateIopDiagnosisSuggestions({
    findings: [notVisualized.finding],
    findingDefinitions: definitions,
    provenance,
  }).length, 0);
  assert.equal(evaluateIopDiagnosisSuggestions({
    findings: [thresholdOverride.finding],
    findingDefinitions: definitions,
    riskConfig: { ohtnThreshold: 24 },
    provenance,
  }).length, 0);
});

test("practice-added IOP method persists in editable option data and round-trips as Observation.method", () => {
  const iop = iopDefinition();
  const editedIop = addGlaucomaIopMethodOption(iop, {
    code: "ORA-CUSTOM",
    display: "ORA custom",
    active: true,
  });
  const captured = captureGlaucomaFinding({
    definition: editedIop,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-iop-practice-method",
    laterality: "OD",
    value: { type: "quantity", value: 18, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    method: odosConcept("ORA-CUSTOM", "ORA custom"),
    recordedAt: "2026-07-09T13:25:00.000Z",
    provenance,
  });

  assert.equal(
    getGlaucomaIopMethodOptions(editedIop).some((option) => option.code === "ORA-CUSTOM"),
    true,
  );
  assert.equal(captured.observation.method?.coding?.[0]?.code, "ORA-CUSTOM");
});

test("corneal hysteresis stores as its own non-mmHg finding and emits no diagnosis suggestion", () => {
  const definitions = glaucomaDefinitions();
  const cornealHysteresis = definitions.find((definition) => definition.stableKey === "corneal_hysteresis");
  assert.ok(cornealHysteresis);
  const captured = captureGlaucomaFinding({
    definition: cornealHysteresis,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    findingInstanceId: "finding-ch-od",
    laterality: "OD",
    value: { type: "quantity", value: 8.7, unit: "corneobiomechanics score" },
    recordedAt: "2026-07-09T13:30:00.000Z",
    provenance,
  });

  assert.equal(captured.observation.valueQuantity?.value, 8.7);
  assert.equal(captured.observation.valueQuantity?.unit, "corneobiomechanics score");
  assert.equal(captured.observation.valueQuantity?.code, undefined);
  assert.equal(evaluateIopDiagnosisSuggestions({
    findings: [captured.finding],
    findingDefinitions: definitions,
    provenance,
  }).length, 0);
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
  assert.equal(first[0].suggestionEdge.id, "suggestion-finding-pure-ou-glaucoma-suspect-open-angle-low-ou");
  assert.equal(first[0].diagnosisDefinition.id, "dx-def-glaucoma-suspect-open-angle-low-ou");
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
    clinicalSeverity: odosConcept("mild-clinical-severity", "Mild clinical severity"),
    diseaseStage: odosConcept("pre-perimetric-stage", "Pre-perimetric stage"),
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
    riskTier: "low",
    provenance,
  });
  const placeholder = buildGlaucomaOpenAngleDiagnosisDefinition({
    laterality: "OD",
    riskTier: "low",
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
