import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Encounter, Provenance } from "@medplum/fhirtypes";
import {
  buildEncounterStatusPatchBundle,
  buildStartEncounterCreateBundle,
} from "../../ui/src/lib/encounter-bundles.js";
import { ROLE_CONFIG, ROLE_IDS } from "../../ui/src/lib/roles.js";
import { CHART_CARD_REGISTRY, cardDensity } from "../../ui/src/lib/card-registry.js";
import {
  addEncounterDiagnosisPatchOperations,
  diagnosisRankForTier,
} from "../../ui/src/lib/clinical-actions.js";
import {
  computeMdmHint,
  episodeTypeLabel,
  isProblemListCondition,
  newestSmokingStatus,
  standaloneEncounters,
} from "../../ui/src/lib/clinical-view-model.js";
import { buildEpisodeOfCare as buildUiEpisodeOfCare } from "../../ui/src/lib/fhir-clinical/episodeOfCare.js";
import { buildEpisodeOfCare as buildMcpEpisodeOfCare } from "../src/fhir/episodeOfCare.js";
import {
  buildEncounterDiagnosisComponent as buildUiEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition as buildUiEncounterDiagnosisCondition,
  buildProblemListCondition as buildUiProblemListCondition,
  MDM_PROBLEM_STATUSES as UI_MDM_PROBLEM_STATUSES,
} from "../../ui/src/lib/fhir-clinical/condition.js";
import {
  buildEncounterDiagnosisComponent as buildMcpEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition as buildMcpEncounterDiagnosisCondition,
  buildProblemListCondition as buildMcpProblemListCondition,
  MDM_PROBLEM_STATUSES as MCP_MDM_PROBLEM_STATUSES,
} from "../src/fhir/condition.js";
import { buildAllergyIntolerance as buildUiAllergyIntolerance } from "../../ui/src/lib/fhir-clinical/allergyIntolerance.js";
import { buildAllergyIntolerance as buildMcpAllergyIntolerance } from "../src/fhir/allergyIntolerance.js";
import { buildSmokingStatusObservation as buildUiSmokingStatusObservation } from "../../ui/src/lib/fhir-clinical/smokingStatus.js";
import { buildSmokingStatusObservation as buildMcpSmokingStatusObservation } from "../src/fhir/smokingStatus.js";
import { buildCareTeam as buildUiCareTeam } from "../../ui/src/lib/fhir-clinical/careTeam.js";
import { buildCareTeam as buildMcpCareTeam } from "../src/fhir/careTeam.js";
import { buildProcedure as buildUiProcedure } from "../../ui/src/lib/fhir-clinical/procedure.js";
import { buildProcedure as buildMcpProcedure } from "../src/fhir/procedure.js";
import {
  DEFERRED_PROCEDURE_CONCEPT_SYSTEM,
  SCODI_OPTIC_NERVE,
} from "./fixtures/deferred-procedure-constants.js";

test("role config is switchable presentation-only plumbing", () => {
  assert.deepEqual(ROLE_IDS, ["doctor", "tech", "front-desk", "practice-admin"]);
  assert.equal(ROLE_CONFIG.doctor.defaultView, "encounter-charting");
  assert.equal(ROLE_CONFIG.tech.defaultView, "chart-sidebar");
  assert.equal(ROLE_CONFIG["front-desk"].defaultView, "admin-cards");
  assert.equal(ROLE_CONFIG["practice-admin"].defaultView, "admin-cards");

  const rolesSource = readUi("src/lib/roles.ts");
  assert.match(rolesSource, /Presentation only/);
  assert.match(rolesSource, /never authorization/);

  for (const path of ["src/lib/clinical-actions.ts", "src/lib/fhir.ts", "src/lib/encounter-bundles.ts"]) {
    assert.doesNotMatch(readUi(path), /useRole/);
  }
});

test("chart card registry keeps v0.35b sidebar cards visible to every role", () => {
  assert.deepEqual(
    CHART_CARD_REGISTRY.map((card) => card.id),
    ["programs", "allergies", "tobacco-use", "product-timeline", "care-team", "problem-list", "longitudinal-imaging"],
  );

  for (const card of CHART_CARD_REGISTRY) {
    for (const role of ROLE_IDS) {
      assert.notEqual(cardDensity(card.id, role), "hidden");
    }
  }
});

test("start encounter bundle can attach a visit to a clinical Program", () => {
  const bundle = buildStartEncounterCreateBundle({
    patientId: "p1",
    now: "2026-04-25T12:00:00.000Z",
    episodeReference: "EpisodeOfCare/e1",
  });
  const encounter = bundle.entry?.[0]?.resource as Encounter;
  const provenance = bundle.entry?.[1]?.resource as Provenance;

  assert.equal(encounter.episodeOfCare?.[0]?.reference, "EpisodeOfCare/e1");
  assert.equal(provenance.target[0]?.reference, bundle.entry?.[0]?.fullUrl);
  assert.equal(provenance.target[1]?.reference, "Patient/p1");
  const statusProvenance = buildEncounterStatusPatchBundle({
    encounterId: "e1",
    patientId: "p1",
    recorded: "2026-04-25T12:01:00.000Z",
    operatorDisplay: "test",
    ops: [{ op: "replace", path: "/status", value: "in-progress" }],
  }).entry?.[1]?.resource as Provenance;
  assert.deepEqual(
    statusProvenance.target.map((target) => target.reference),
    ["Encounter/e1", "Patient/p1"],
  );
  const startExamSource = readUi("src/components/StartExam.tsx");
  const assignIndex = startExamSource.indexOf("await assignProvider(patient.id)");
  const resolveIndex = startExamSource.indexOf("const episodeReference = await resolveProgramReference()");
  assert.ok(assignIndex >= 0, "StartExam must call assignProvider(patient.id).");
  assert.ok(resolveIndex >= 0, "StartExam must resolve the program reference before the encounter write.");
  assert.ok(
    assignIndex < resolveIndex,
    "Provider assignment must precede every patient-compartment clinical write.",
  );
  assert.equal(
    startExamSource.includes(">EpisodeOfCare<"),
    false,
    "The visible label should be Program, not the FHIR resource name.",
  );
});

test("MDM blocks three unset encounter diagnoses instead of counting active problem-list rows", () => {
  const encounter = encounterWithDiagnosis([
    encounterDiagnosis("Condition/dx1"),
    encounterDiagnosis("Condition/dx2"),
    encounterDiagnosis("Condition/dx3"),
  ]);
  const activeProblems = ["p1", "p2", "p3"].map((id) => buildUiProblemListCondition({
    patientReference: "Patient/p1",
    code: { system: "https://example.test/problem", code: id, display: `Problem ${id}` },
  }));

  const result = computeMdm(encounter, [], activeProblems);

  assert.equal(result.status, "blocked");
  assert.equal("tier" in result, false);
  assert.equal(result.reason, "problem status unset on 3 diagnoses");
});

test("MDM blocks an unset diagnosis even when its display contains severe exacerbation", () => {
  const severeLabel = buildUiEncounterDiagnosisCondition({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    code: { system: "https://example.test/diagnosis", code: "X", display: "Chronic severe exacerbation" },
  });

  const result = computeMdm(
    encounterWithDiagnosis([encounterDiagnosis("Condition/dx1")]),
    [severeLabel],
    [],
  );

  assert.equal(result.status, "blocked");
  assert.equal("tier" in result, false);
  assert.equal(result.reason, "problem status unset on 1 diagnosis");
});

test("MDM tiers come only from coded per-diagnosis problem status", () => {
  const misleadingLabel = buildUiEncounterDiagnosisCondition({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    code: { system: "https://example.test/diagnosis", code: "X", display: "Severe exacerbation with systemic symptoms" },
  });
  const activeProblems = ["p1", "p2", "p3"].map((id) => buildUiProblemListCondition({
    patientReference: "Patient/p1",
    code: { system: "https://example.test/problem", code: id },
  }));

  const oneStable = computeMdm(
    encounterWithDiagnosis([encounterDiagnosis("Condition/dx1", "stable-chronic")]),
    [misleadingLabel],
    activeProblems,
  );
  const twoStable = computeMdm(encounterWithDiagnosis([
    encounterDiagnosis("Condition/dx1", "stable-chronic"),
    encounterDiagnosis("Condition/dx2", "stable-chronic"),
  ]));
  const oneAcuteComplicated = computeMdm(encounterWithDiagnosis([
    encounterDiagnosis("Condition/dx1", "acute-complicated-or-systemic-symptoms"),
  ]));

  assert.equal(oneStable.status, "ready");
  assert.equal(oneStable.tier, "Low");
  assert.equal(twoStable.status, "ready");
  assert.equal(twoStable.tier, "Moderate");
  assert.equal(oneAcuteComplicated.status, "ready");
  assert.equal(oneAcuteComplicated.tier, "Moderate");

  const headerSource = readUi("src/components/charting/EncounterHeader.tsx");
  assert.doesNotMatch(headerSource, /9921[345]/);
});

test("MDM problem status canonical artifacts bind exactly the seven clinician choices", () => {
  const repoRoot = resolve(process.cwd(), "..");
  const artifactPaths = [
    resolve(repoRoot, "data/canonical-extensions/odos-encounter-diagnosis-problem-status.json"),
    resolve(repoRoot, "data/terminology/mdm-problem-status-codesystem.json"),
    resolve(repoRoot, "data/terminology/mdm-problem-status-valueset.json"),
  ];
  for (const path of artifactPaths) {
    assert.equal(existsSync(path), true, `${path} must exist`);
  }

  const structureDefinition = JSON.parse(readFileSync(artifactPaths[0]!, "utf8")) as {
    context?: Array<{ expression?: string }>;
    differential?: { element?: Array<{
      id?: string;
      type?: Array<{ code?: string }>;
      binding?: { strength?: string; valueSet?: string };
    }> };
  };
  const valueElement = structureDefinition.differential?.element?.find(
    (element) => element.id === "Extension.value[x]",
  );
  assert.equal(structureDefinition.context?.[0]?.expression, "Encounter.diagnosis");
  assert.equal(valueElement?.type?.[0]?.code, "CodeableConcept");
  assert.deepEqual(valueElement?.binding, {
    strength: "required",
    valueSet: "https://odos2020.com/fhir/ValueSet/mdm-problem-status",
  });

  const codeSystem = JSON.parse(readFileSync(artifactPaths[1]!, "utf8")) as {
    concept?: Array<{ code?: string; display?: string }>;
  };
  assert.deepEqual(codeSystem.concept, [...UI_MDM_PROBLEM_STATUSES]);
  assert.deepEqual(UI_MDM_PROBLEM_STATUSES, MCP_MDM_PROBLEM_STATUSES);

  const registry = readFileSync(resolve(repoRoot, "data/canonical-extensions/registry.json"), "utf8");
  const ledger = readFileSync(resolve(repoRoot, "data/code-bindings/extension-urls.md"), "utf8");
  assert.match(registry, /odos-encounter-diagnosis-problem-status/);
  assert.match(ledger, /odos-encounter-diagnosis-problem-status/);
  assert.match(ledger, /https:\/\/hl7\.org\/fhir\/R4\/encounter-definitions\.html/);
  assert.match(ledger, /https:\/\/hl7\.org\/fhir\/R4\/extensibility\.html/);
  assert.match(ledger, /accessed 2026-08-09/);
});

test("v0.35b UI write builders still match the equivalent MCP builders", () => {
  assertJsonEqual(
    buildUiEpisodeOfCare({ patientReference: "Patient/p1", typeCode: "glaucoma", status: "active" }),
    buildMcpEpisodeOfCare({ patientReference: "Patient/p1", typeCode: "glaucoma", status: "active" }),
  );
  assertJsonEqual(
    buildUiEncounterDiagnosisCondition({
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      code: { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H52.13" },
    }),
    buildMcpEncounterDiagnosisCondition({
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      code: { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H52.13" },
    }),
  );
  assertJsonEqual(buildUiEncounterDiagnosisComponent("Condition/c1", 1), buildMcpEncounterDiagnosisComponent("Condition/c1", 1));
  assertJsonEqual(
    buildUiProblemListCondition({ patientReference: "Patient/p1", code: { system: "http://snomed.info/sct", code: "73211009" } }),
    buildMcpProblemListCondition({ patientReference: "Patient/p1", code: { system: "http://snomed.info/sct", code: "73211009" } }),
  );
  assertJsonEqual(
    buildUiAllergyIntolerance({ patientReference: "Patient/p1", noKnownAllergy: true }),
    buildMcpAllergyIntolerance({ patientReference: "Patient/p1", noKnownAllergy: true }),
  );
  assertJsonEqual(
    buildUiSmokingStatusObservation({ patientReference: "Patient/p1", statusCode: "266919005", effectiveDateTime: "2026-04-25T12:00:00.000Z" }),
    buildMcpSmokingStatusObservation({ patientReference: "Patient/p1", statusCode: "266919005", effectiveDateTime: "2026-04-25T12:00:00.000Z" }),
  );
  assertJsonEqual(
    buildUiCareTeam({ patientReference: "Patient/p1", participant: [{ role: { text: "Ophthalmologist" }, practitionerRoleReference: "PractitionerRole/pr1" }] }),
    buildMcpCareTeam({ patientReference: "Patient/p1", participant: [{ role: { text: "Ophthalmologist" }, practitionerRoleReference: "PractitionerRole/pr1" }] }),
  );
  assertJsonEqual(
    buildUiProcedure({ patientReference: "Patient/p1", status: "completed", code: { system: DEFERRED_PROCEDURE_CONCEPT_SYSTEM, code: SCODI_OPTIC_NERVE.conceptKey }, bodyStructureReference: "BodyStructure/b1" }),
    buildMcpProcedure({ patientReference: "Patient/p1", status: "completed", code: { system: DEFERRED_PROCEDURE_CONCEPT_SYSTEM, code: SCODI_OPTIC_NERVE.conceptKey }, bodyStructureReference: "BodyStructure/b1" }),
  );
  assert.equal(SCODI_OPTIC_NERVE.cptBinding.status, "deferred-to-licensed-adapter");
});

test("diagnosis tier helper enforces one principal and secondary rank greater than one", () => {
  const emptyEncounter = encounterWithDiagnosis([]);
  assert.equal(diagnosisRankForTier(emptyEncounter, "principal"), 1);
  assert.equal(diagnosisRankForTier(emptyEncounter, "secondary"), 2);

  const rankedEncounter = encounterWithDiagnosis([buildUiEncounterDiagnosisComponent("Condition/c1", 1)]);
  assert.throws(() => diagnosisRankForTier(rankedEncounter, "principal"));
  assert.equal(diagnosisRankForTier(rankedEncounter, "secondary"), 2);
});

test("diagnosis tier patch path adds Encounter.diagnosis without delete-and-recreate semantics", () => {
  const entry = buildUiEncounterDiagnosisComponent("Condition/c1", 1);
  const operations = addEncounterDiagnosisPatchOperations(encounterWithDiagnosis([]), entry);

  assert.deepEqual(operations, [{ op: "add", path: "/diagnosis", value: [entry] }]);
  assert.equal(entry.use?.coding?.[0]?.code, "billing");
  assert.equal(entry.rank, 1);
  assert.equal(entry.extension, undefined, "new encounter diagnoses must not receive a default problem status");
  assert.equal(operations.some((operation) => operation.op === "remove"), false);
});

test("chart sidebar view model recognizes v0.35a-built resources", () => {
  const smoking = buildUiSmokingStatusObservation({
    patientReference: "Patient/p1",
    statusCode: "266919005",
    effectiveDateTime: "2026-04-25T12:00:00.000Z",
  });
  const problem = buildUiProblemListCondition({
    patientReference: "Patient/p1",
    code: { system: "http://snomed.info/sct", code: "73211009" },
  });
  const program = buildUiEpisodeOfCare({
    patientReference: "Patient/p1",
    typeCode: "dry-eye",
    status: "active",
  });

  assert.equal(newestSmokingStatus([smoking])?.valueCodeableConcept?.coding?.[0]?.code, "266919005");
  assert.equal(isProblemListCondition(problem), true);
  assert.equal(episodeTypeLabel(program), "Dry eye");
  assert.equal(standaloneEncounters([encounterWithDiagnosis([])]).length, 1);
});

function encounterWithDiagnosis(diagnosis: NonNullable<Encounter["diagnosis"]>): Encounter {
  return {
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
    diagnosis,
  };
}

function encounterDiagnosis(
  conditionReference: string,
  problemStatus?: string,
): NonNullable<Encounter["diagnosis"]>[number] {
  return {
    condition: { reference: conditionReference },
    ...(problemStatus ? {
      extension: [{
        url: "https://odos2020.com/fhir/StructureDefinition/odos-encounter-diagnosis-problem-status",
        valueCodeableConcept: {
          coding: [{
            system: "https://odos2020.com/fhir/CodeSystem/mdm-problem-status",
            code: problemStatus,
          }],
        },
      }],
    } : {}),
  };
}

function computeMdm(
  encounter: Encounter,
  encounterConditions: ReturnType<typeof buildUiEncounterDiagnosisCondition>[] = [],
  problemListConditions: ReturnType<typeof buildUiProblemListCondition>[] = [],
) {
  const input = { encounter, encounterConditions, problemListConditions };
  return computeMdmHint(input);
}

function assertJsonEqual(left: unknown, right: unknown): void {
  assert.equal(JSON.stringify(left), JSON.stringify(right));
}

function readUi(path: string): string {
  return readFileSync(resolve(process.cwd(), "..", "ui", path), "utf8");
}
