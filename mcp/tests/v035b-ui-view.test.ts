import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Encounter } from "@medplum/fhirtypes";
import { buildStartEncounterCreateBundle } from "../../ui/src/lib/encounter-bundles.js";
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
} from "../../ui/src/lib/fhir-clinical/condition.js";
import {
  buildEncounterDiagnosisComponent as buildMcpEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition as buildMcpEncounterDiagnosisCondition,
  buildProblemListCondition as buildMcpProblemListCondition,
} from "../src/fhir/condition.js";
import { buildAllergyIntolerance as buildUiAllergyIntolerance } from "../../ui/src/lib/fhir-clinical/allergyIntolerance.js";
import { buildAllergyIntolerance as buildMcpAllergyIntolerance } from "../src/fhir/allergyIntolerance.js";
import { buildSmokingStatusObservation as buildUiSmokingStatusObservation } from "../../ui/src/lib/fhir-clinical/smokingStatus.js";
import { buildSmokingStatusObservation as buildMcpSmokingStatusObservation } from "../src/fhir/smokingStatus.js";
import { buildCareTeam as buildUiCareTeam } from "../../ui/src/lib/fhir-clinical/careTeam.js";
import { buildCareTeam as buildMcpCareTeam } from "../src/fhir/careTeam.js";
import { buildProcedure as buildUiProcedure } from "../../ui/src/lib/fhir-clinical/procedure.js";
import { buildProcedure as buildMcpProcedure } from "../src/fhir/procedure.js";

test("role config is switchable presentation-only plumbing", () => {
  assert.deepEqual(ROLE_IDS, ["doctor", "tech", "front-desk"]);
  assert.equal(ROLE_CONFIG.doctor.defaultView, "encounter-charting");
  assert.equal(ROLE_CONFIG.tech.defaultView, "chart-sidebar");
  assert.equal(ROLE_CONFIG["front-desk"].defaultView, "admin-cards");

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
    ["programs", "allergies", "tobacco-use", "product-timeline", "care-team", "problem-list"],
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

  assert.equal(encounter.episodeOfCare?.[0]?.reference, "EpisodeOfCare/e1");
  assert.equal(
    readUi("src/components/Hud.tsx").includes(">EpisodeOfCare<"),
    false,
    "The visible label should be Program, not the FHIR resource name.",
  );
});

test("MDM hint counter is deterministic and does not surface E/M code suggestions", () => {
  const encounter: Encounter = {
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  };
  const stable = buildUiProblemListCondition({
    patientReference: "Patient/p1",
    code: { system: "http://snomed.info/sct", code: "73211009", display: "Diabetes mellitus" },
  });
  const stable2 = buildUiProblemListCondition({
    patientReference: "Patient/p1",
    code: { system: "http://snomed.info/sct", code: "38341003", display: "Hypertension" },
  });
  const acute = buildUiEncounterDiagnosisCondition({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    code: { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H10.31", display: "Acute uncomplicated conjunctivitis" },
  });
  const severe = buildUiEncounterDiagnosisCondition({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    code: { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "X", display: "Chronic severe exacerbation" },
  });

  assert.equal(computeMdmHint({ encounter, encounterConditions: [], problemListConditions: [stable] }).tier, "Low");
  assert.equal(computeMdmHint({ encounter, encounterConditions: [], problemListConditions: [stable, stable2] }).tier, "Moderate");
  assert.equal(computeMdmHint({ encounter, encounterConditions: [acute], problemListConditions: [] }).tier, "Moderate");
  assert.equal(computeMdmHint({ encounter, encounterConditions: [severe], problemListConditions: [] }).tier, "High");

  const headerSource = readUi("src/components/charting/EncounterHeader.tsx");
  assert.doesNotMatch(headerSource, /9921[345]/);
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
    buildUiProcedure({ patientReference: "Patient/p1", status: "completed", code: { system: "http://www.ama-assn.org/go/cpt", code: "92133" }, bodyStructureReference: "BodyStructure/b1" }),
    buildMcpProcedure({ patientReference: "Patient/p1", status: "completed", code: { system: "http://www.ama-assn.org/go/cpt", code: "92133" }, bodyStructureReference: "BodyStructure/b1" }),
  );
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

function assertJsonEqual(left: unknown, right: unknown): void {
  assert.equal(JSON.stringify(left), JSON.stringify(right));
}

function readUi(path: string): string {
  return readFileSync(resolve(process.cwd(), "..", "ui", path), "utf8");
}
