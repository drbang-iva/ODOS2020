import type {
  AllergyIntolerance,
  CareTeam,
  CodeableConcept,
  Condition,
  Encounter,
  EpisodeOfCare,
  Observation,
  Reference,
} from "@medplum/fhirtypes";
import {
  FHIR_CONDITION_CATEGORY_CODE_SYSTEM,
  FHIR_CONDITION_CLINICAL_STATUS_CODE_SYSTEM,
  encounterDiagnosisProblemStatus,
  type MdmProblemStatus,
} from "./fhir-clinical/condition";
import {
  ODOS_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
  type EpisodeOfCareTypeCode,
} from "./fhir-clinical/episodeOfCare";
import {
  TOBACCO_SMOKING_STATUS_LOINC_CODE,
  US_CORE_SMOKING_STATUS_PROFILE,
} from "./fhir-clinical/smokingStatus";

export type MdmTier = "None" | "Straightforward" | "Low" | "Moderate" | "High";

export interface MdmCounts {
  minimalSelfLimited: number;
  stableChronic: number;
  chronicExacerbationProgression: number;
  chronicSevereExacerbation: number;
  acuteUncomplicated: number;
  acuteComplicatedOrSystemic: number;
  undiagnosedNewProblemUncertainPrognosis: number;
  threatToLifeOrBodilyFunction: number;
}

export interface ReadyMdmHint {
  status: "ready";
  tier: MdmTier;
  counts: MdmCounts;
  sourceDiagnosisCount: number;
}

export interface BlockedMdmHint {
  status: "blocked";
  reason: string;
  missingProblemStatusCount: number;
  counts: MdmCounts;
  sourceDiagnosisCount: number;
}

export type MdmHint = ReadyMdmHint | BlockedMdmHint;

export function displayCode(concept: CodeableConcept | undefined): string {
  return (
    concept?.text ??
    concept?.coding?.find((coding) => coding.display)?.display ??
    concept?.coding?.find((coding) => coding.code)?.code ??
    "Uncoded"
  );
}

export function codingCode(concept: CodeableConcept | undefined, system?: string): string | undefined {
  const coding = concept?.coding?.find((item) => !system || item.system === system);
  return coding?.code;
}

export function clinicalStatus(condition: Condition): string {
  return (
    codingCode(condition.clinicalStatus, FHIR_CONDITION_CLINICAL_STATUS_CODE_SYSTEM) ??
    condition.clinicalStatus?.text ??
    "unknown"
  );
}

export function isActiveCondition(condition: Condition): boolean {
  const status = clinicalStatus(condition);
  return status === "active" || status === "recurrence" || status === "relapse";
}

export function isProblemListCondition(condition: Condition): boolean {
  return Boolean(
    condition.category?.some((category) =>
      category.coding?.some(
        (coding) =>
          coding.system === FHIR_CONDITION_CATEGORY_CODE_SYSTEM &&
          coding.code === "problem-list-item",
      ),
    ),
  );
}

export function isEncounterDiagnosisCondition(condition: Condition): boolean {
  return Boolean(
    condition.category?.some((category) =>
      category.coding?.some(
        (coding) =>
          coding.system === FHIR_CONDITION_CATEGORY_CODE_SYSTEM &&
          coding.code === "encounter-diagnosis",
      ),
    ),
  );
}

export function isSmokingStatusObservation(observation: Observation): boolean {
  return Boolean(
    observation.meta?.profile?.includes(US_CORE_SMOKING_STATUS_PROFILE) ||
      observation.code.coding?.some(
        (coding) => coding.system === "http://loinc.org" && coding.code === TOBACCO_SMOKING_STATUS_LOINC_CODE,
      ),
  );
}

export function newestSmokingStatus(observations: Observation[]): Observation | undefined {
  return observations
    .filter(isSmokingStatusObservation)
    .sort((left, right) => timestamp(right.effectiveDateTime) - timestamp(left.effectiveDateTime))[0];
}

export function allergyLabel(allergy: AllergyIntolerance): string {
  return displayCode(allergy.code);
}

export function careTeamParticipantLabel(participant: NonNullable<CareTeam["participant"]>[number]): string {
  const role = participant.role?.map(displayCode).filter(Boolean).join(", ") || "Team member";
  const member = participant.member?.display ?? participant.member?.reference ?? "No member reference";
  return `${role}: ${member}`;
}

export function episodeTypeLabel(episode: EpisodeOfCare): string {
  const code = episode.type?.[0]?.coding?.find(
    (coding) => coding.system === ODOS_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
  )?.code as EpisodeOfCareTypeCode | undefined;

  if (code === "myopia-management") return "Myopia management";
  if (code === "glaucoma") return "Glaucoma";
  if (code === "dry-eye") return "Dry eye";
  if (code === "diabetic-eye-care") return "Diabetic eye care";
  return displayCode(episode.type?.[0]);
}

export function encounterEpisodeReferences(encounter: Encounter): string[] {
  return (encounter.episodeOfCare ?? [])
    .map((episode) => episode.reference)
    .filter((reference): reference is string => Boolean(reference));
}

export function linkedEncounterCount(episode: EpisodeOfCare, encounters: Encounter[]): number {
  const episodeReference = `EpisodeOfCare/${episode.id}`;
  return encounters.filter((encounter) =>
    encounterEpisodeReferences(encounter).includes(episodeReference),
  ).length;
}

export function standaloneEncounters(encounters: Encounter[]): Encounter[] {
  return encounters.filter((encounter) => encounterEpisodeReferences(encounter).length === 0);
}

export function diagnosisRank(encounter: Encounter, condition: Condition): number | undefined {
  const conditionReference = `Condition/${condition.id}`;
  return encounter.diagnosis?.find((diagnosis) => diagnosis.condition.reference === conditionReference)?.rank;
}

export function computeMdmHint(input: { encounter: Encounter }): MdmHint {
  const counts: MdmCounts = {
    minimalSelfLimited: 0,
    stableChronic: 0,
    chronicExacerbationProgression: 0,
    chronicSevereExacerbation: 0,
    acuteUncomplicated: 0,
    acuteComplicatedOrSystemic: 0,
    undiagnosedNewProblemUncertainPrognosis: 0,
    threatToLifeOrBodilyFunction: 0,
  };
  let missingProblemStatusCount = 0;

  for (const diagnosis of input.encounter.diagnosis ?? []) {
    const status = encounterDiagnosisProblemStatus(diagnosis);
    if (!status) {
      missingProblemStatusCount += 1;
      continue;
    }
    incrementMdmCount(counts, status);
  }

  if (missingProblemStatusCount > 0) {
    return {
      status: "blocked",
      reason: `problem status unset on ${missingProblemStatusCount} ${missingProblemStatusCount === 1 ? "diagnosis" : "diagnoses"}`,
      missingProblemStatusCount,
      counts,
      sourceDiagnosisCount: input.encounter.diagnosis?.length ?? 0,
    };
  }

  return {
    status: "ready",
    tier: mdmTier(counts),
    counts,
    sourceDiagnosisCount: input.encounter.diagnosis?.length ?? 0,
  };
}

export function mdmTier(counts: MdmCounts): MdmTier {
  if (counts.chronicSevereExacerbation >= 1 || counts.threatToLifeOrBodilyFunction >= 1) return "High";
  if (
    counts.stableChronic >= 2 ||
    counts.chronicExacerbationProgression >= 1 ||
    counts.acuteComplicatedOrSystemic >= 1 ||
    counts.undiagnosedNewProblemUncertainPrognosis >= 1
  ) {
    return "Moderate";
  }
  if (counts.stableChronic >= 1 || counts.minimalSelfLimited >= 2 || counts.acuteUncomplicated >= 1) return "Low";
  if (counts.minimalSelfLimited >= 1) return "Straightforward";
  return "None";
}

function incrementMdmCount(counts: MdmCounts, status: MdmProblemStatus): void {
  if (status === "minimal-self-limited") counts.minimalSelfLimited += 1;
  else if (status === "stable-chronic") counts.stableChronic += 1;
  else if (status === "chronic-exacerbation-progression") counts.chronicExacerbationProgression += 1;
  else if (status === "chronic-severe-exacerbation") counts.chronicSevereExacerbation += 1;
  else if (status === "acute-uncomplicated") counts.acuteUncomplicated += 1;
  else if (status === "acute-complicated-or-systemic-symptoms") counts.acuteComplicatedOrSystemic += 1;
  else if (status === "undiagnosed-new-problem-uncertain-prognosis") counts.undiagnosedNewProblemUncertainPrognosis += 1;
  else counts.threatToLifeOrBodilyFunction += 1;
}

export function referenceId(reference: Reference | undefined, resourceType: string): string | undefined {
  const value = reference?.reference;
  if (!value) return undefined;
  return value.startsWith(`${resourceType}/`) ? value.slice(resourceType.length + 1) : undefined;
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}
