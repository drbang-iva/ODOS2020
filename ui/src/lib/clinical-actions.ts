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
  MDM_PROBLEM_STATUS_EXTENSION_URL,
  mdmProblemStatusExtension,
  verificationStatusConcept,
  type ConditionClinicalStatusCode,
  type MdmProblemStatus,
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
import { assertTransactionSuccess } from "./encounter-bundles";

const V3_DATA_OPERATION_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-DataOperation";
const PROVENANCE_PARTICIPANT_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/provenance-participant-type";
export const DIAGNOSIS_KEY_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key";

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

export function encounterDiagnosisProblemStatusPatchOperations(
  encounter: Encounter,
  condition: Condition,
  problemStatus: MdmProblemStatus,
): JsonPatchOperation[] {
  const diagnosisIndex = encounterDiagnosisIndex(encounter.diagnosis ?? [], condition);
  const diagnosis = encounter.diagnosis![diagnosisIndex]!;
  const extension = mdmProblemStatusExtension(problemStatus);
  const extensionIndex = diagnosis.extension?.findIndex(
    (candidate) => candidate.url === MDM_PROBLEM_STATUS_EXTENSION_URL,
  ) ?? -1;
  if (extensionIndex >= 0) {
    return [{
      op: "replace",
      path: `/diagnosis/${diagnosisIndex}/extension/${extensionIndex}`,
      value: extension,
    }];
  }
  if (diagnosis.extension?.length) {
    return [{
      op: "add",
      path: `/diagnosis/${diagnosisIndex}/extension/-`,
      value: extension,
    }];
  }
  return [{
    op: "add",
    path: `/diagnosis/${diagnosisIndex}/extension`,
    value: [extension],
  }];
}

export async function updateEncounterDiagnosisProblemStatus(input: {
  encounter: Encounter;
  condition: Condition;
  problemStatus: MdmProblemStatus;
}): Promise<Encounter> {
  const updated = await fhir.patch<Encounter>(
    "Encounter",
    requiredId(input.encounter),
    encounterDiagnosisProblemStatusPatchOperations(
      input.encounter,
      input.condition,
      input.problemStatus,
    ),
    "update_encounter_diagnosis_problem_status",
    requiredVersion(input.encounter),
  );
  await createUiProvenance(
    "update_encounter_diagnosis_problem_status",
    [`Encounter/${updated.id}`, `Condition/${requiredId(input.condition)}`],
    "UPDATE",
    undefined,
    input.condition.subject.reference,
  );
  return updated;
}

export async function updateConditionBodySite(input: {
  condition: Condition;
  patientReference: string;
  laterality: EyeChoice;
}): Promise<Condition> {
  const bodyStructure = await ensureEyeBodyStructure(input.patientReference, input.laterality);
  const identifiers = input.condition.identifier?.map((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
      ? { ...identifier, ...(updatedDiagnosisIdentifierValue(identifier.value, input.laterality)) }
      : identifier
  );
  const identifierChanged = identifiers?.some((identifier, index) =>
    identifier.value !== input.condition.identifier?.[index]?.value
  );
  const updated = await fhir.patch<Condition>(
    "Condition",
    requiredId(input.condition),
    [
      {
        op: input.condition.bodySite ? "replace" : "add",
        path: "/bodySite",
        value: conditionBodySite(`BodyStructure/${bodyStructure.id}`, input.laterality),
      },
      ...(identifierChanged ? [{
        op: "replace" as const,
        path: "/identifier",
        value: identifiers,
      }] : []),
    ],
    "update_condition_body_site",
    requiredVersion(input.condition),
  );
  await createUiProvenance(
    "update_condition_body_site",
    `Condition/${updated.id}`,
    "UPDATE",
    undefined,
    input.patientReference,
  );
  return updated;
}

function updatedDiagnosisIdentifierValue(
  value: string | undefined,
  laterality: EyeChoice,
): { value: string } | undefined {
  if (!value) return undefined;
  const parts = value.split("::");
  const suffix = parts.at(-1);
  if (
    parts.length < 2 ||
    (suffix !== "right" && suffix !== "left" && suffix !== "bilateral" && suffix !== "unspecified" && suffix !== "none")
  ) return undefined;
  return { value: [...parts.slice(0, -1), laterality === "OD" ? "right" : laterality === "OS" ? "left" : "bilateral"].join("::") };
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

export async function makeConditionPrincipal(input: {
  encounter: Encounter;
  condition: Condition;
}): Promise<Encounter> {
  assertValidDiagnosisRanks(input.encounter);
  const diagnosis = input.encounter.diagnosis ?? [];
  const targetIndex = encounterDiagnosisIndex(diagnosis, input.condition);
  const principalIndexes = diagnosis.flatMap((entry, index) => entry.rank === 1 ? [index] : []);
  if (principalIndexes.length > 1) {
    throw new Error("This visit has multiple principal diagnoses.");
  }
  const principalIndex = principalIndexes[0];
  if (principalIndex === targetIndex) {
    throw new Error("This diagnosis is already principal.");
  }
  const targetRank = diagnosis[targetIndex]!.rank;
  const operations: JsonPatchOperation[] = [{
    op: targetRank === undefined ? "add" : "replace",
    path: `/diagnosis/${targetIndex}/rank`,
    value: 1,
  }];
  if (principalIndex !== undefined) {
    operations.push(targetRank === undefined
      ? { op: "remove", path: `/diagnosis/${principalIndex}/rank` }
      : { op: "replace", path: `/diagnosis/${principalIndex}/rank`, value: targetRank });
  }
  return patchEncounterDiagnosisRanks(input.encounter, operations, "make_diagnosis_principal");
}

export async function swapConditionRanks(input: {
  encounter: Encounter;
  condition: Condition;
  adjacentCondition: Condition;
}): Promise<Encounter> {
  assertValidDiagnosisRanks(input.encounter);
  const diagnosis = input.encounter.diagnosis ?? [];
  const targetIndex = encounterDiagnosisIndex(diagnosis, input.condition);
  const adjacentIndex = encounterDiagnosisIndex(diagnosis, input.adjacentCondition);
  const targetRank = diagnosis[targetIndex]!.rank;
  const adjacentRank = diagnosis[adjacentIndex]!.rank;
  if (targetRank === 1 || adjacentRank === 1) {
    throw new Error("Only secondary diagnoses can move up or down.");
  }
  if (!Number.isInteger(targetRank) || !Number.isInteger(adjacentRank) || targetRank === adjacentRank) {
    throw new Error("Secondary diagnoses must have distinct ranks before they can move.");
  }
  return patchEncounterDiagnosisRanks(input.encounter, [
    { op: "replace", path: `/diagnosis/${targetIndex}/rank`, value: adjacentRank },
    { op: "replace", path: `/diagnosis/${adjacentIndex}/rank`, value: targetRank },
  ], "reorder_encounter_diagnoses");
}

function assertValidDiagnosisRanks(encounter: Encounter): void {
  const ranks = (encounter.diagnosis ?? [])
    .map((diagnosis) => diagnosis.rank)
    .filter((rank): rank is number => rank !== undefined);
  if (ranks.filter((rank) => rank === 1).length > 1) {
    throw new Error("This visit has multiple principal diagnoses.");
  }
  if (!hasValidDiagnosisRanks(encounter)) {
    throw new Error("This visit has invalid or duplicate diagnosis ranks and must be corrected before reordering.");
  }
}

export function hasValidDiagnosisRanks(encounter: Encounter): boolean {
  const ranks = (encounter.diagnosis ?? [])
    .map((diagnosis) => diagnosis.rank)
    .filter((rank): rank is number => rank !== undefined);
  return ranks.every((rank) => Number.isInteger(rank) && rank >= 1) && new Set(ranks).size === ranks.length;
}

async function patchEncounterDiagnosisRanks(
  encounter: Encounter,
  operations: JsonPatchOperation[],
  sourceTag: string,
): Promise<Encounter> {
  const updated = await fhir.patch<Encounter>(
    "Encounter",
    requiredId(encounter),
    operations,
    sourceTag,
    requiredVersion(encounter),
  );
  await createUiProvenance(sourceTag, `Encounter/${updated.id}`, "UPDATE");
  return updated;
}

function encounterDiagnosisIndex(
  diagnosis: NonNullable<Encounter["diagnosis"]>,
  condition: Condition,
): number {
  const index = diagnosis.findIndex(
    (entry) => entry.condition.reference === `Condition/${requiredId(condition)}`,
  );
  if (index < 0) {
    throw new Error("Encounter diagnosis does not reference this Condition.");
  }
  return index;
}

export async function markConditionEnteredInError(condition: Condition): Promise<void> {
  const encounterId = condition.encounter?.reference?.match(/^Encounter\/([^/]+)$/)?.[1];
  if (!encounterId) {
    throw new Error("Encounter diagnosis Condition does not reference an Encounter.");
  }
  const encounter = await fhir.read<Encounter>("Encounter", encounterId);
  const conditionId = requiredId(condition);
  const { clinicalStatus: _clinicalStatus, ...conditionWithoutClinicalStatus } = condition;
  const updatedCondition: Condition = {
    ...conditionWithoutClinicalStatus,
    verificationStatus: verificationStatusConcept("entered-in-error"),
  };
  const updatedEncounter = encounterAfterDiagnosisRetraction(encounter, condition);
  const sourceTag = "mark_condition_entered_in_error";
  const recorded = new Date().toISOString();
  const response = await fhir.executeTransaction({
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: updatedCondition,
        request: {
          method: "PUT",
          url: `Condition/${conditionId}`,
          ifMatch: `W/\"${requiredVersion(condition)}\"`,
        },
      },
      {
        resource: updatedEncounter,
        request: {
          method: "PUT",
          url: `Encounter/${encounterId}`,
          ifMatch: `W/\"${requiredVersion(encounter)}\"`,
        },
      },
      {
        resource: buildUiProvenance(
          sourceTag,
          [`Condition/${conditionId}`, `Encounter/${encounterId}`],
          "UPDATE",
          recorded,
        ),
        request: { method: "POST", url: "Provenance" },
      },
    ],
  }, sourceTag);
  assertTransactionSuccess(response);
}

function encounterAfterDiagnosisRetraction(
  encounter: Encounter,
  condition: Condition,
): Encounter {
  const targetIndex = encounterDiagnosisIndex(encounter.diagnosis ?? [], condition);
  const remaining = (encounter.diagnosis ?? [])
    .flatMap((diagnosis, index) => index === targetIndex ? [] : [{ diagnosis, index }])
    .sort((left, right) =>
      (left.diagnosis.rank ?? Number.MAX_SAFE_INTEGER) -
        (right.diagnosis.rank ?? Number.MAX_SAFE_INTEGER) ||
      left.index - right.index
    )
    .map(({ diagnosis }, index) => ({ ...diagnosis, rank: index + 1 }));
  if (remaining.length > 0) {
    return { ...encounter, diagnosis: remaining };
  }
  const { diagnosis: _diagnosis, ...encounterWithoutDiagnosis } = encounter;
  return encounterWithoutDiagnosis;
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
  targetReference: string | readonly string[],
  activityCode: "CREATE" | "UPDATE",
  entityDisplay?: string,
  patientReference?: string,
): Promise<Provenance> {
  return fhir.create<Provenance>(buildUiProvenance(
    sourceTag,
    [
      ...(typeof targetReference === "string" ? [targetReference] : [...targetReference]),
      ...(patientReference ? [patientReference] : []),
    ].filter((reference, index, all) => all.indexOf(reference) === index),
    activityCode,
    new Date().toISOString(),
    entityDisplay,
  ), sourceTag);
}

function buildUiProvenance(
  sourceTag: string,
  targetReferences: string[],
  activityCode: "CREATE" | "UPDATE",
  recorded: string,
  entityDisplay?: string,
): Provenance {
  return {
    resourceType: "Provenance",
    target: targetReferences.map((reference) => ({ reference })),
    recorded,
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
        who: { display: `ODOS UI ${sourceTag}` },
      },
    ],
    ...(entityDisplay
      ? { entity: [{ role: "revision", what: { display: entityDisplay } }] }
      : {}),
  };
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
