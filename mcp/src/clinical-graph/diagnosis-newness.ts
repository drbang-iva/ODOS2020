import type { Condition, Encounter, Resource } from "@medplum/fhirtypes";
import { searchAll, type FhirSearchClient } from "../fhir-search.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "./diagnosis-pick-endpoint.js";
import { parseDiagnosisIdentifier } from "./diagnosis-identifier.js";
import type { DiagnosisNewnessOverride, DiagnosisNewnessRow } from "./diagnosis-newness-types.js";
import type { DiagnosisVisitStatusRow } from "./diagnosis-visit-status-store.js";

export interface DiagnosisHistoryClient extends FhirSearchClient {
  read<T extends Resource>(type: T["resourceType"], id: string): Promise<T>;
}

export interface PriorDiagnosis {
  condition: Condition;
  encounter: Encounter;
}

function catalogKey(condition: Condition): string | undefined {
  const identifier = condition.identifier?.find((row) => row.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM)?.value;
  return parseDiagnosisIdentifier(identifier, condition.encounter?.reference?.replace(/^Encounter\//, "") ?? "").diagnosisKey;
}

function codeFamilies(condition: Condition): string[] {
  return (condition.code?.coding ?? []).flatMap((coding) => {
    if (coding.system !== "http://hl7.org/fhir/sid/icd-10-cm") return [];
    const code = coding.code?.trim().toUpperCase();
    return code && /^[A-Z][0-9][A-Z0-9](?:\.?[A-Z0-9]{1,4})?$/.test(code) ? [code.slice(0, 3)] : [];
  });
}

export function diagnosisHistoryMatch(current: Condition, prior: Condition): DiagnosisNewnessRow["matchedBy"] {
  const currentKey = catalogKey(current);
  const priorKey = catalogKey(prior);
  if (currentKey && priorKey) return currentKey === priorKey ? "catalog-key" : undefined;
  return codeFamilies(current).some((family) => codeFamilies(prior).includes(family)) ? "icd10-category" : undefined;
}

export function doctorNewness(
  conditionReference: string,
  override: DiagnosisNewnessOverride | undefined,
  legacy: DiagnosisVisitStatusRow | undefined,
): DiagnosisNewnessRow | undefined {
  if (override) return { conditionReference, value: override.value, source: "doctor" };
  if (legacy?.status === "new") return { conditionReference, value: "new", source: "doctor" };
  return undefined;
}

export function encounterStart(encounter: Encounter): number {
  const value = encounter.period?.start;
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("A full encounter start instant is required for the New / Established suggestion.");
  }
  return Date.parse(value);
}

export function twelveMonthsBefore(instant: number): number {
  const cutoff = new Date(instant);
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  return cutoff.getTime();
}

export async function readPriorDiagnoses(fhir: DiagnosisHistoryClient, encounter: Encounter): Promise<PriorDiagnosis[]> {
  const patient = encounter.subject?.reference;
  if (!patient?.match(/^Patient\/[A-Za-z0-9.-]+$/)) throw new Error("The encounter must reference a patient.");
  const start = encounterStart(encounter);
  const visits = await searchAll<Encounter>(fhir, "Encounter", { subject: patient, date: `ge${new Date(twelveMonthsBefore(start)).toISOString()}` });
  const prior: PriorDiagnosis[] = [];
  for (const visit of visits) {
    if (visit.subject?.reference !== patient) throw new Error("Patient history returned an unrelated encounter.");
    if (visit.id === encounter.id || visit.status === "entered-in-error" || visit.status === "cancelled") continue;
    const date = encounterStart(visit);
    if (date >= start || date < twelveMonthsBefore(start)) continue;
    for (const diagnosis of visit.diagnosis ?? []) {
      const match = diagnosis.condition.reference?.match(/^Condition\/([A-Za-z0-9.-]+)$/);
      if (!match) continue;
      const condition = await fhir.read<Condition>("Condition", match[1]!);
      if (condition.subject.reference !== patient || condition.encounter?.reference !== `Encounter/${visit.id}`) {
        throw new Error("Diagnosis history does not belong to its patient and encounter.");
      }
      if (condition.verificationStatus?.coding?.some((coding) => ["refuted", "entered-in-error"].includes(coding.code ?? ""))) continue;
      prior.push({ condition, encounter: visit });
    }
  }
  return prior;
}

export function suggestDiagnosisNewness(condition: Condition, history: PriorDiagnosis[]): DiagnosisNewnessRow {
  const matches = history.flatMap((prior) => {
    const matchedBy = diagnosisHistoryMatch(condition, prior.condition);
    return matchedBy ? [{ ...prior, matchedBy }] : [];
  }).sort((left, right) => encounterStart(right.encounter) - encounterStart(left.encounter));
  const latest = matches[0];
  if (!latest) return { conditionReference: `Condition/${condition.id}`, value: "new", source: "suggestion" };
  const latestVisit = matches.filter((row) => row.encounter.id === latest.encounter.id);
  const isResolved = (prior: PriorDiagnosis) => prior.condition.clinicalStatus?.coding?.some((coding) =>
    coding.system === "http://terminology.hl7.org/CodeSystem/condition-clinical" && coding.code === "resolved",
  ) === true;
  const sameInstantOtherVisit = matches.filter((row) => row.encounter.id !== latest.encounter.id && encounterStart(row.encounter) === encounterStart(latest.encounter));
  if (sameInstantOtherVisit.some((row) => isResolved(row) !== latestVisit.every(isResolved))) {
    throw new Error("Matching visits have the same start time and conflicting resolution states.");
  }
  return {
    conditionReference: `Condition/${condition.id}`,
    value: latestVisit.every(isResolved) ? "new" : "established",
    source: "suggestion",
    matchedBy: latest.matchedBy,
    matchedEncounterReference: `Encounter/${latest.encounter.id}`,
  };
}
