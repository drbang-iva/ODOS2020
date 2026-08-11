import type { Basic, Bundle, Condition, Encounter, Observation, Resource } from "@medplum/fhirtypes";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { searchAll } from "../fhir-search.js";
import { isRelativeFhirReference } from "../fhir/reference.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import { FAMILY_RESOLUTION_MODES } from "./diagnosis-catalog-seeds.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "./diagnosis-pick-endpoint.js";
import { FhirFindingDefinitionStore } from "./finding-definition-store.js";
import { observationMatchesFindingDefinition } from "./finding-observation-match.js";
import type { ClinicalFindingDefinition, KeyFindingEntry } from "./glaucoma-suspect.js";

export interface DiagnosisCompletenessFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(
    url: string,
    resourceType: T["resourceType"],
  ): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface MissingKeyFinding {
  findingKey: string;
  display: string;
}

export interface DiagnosisCompletenessRow {
  conditionReference?: string;
  diagnosisKey: string;
  laterality: string;
  display: string;
  missing: MissingKeyFinding[];
}

export async function handleDiagnosisCompletenessRequest(
  deps: {
    authenticate(authHeader: string | undefined): Promise<{
      actorRole: PracticeRoleId;
      fhir: DiagnosisCompletenessFhirClient;
    } | null>;
    now?: () => string;
  },
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read diagnosis completeness." } };
  if (!staffMayReadChart(staff.actorRole)) return { status: 403, body: { error: "chart.read role required" } };
  const encounterId = readEncounterId(input.params);
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };

  const encounterReference = `Encounter/${encounterId}`;
  const [encounter, conditions, catalog, definitions, encounterObservations] = await Promise.all([
    staff.fhir.read<Encounter>("Encounter", encounterId),
    searchAll<Condition>(staff.fhir, "Condition", { encounter: encounterReference }),
    new FhirDiagnosisCatalogStore(staff.fhir).list(),
    new FhirFindingDefinitionStore(staff.fhir).list(),
    searchAll<Observation>(staff.fhir, "Observation", { encounter: encounterReference }),
  ]);
  const confirmed = conditions.filter(isActiveConfirmedEncounterDiagnosis);
  const catalogByKey = new Map(catalog.map((row) => [row.stableKey, row]));
  const definitionsByKey = new Map(definitions.map((definition) => [definition.stableKey, definition]));
  const needsHistory = confirmed.some((condition) => {
    const identity = diagnosisIdentity(condition);
    return identity && catalogByKey.get(identity.diagnosisKey)?.keyFindings?.some((entry) =>
      entry.active && entry.satisfiedBy === "any-on-file"
    );
  });
  const patientReference = encounter.subject?.reference;
  const historyObservations = needsHistory && isRelativeFhirReference(patientReference, "Patient")
    ? await searchAll<Observation>(staff.fhir, "Observation", { subject: patientReference })
    : [];
  const now = new Date(deps.now?.() ?? new Date().toISOString());

  const diagnoses = confirmed.flatMap((condition): DiagnosisCompletenessRow[] => {
    const identity = diagnosisIdentity(condition);
    if (!identity) return [];
    const familyMode = FAMILY_RESOLUTION_MODES[identity.diagnosisKey];
    const pendingStage = familyMode?.mode === "staged" && !condition.code?.coding?.some((coding) =>
      coding.system === "http://hl7.org/fhir/sid/icd-10-cm" && coding.code
    );
    const diagnosis = catalogByKey.get(identity.diagnosisKey) ??
      (familyMode?.mode === "staged" ? catalogByKey.get(familyMode.members[0]!.stableKey) : undefined);
    if (!diagnosis) return [];
    const missing = [
      ...(pendingStage ? [{ findingKey: "diagnosis-stage", display: "Code pending — stage required" }] : []),
      ...(!pendingStage ? diagnosis.keyFindings ?? [] : []).flatMap((entry): MissingKeyFinding[] => {
      if (!entry.active) return [];
      const definition = definitionsByKey.get(entry.findingKey);
      if (!definition) return [{ findingKey: entry.findingKey, display: entry.label ?? entry.findingKey }];
      if (keyFindingSatisfied(
        entry,
        definition,
        encounterObservations,
        historyObservations,
        now,
      )) return [];
      return [{ findingKey: entry.findingKey, display: entry.label ?? definition.display }];
      }),
    ];
    if (!missing.length) return [];
    return [{
      ...(condition.id ? { conditionReference: `Condition/${condition.id}` } : {}),
      diagnosisKey: identity.diagnosisKey,
      laterality: identity.laterality,
      display: pendingStage ? diagnosis.display.replace(/,.+$/, "") : diagnosis.display,
      missing,
    }];
  });

  return { status: 200, body: { encounterReference, diagnoses } };
}

function keyFindingSatisfied(
  entry: KeyFindingEntry,
  definition: ClinicalFindingDefinition,
  encounterObservations: readonly Observation[],
  historyObservations: readonly Observation[],
  now: Date,
): boolean {
  const observations = entry.satisfiedBy === "this-encounter" ? encounterObservations : historyObservations;
  return observations.some((observation) =>
    observationMatchesFindingDefinition(observation, definition) &&
    (entry.withinMonths === undefined || observationWithinMonths(observation, entry.withinMonths, now))
  );
}

function observationWithinMonths(observation: Observation, months: number, now: Date): boolean {
  const recorded = observation.effectiveDateTime ?? observation.effectivePeriod?.end ??
    observation.effectivePeriod?.start ?? observation.effectiveInstant ??
    latestTimingDate(observation) ?? observation.issued ?? observation.meta?.lastUpdated;
  if (!recorded) return false;
  const recordedAt = new Date(recorded);
  if (Number.isNaN(recordedAt.getTime()) || recordedAt > now) return false;
  const cutoff = monthsBefore(now, months);
  return recordedAt >= cutoff;
}

function latestTimingDate(observation: Observation): string | undefined {
  const timing = observation.effectiveTiming;
  const candidates = [
    ...(timing?.event ?? []),
    timing?.repeat?.boundsPeriod?.end,
    timing?.repeat?.boundsPeriod?.start,
  ].filter((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)));
  return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function monthsBefore(value: Date, months: number): Date {
  const cutoff = new Date(value);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  return cutoff;
}

function isActiveConfirmedEncounterDiagnosis(condition: Condition): boolean {
  return condition.verificationStatus?.coding?.some((coding) => coding.code === "confirmed") === true &&
    condition.clinicalStatus?.coding?.some((coding) => coding.code === "active") === true &&
    condition.identifier?.some((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM) === true;
}

function diagnosisIdentity(condition: Condition): { diagnosisKey: string; laterality: string } | undefined {
  const value = condition.identifier?.find((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
  )?.value;
  const [diagnosisKey, laterality] = value?.split("::").slice(-2) ?? [];
  return diagnosisKey && laterality ? { diagnosisKey, laterality } : undefined;
}

function readEncounterId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const encounterId = (value as Record<string, unknown>).encounterId;
  return typeof encounterId === "string" && /^[A-Za-z0-9.-]+$/.test(encounterId)
    ? encounterId
    : undefined;
}

function staffMayReadChart(role: PracticeRoleId): boolean {
  try {
    assertBusinessActionAllowed(role, "chart.read");
    return true;
  } catch {
    return false;
  }
}
