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
} from "./fhir-clinical/condition";
import {
  OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
  type EpisodeOfCareTypeCode,
} from "./fhir-clinical/episodeOfCare";
import {
  TOBACCO_SMOKING_STATUS_LOINC_CODE,
  US_CORE_SMOKING_STATUS_PROFILE,
} from "./fhir-clinical/smokingStatus";

export type MdmTier = "None" | "Low" | "Moderate" | "High";

export interface MdmCounts {
  stableChronic: number;
  minorSelfLimited: number;
  chronicExacerbation: number;
  acuteUncomplicated: number;
  severeExacerbationOrSystemic: number;
}

export interface MdmHint {
  tier: MdmTier;
  counts: MdmCounts;
  sourceConditionCount: number;
}

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
    (coding) => coding.system === OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
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

export function computeMdmHint(input: {
  encounter: Encounter;
  encounterConditions: Condition[];
  problemListConditions: Condition[];
}): MdmHint {
  const activeProblems = input.problemListConditions.filter(isActiveCondition);
  const activeEncounterDiagnoses = input.encounterConditions.filter(isActiveCondition);
  const counts: MdmCounts = {
    stableChronic: activeProblems.length,
    minorSelfLimited: 0,
    chronicExacerbation: 0,
    acuteUncomplicated: 0,
    severeExacerbationOrSystemic: 0,
  };

  for (const condition of activeEncounterDiagnoses) {
    const label = displayCode(condition.code).toLowerCase();
    if (label.includes("severe exacerbation") || label.includes("systemic symptoms")) {
      counts.severeExacerbationOrSystemic += 1;
    } else if (label.includes("exacerbation") || label.includes("side effect")) {
      counts.chronicExacerbation += 1;
    } else if (label.includes("minor") || label.includes("self-limited") || label.includes("self limited")) {
      counts.minorSelfLimited += 1;
    } else {
      counts.acuteUncomplicated += 1;
    }
  }

  return {
    tier: mdmTier(counts),
    counts,
    sourceConditionCount: activeProblems.length + activeEncounterDiagnoses.length,
  };
}

export function mdmTier(counts: MdmCounts): MdmTier {
  if (counts.severeExacerbationOrSystemic >= 1) return "High";
  if (
    counts.stableChronic >= 2 ||
    counts.chronicExacerbation >= 1 ||
    counts.acuteUncomplicated >= 1
  ) {
    return "Moderate";
  }
  if (counts.stableChronic >= 1 || counts.minorSelfLimited >= 2) return "Low";
  return "None";
}

export function referenceId(reference: Reference | undefined, resourceType: string): string | undefined {
  const value = reference?.reference;
  if (!value) return undefined;
  return value.startsWith(`${resourceType}/`) ? value.slice(resourceType.length + 1) : undefined;
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}
