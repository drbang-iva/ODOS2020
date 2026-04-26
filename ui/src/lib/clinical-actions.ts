import type {
  AllergyIntolerance,
  BodyStructure,
  CareTeam,
  CodeableConcept,
  Condition,
  Encounter,
  EpisodeOfCare,
  Observation,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { fhir, type JsonPatchOperation } from "./fhir";
import { buildEyeBodyStructure } from "./fhir-ophthalmology/bodyStructure";
import {
  buildAllergyIntolerance,
  type AllergyClinicalStatusCode,
} from "./fhir-clinical/allergyIntolerance";
import { buildCareTeam } from "./fhir-clinical/careTeam";
import {
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  buildProblemListCondition,
  clinicalStatusConcept,
  conditionBodySite,
  conditionCodeConcept,
  verificationStatusConcept,
  type ConditionClinicalStatusCode,
} from "./fhir-clinical/condition";
import {
  buildEpisodeOfCare,
  type EpisodeOfCareStatusCode,
  type EpisodeOfCareTypeCode,
} from "./fhir-clinical/episodeOfCare";
import {
  buildSmokingStatusObservation,
  type SmokingStatusCode,
} from "./fhir-clinical/smokingStatus";

const V3_DATA_OPERATION_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-DataOperation";
const PROVENANCE_PARTICIPANT_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/provenance-participant-type";

export type EyeChoice = "OD" | "OS" | "OU";
export type DiagnosisTierChoice = "principal" | "secondary";

export interface CodeInput {
  system: string;
  code: string;
  display?: string;
  text?: string;
}

export async function createNoKnownAllergy(patientReference: string): Promise<AllergyIntolerance> {
  const allergy = await fhir.create<AllergyIntolerance>(
    buildAllergyIntolerance({ patientReference, noKnownAllergy: true }),
    "create_allergy_intolerance",
  );
  await createUiProvenance("create_allergy_intolerance", `AllergyIntolerance/${allergy.id}`, "CREATE");
  return allergy;
}

export async function createAllergy(input: {
  patientReference: string;
  code: CodeInput;
  clinicalStatus?: AllergyClinicalStatusCode;
}): Promise<AllergyIntolerance> {
  const allergy = await fhir.create<AllergyIntolerance>(
    buildAllergyIntolerance({
      patientReference: input.patientReference,
      code: input.code,
      clinicalStatus: input.clinicalStatus,
      verificationStatus: "confirmed",
    }),
    "create_allergy_intolerance",
  );
  await createUiProvenance("create_allergy_intolerance", `AllergyIntolerance/${allergy.id}`, "CREATE");
  return allergy;
}

export async function createSmokingStatusObservation(input: {
  patientReference: string;
  statusCode: SmokingStatusCode;
}): Promise<Observation> {
  const observation = await fhir.create<Observation>(
    buildSmokingStatusObservation({
      patientReference: input.patientReference,
      statusCode: input.statusCode,
      effectiveDateTime: new Date().toISOString(),
    }),
    "create_smoking_status_observation",
  );
  await createUiProvenance("create_smoking_status_observation", `Observation/${observation.id}`, "CREATE");
  return observation;
}

export async function createCareTeam(input: {
  patientReference: string;
  roleText: string;
  memberReference: string;
  memberDisplay?: string;
}): Promise<CareTeam> {
  const isPractitionerRole = input.memberReference.startsWith("PractitionerRole/");
  const isPractitioner = input.memberReference.startsWith("Practitioner/");
  const careTeam = await fhir.create<CareTeam>(
    buildCareTeam({
      patientReference: input.patientReference,
      participant: [
        {
          role: { text: input.roleText },
          practitionerRoleReference: isPractitionerRole ? input.memberReference : undefined,
          practitionerReference: isPractitioner ? input.memberReference : undefined,
          relatedPersonReference:
            !isPractitionerRole && !isPractitioner ? input.memberReference : undefined,
        },
      ],
    }),
    "create_care_team",
  );
  await createUiProvenance("create_care_team", `CareTeam/${careTeam.id}`, "CREATE");
  return careTeam;
}

export async function createProgram(input: {
  patientReference: string;
  typeCode: EpisodeOfCareTypeCode;
  status?: EpisodeOfCareStatusCode;
}): Promise<EpisodeOfCare> {
  const program = await fhir.create<EpisodeOfCare>(
    buildEpisodeOfCare({
      patientReference: input.patientReference,
      typeCode: input.typeCode,
      status: input.status ?? "active",
      periodStart: new Date().toISOString(),
    }),
    "create_episode_of_care",
  );
  await createUiProvenance("create_episode_of_care", `EpisodeOfCare/${program.id}`, "CREATE");
  return program;
}

export async function promoteEncounterToProgram(input: {
  encounter: Encounter;
  episodeReference: string;
}): Promise<Encounter> {
  const id = requiredId(input.encounter);
  const updated = await fhir.patch<Encounter>(
    "Encounter",
    id,
    [
      {
        op: input.encounter.episodeOfCare ? "replace" : "add",
        path: "/episodeOfCare",
        value: [{ reference: input.episodeReference }],
      },
    ],
    "update_episode_of_care",
    requiredVersion(input.encounter),
  );
  await createUiProvenance("update_episode_of_care", `Encounter/${updated.id}`, "UPDATE");
  return updated;
}

export async function createProblemListCondition(input: {
  patientReference: string;
  code: CodeInput;
  clinicalStatus?: ConditionClinicalStatusCode;
  onsetDateTime?: string;
}): Promise<Condition> {
  const condition = await fhir.create<Condition>(
    buildProblemListCondition({
      patientReference: input.patientReference,
      code: input.code,
      clinicalStatus: input.clinicalStatus,
      onsetDateTime: input.onsetDateTime,
    }),
    "create_problem_list_condition",
  );
  await createUiProvenance("create_problem_list_condition", `Condition/${condition.id}`, "CREATE");
  return condition;
}

export async function createEncounterDiagnosis(input: {
  patientReference: string;
  encounter: Encounter;
  code: CodeInput;
  laterality: EyeChoice;
  tier: DiagnosisTierChoice;
}): Promise<{ condition: Condition; encounter: Encounter }> {
  const rank = diagnosisRankForTier(input.encounter, input.tier);
  const bodyStructure = await ensureEyeBodyStructure(input.patientReference, input.laterality);
  const condition = await fhir.create<Condition>(
    buildEncounterDiagnosisCondition({
      patientReference: input.patientReference,
      encounterReference: `Encounter/${requiredId(input.encounter)}`,
      code: input.code,
      bodyStructureReference: `BodyStructure/${bodyStructure.id}`,
      bodySiteText: input.laterality,
    }),
    "create_condition_with_tier",
  );
  const diagnosisEntry = buildEncounterDiagnosisComponent(`Condition/${condition.id}`, rank);
  const updatedEncounter = await fhir.patch<Encounter>(
    "Encounter",
    requiredId(input.encounter),
    addEncounterDiagnosisPatchOperations(input.encounter, diagnosisEntry),
    "create_condition_with_tier",
    requiredVersion(input.encounter),
  );
  await createUiProvenance("create_condition_with_tier", `Condition/${condition.id}`, "CREATE");
  await createUiProvenance("create_condition_with_tier", `Encounter/${updatedEncounter.id}`, "UPDATE");
  return { condition, encounter: updatedEncounter };
}

export function diagnosisRankForTier(encounter: Encounter, tier: DiagnosisTierChoice): number {
  const ranks = (encounter.diagnosis ?? [])
    .map((diagnosis) => diagnosis.rank)
    .filter((rank): rank is number => Number.isInteger(rank));
  if (tier === "principal") {
    if (ranks.includes(1)) {
      throw new Error("This visit already has a principal diagnosis.");
    }
    return 1;
  }
  return Math.max(1, ...ranks) + 1;
}

export function addEncounterDiagnosisPatchOperations(
  encounter: Encounter,
  diagnosisEntry: NonNullable<Encounter["diagnosis"]>[number],
): JsonPatchOperation[] {
  if ((encounter.diagnosis?.length ?? 0) > 0) {
    return [{ op: "add", path: "/diagnosis/-", value: diagnosisEntry }];
  }
  return [{ op: "add", path: "/diagnosis", value: [diagnosisEntry] }];
}

export async function updateConditionBodySite(input: {
  condition: Condition;
  patientReference: string;
  laterality: EyeChoice;
}): Promise<Condition> {
  const bodyStructure = await ensureEyeBodyStructure(input.patientReference, input.laterality);
  const updated = await fhir.patch<Condition>(
    "Condition",
    requiredId(input.condition),
    [
      {
        op: input.condition.bodySite ? "replace" : "add",
        path: "/bodySite",
        value: conditionBodySite(`BodyStructure/${bodyStructure.id}`, input.laterality),
      },
    ],
    "update_condition_body_site",
    requiredVersion(input.condition),
  );
  await createUiProvenance("update_condition_body_site", `Condition/${updated.id}`, "UPDATE");
  return updated;
}

export async function updateConditionCode(input: {
  condition: Condition;
  code: CodeInput;
}): Promise<Condition> {
  const updated = await fhir.patch<Condition>(
    "Condition",
    requiredId(input.condition),
    [
      {
        op: input.condition.code ? "replace" : "add",
        path: "/code",
        value: conditionCodeConcept(input.code),
      },
    ],
    "update_condition_code",
    requiredVersion(input.condition),
  );
  await createUiProvenance(
    "update_condition_code",
    `Condition/${updated.id}`,
    "UPDATE",
    `prior Condition.code: ${JSON.stringify(input.condition.code ?? null)}`,
  );
  return updated;
}

export async function updateConditionStatus(input: {
  condition: Condition;
  clinicalStatus: ConditionClinicalStatusCode;
}): Promise<Condition> {
  const updated = await fhir.patch<Condition>(
    "Condition",
    requiredId(input.condition),
    [
      {
        op: input.condition.clinicalStatus ? "replace" : "add",
        path: "/clinicalStatus",
        value: clinicalStatusConcept(input.clinicalStatus),
      },
    ],
    "update_condition_status",
    requiredVersion(input.condition),
  );
  await createUiProvenance("update_condition_status", `Condition/${updated.id}`, "UPDATE");
  return updated;
}

export async function updateConditionTier(input: {
  encounter: Encounter;
  condition: Condition;
  rank: number;
}): Promise<Encounter> {
  const index = (input.encounter.diagnosis ?? []).findIndex(
    (diagnosis) => diagnosis.condition.reference === `Condition/${input.condition.id}`,
  );
  if (index < 0) {
    throw new Error("Encounter diagnosis does not reference this Condition.");
  }
  const updated = await fhir.patch<Encounter>(
    "Encounter",
    requiredId(input.encounter),
    [{ op: "replace", path: `/diagnosis/${index}/rank`, value: input.rank }],
    "update_condition_tier",
    requiredVersion(input.encounter),
  );
  await createUiProvenance("update_condition_tier", `Encounter/${updated.id}`, "UPDATE");
  return updated;
}

export async function markConditionEnteredInError(condition: Condition): Promise<Condition> {
  const operations: JsonPatchOperation[] = [
    {
      op: condition.verificationStatus ? "replace" : "add",
      path: "/verificationStatus",
      value: verificationStatusConcept("entered-in-error"),
    },
  ];
  if (condition.clinicalStatus) {
    operations.push({ op: "remove", path: "/clinicalStatus" });
  }
  const updated = await fhir.patch<Condition>(
    "Condition",
    requiredId(condition),
    operations,
    "mark_condition_entered_in_error",
    requiredVersion(condition),
  );
  await createUiProvenance("mark_condition_entered_in_error", `Condition/${updated.id}`, "UPDATE");
  return updated;
}

export async function ensureEyeBodyStructure(
  patientReference: string,
  laterality: EyeChoice,
): Promise<BodyStructure> {
  const location = laterality === "OD" ? "18944008" : laterality === "OS" ? "8966001" : "81745001";
  const existing = await fhir.search<BodyStructure>("BodyStructure", {
    patient: patientReference,
    location,
    _count: "1",
  });
  const found = existing.entry?.[0]?.resource;
  if (found) return found;

  const bodyStructure = buildEyeBodyStructure(laterality, patientReference);
  const { id: _containedId, ...resource } = bodyStructure;
  return fhir.create<BodyStructure>(resource, "ensure_body_structure");
}

export function conceptFromCode(input: CodeInput): CodeableConcept {
  return conditionCodeConcept(input);
}

async function createUiProvenance(
  sourceTag: string,
  targetReference: string,
  activityCode: "CREATE" | "UPDATE",
  entityDisplay?: string,
): Promise<Provenance> {
  return fhir.create<Provenance>(
    {
      resourceType: "Provenance",
      target: [{ reference: targetReference }],
      recorded: new Date().toISOString(),
      activity: {
        coding: [
          {
            system: V3_DATA_OPERATION_SYSTEM,
            code: activityCode,
            display: activityCode === "CREATE" ? "Create" : "Update",
          },
        ],
      },
      agent: [
        {
          type: {
            coding: [
              {
                system: PROVENANCE_PARTICIPANT_TYPE_SYSTEM,
                code: "author",
                display: "Author",
              },
            ],
          },
          who: { display: `OSOD UI ${sourceTag}` },
        },
      ],
      ...(entityDisplay
        ? { entity: [{ role: "revision", what: { display: entityDisplay } }] }
        : {}),
    },
    sourceTag,
  );
}

function requiredId(resource: Resource): string {
  if (!resource.id) {
    throw new Error(`${resource.resourceType} is missing id.`);
  }
  return resource.id;
}

function requiredVersion(resource: Resource): string {
  const versionId = resource.meta?.versionId;
  if (!versionId) {
    throw new Error(`${resource.resourceType}/${resource.id ?? "(unknown)"} is missing meta.versionId.`);
  }
  return versionId;
}
