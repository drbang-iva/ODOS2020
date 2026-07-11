import type { Basic, Bundle, Observation } from "@medplum/fhirtypes";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { OSOD_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import { FhirDiagnosisPickTallyStore } from "./diagnosis-pick-tally-store.js";
import { evaluateMappingTrigger } from "./diagnosis-mapping.js";
import { FhirFindingDefinitionStore } from "./finding-definition-store.js";
import {
  evaluateGlaucomaDiagnosisSuggestions,
  evaluateIopDiagnosisSuggestions,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type DiagnosisCatalogRow,
  type DiagnosisSuggestionEvaluation,
  type FindingInstance,
  type FindingInterpretation,
  type FindingValue,
} from "./glaucoma-suspect.js";
import { evaluateRefractiveErrorSuggestions } from "./refraction-suspect.js";

export interface DiagnosisCandidatesFhirClient {
  search<T extends Basic | Observation>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface DiagnosisCandidateRow {
  diagnosisKey: string;
  display: string;
  icd10?: { code: string; display?: string } | {
    pattern: {
      unspecifiedEye?: string;
      right?: string;
      left?: string;
      bilateral?: string;
    };
  };
  codingStatus: DiagnosisCatalogRow["codingStatus"];
  priority: boolean;
  source: "rule" | "mapping";
}

export interface OrderedCandidate extends DiagnosisCandidateRow {
  order: number;
}

export async function handleDiagnosisCandidatesRequest(
  deps: {
    authenticate(authHeader: string | undefined): Promise<{
      staffReference: string;
      actorRole: PracticeRoleId;
      fhir: DiagnosisCandidatesFhirClient;
    } | null>;
    now?: () => string;
  },
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read diagnosis candidates." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const encounterId = readEncounterId(input.params);
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  const encounterReference = `Encounter/${encounterId}`;
  const [definitions, catalog, observations, tally] = await Promise.all([
    new FhirFindingDefinitionStore(staff.fhir).list(),
    new FhirDiagnosisCatalogStore(staff.fhir).list(),
    staff.fhir.search<Observation>("Observation", { encounter: encounterReference, _count: "500" }),
    new FhirDiagnosisPickTallyStore(staff.fhir).read(staff.staffReference),
  ]);
  const findings = (observations.entry ?? []).flatMap((entry) =>
    entry.resource ? observationToFinding(entry.resource, definitions) : []
  );
  const provenance: ClinicalGraphProvenance = {
    source: "rule",
    recordedAt: deps.now?.() ?? new Date().toISOString(),
    actorReference: staff.staffReference,
    note: "Encounter diagnosis-candidates read; no suggestion edges or diagnoses persisted.",
  };
  const rules = [
    ...evaluateGlaucomaDiagnosisSuggestions({ findings, findingDefinitions: definitions, encounterReference, provenance }),
    ...evaluateIopDiagnosisSuggestions({ findings, findingDefinitions: definitions, encounterReference, provenance }),
    ...evaluateRefractiveErrorSuggestions({ findings, findingDefinitions: definitions, encounterReference, provenance }),
  ];
  const rulesByFinding = groupRulesByFinding(rules);
  const activeCatalog = new Map(catalog.filter((row) => row.active).map((row) => [row.stableKey, row]));

  return {
    status: 200,
    body: {
      encounterReference,
      findings: findings.map((finding) => {
        const definition = definitions.find((row) => row.id === finding.findingDefinitionId);
        const ruleCandidates = (rulesByFinding.get(finding.id) ?? []).flatMap((evaluation, order) => {
          const diagnosisKey = catalogKeyForRule(evaluation.diagnosisDefinition.stableKey);
          const row = activeCatalog.get(diagnosisKey);
          if (!row) return [];
          const icd10 = resolvedIcd10(row, finding.laterality);
          return [{
            diagnosisKey,
            display: row.display,
            ...(icd10 ? { icd10 } : {}),
            codingStatus: row.codingStatus,
            priority: true,
            source: "rule" as const,
            order,
          }];
        });
        const mappingCandidates = (definition?.allowDiagnosisMapping === false ? [] : definition?.diagnosisCandidates ?? []).flatMap((mapping, order) => {
          if (!mapping.active || !evaluateMappingTrigger(mapping.trigger, finding)) return [];
          const row = activeCatalog.get(mapping.diagnosisKey);
          if (!row) return [];
          const icd10 = resolvedIcd10(row, finding.laterality);
          return [{
            diagnosisKey: row.stableKey,
            display: row.display,
            ...(icd10 ? { icd10 } : {}),
            codingStatus: row.codingStatus,
            priority: mapping.priority === true,
            source: "mapping" as const,
            order,
          }];
        });
        return {
          findingInstanceId: finding.id,
          findingDefinitionKey: definition?.stableKey,
          observationReference: finding.observationReference,
          candidates: orderDiagnosisCandidates(
            deduplicateDiagnosisCandidates([...ruleCandidates, ...mappingCandidates]),
            definition?.stableKey ? tally?.counts[definition.stableKey] : undefined,
          ),
        };
      }),
    },
  };
}

export function deduplicateDiagnosisCandidates(candidates: readonly OrderedCandidate[]): OrderedCandidate[] {
  const byDiagnosisKey = new Map<string, OrderedCandidate>();
  for (const candidate of candidates) {
    const current = byDiagnosisKey.get(candidate.diagnosisKey);
    if (!current || candidate.source === "rule" && current.source !== "rule") {
      byDiagnosisKey.set(candidate.diagnosisKey, candidate);
      continue;
    }
    if (current.source === "rule" && candidate.source !== "rule") continue;
    if (Number(candidate.priority) > Number(current.priority) ||
      candidate.priority === current.priority && candidate.order < current.order) {
      byDiagnosisKey.set(candidate.diagnosisKey, candidate);
    }
  }
  return [...byDiagnosisKey.values()];
}

export function orderDiagnosisCandidates(
  candidates: readonly OrderedCandidate[],
  counts: Readonly<Record<string, number>> = {},
): DiagnosisCandidateRow[] {
  return [...candidates]
    .sort((left, right) =>
      (counts[right.diagnosisKey] ?? 0) - (counts[left.diagnosisKey] ?? 0) ||
      Number(right.priority) - Number(left.priority) ||
      left.order - right.order ||
      left.display.localeCompare(right.display)
    )
    .map(({ order: _order, ...candidate }) => candidate);
}

function observationToFinding(
  observation: Observation,
  definitions: readonly ClinicalFindingDefinition[],
): FindingInstance[] {
  const definition = definitions.find((row) => observationMatchesDefinition(observation, row));
  const id = observation.id;
  const encounterReference = observation.encounter?.reference;
  const patientReference = observation.subject?.reference;
  const recordedAt = observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated;
  if (!definition || !id || !encounterReference || !patientReference || !recordedAt) return [];
  const value = findingValueFromObservation(observation, definition);
  if (!value) return [];
  return [{
    id,
    findingDefinitionId: definition.id,
    patientReference,
    encounterReference,
    observationReference: `Observation/${id}`,
    laterality: observationLaterality(observation),
    value,
    interpretation: observationInterpretation(observation),
    method: observation.method,
    performerReferences: (observation.performer ?? []).flatMap((row) => row.reference ? [row.reference] : []),
    sourceReferences: (observation.derivedFrom ?? []).flatMap((row) => row.reference ? [row.reference] : []),
    sourceType: observation.note?.some((note) => note.text?.includes("sourceType=device")) ? "device" : "manual",
    recordedAt,
    provenance: { source: "manual", recordedAt },
  }];
}

function observationMatchesDefinition(observation: Observation, definition: ClinicalFindingDefinition): boolean {
  const expected = new Set([
    definition.stableKey.toLowerCase(),
    ...(definition.fhirObservationCode?.coding ?? []).flatMap((coding) => coding.code ? [coding.code.toLowerCase()] : []),
  ]);
  return observation.code.coding?.some((coding) => coding.code && expected.has(coding.code.toLowerCase())) === true;
}

function findingValueFromObservation(
  observation: Observation,
  definition: ClinicalFindingDefinition,
): FindingValue | undefined {
  if (definition.stableKey === "refraction") return refractionFindingValue(observation);
  if (observation.valueQuantity?.value !== undefined) {
    return {
      type: "quantity",
      value: observation.valueQuantity.value,
      unit: observation.valueQuantity.unit ?? "",
      ...(observation.valueQuantity.system ? { system: observation.valueQuantity.system } : {}),
      ...(observation.valueQuantity.code ? { code: observation.valueQuantity.code } : {}),
    };
  }
  if (observation.valueBoolean !== undefined) return { type: "boolean", value: observation.valueBoolean };
  if (observation.valueString !== undefined) {
    try {
      const parsed = JSON.parse(observation.valueString) as unknown;
      if (isRecord(parsed)) return { type: "json", value: parsed };
    } catch {
      return { type: "string", value: observation.valueString };
    }
    return { type: "string", value: observation.valueString };
  }
  if (observation.component?.length) {
    return {
      type: "components",
      components: observation.component.flatMap((component) => {
        const code = component.code.coding?.find((coding) => coding.code)?.code;
        const display = component.code.text ?? component.code.coding?.find((coding) => coding.display)?.display ?? code;
        const value = component.valueQuantity?.value ?? component.valueString ?? component.valueBoolean ?? component.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
        if (!code || !display || value === undefined) return [];
        return [{ code, display, value, ...(component.valueQuantity?.unit ? { unit: component.valueQuantity.unit } : {}) }];
      }),
    };
  }
  return undefined;
}

function refractionFindingValue(observation: Observation): FindingValue | undefined {
  const component = (code: string) => observation.component?.find((row) =>
    row.code.coding?.some((coding) => coding.code === code)
  );
  const refractionType = component("REFRACTION_TYPE")?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  const blockId = component("REFRACTION_BLOCK_ID")?.valueString;
  if (!refractionType || !blockId) return undefined;
  return {
    type: "json",
    value: compactRecord({
      blockId,
      refractionType,
      sphere: component("SPHERE")?.valueQuantity?.value,
      cylinder: component("CYLINDER")?.valueQuantity?.value,
      axis: component("AXIS")?.valueQuantity?.value,
      add: component("ADD")?.valueQuantity?.value,
      customFields: observation.component?.flatMap((row) => {
        const code = row.code.coding?.find((coding) => coding.code?.startsWith("CUSTOM_"))?.code;
        const value = row.valueQuantity?.value ?? row.valueString ?? row.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
        return code && value !== undefined ? [{ code, value }] : [];
      }) ?? [],
    }),
  };
}

function observationLaterality(observation: Observation): FindingInstance["laterality"] {
  const code = observation.extension?.find((extension) => extension.url === OSOD_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    observation.bodySite?.coding?.find((coding) => coding.code)?.code;
  return code === "OD" || code === "OS" || code === "OU" ? code : "UNKNOWN";
}

function observationInterpretation(observation: Observation): FindingInterpretation | undefined {
  const code = observation.interpretation?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.code)?.code?.toLowerCase();
  if (code === "a" || code === "abnormal") return "abnormal";
  if (code === "b" || code === "borderline") return "borderline";
  if (code === "n" || code === "normal") return "normal";
  return code ? "unknown" : undefined;
}

function resolvedIcd10(row: DiagnosisCatalogRow, laterality: FindingInstance["laterality"]): DiagnosisCandidateRow["icd10"] | undefined {
  if (!row.icd10) return undefined;
  if ("code" in row.icd10) return row.icd10;
  const code = laterality === "OD" ? row.icd10.pattern.right
    : laterality === "OS" ? row.icd10.pattern.left
    : laterality === "OU" ? row.icd10.pattern.bilateral
    : row.icd10.pattern.unspecifiedEye;
  return code ? { code } : { pattern: row.icd10.pattern };
}

function groupRulesByFinding(rows: readonly DiagnosisSuggestionEvaluation[]) {
  const grouped = new Map<string, DiagnosisSuggestionEvaluation[]>();
  for (const row of rows) {
    const id = row.suggestionEdge.sourceFindingInstanceId;
    if (id) grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return grouped;
}

function catalogKeyForRule(stableKey: string): string {
  if (stableKey.startsWith("glaucoma_suspect_open_angle_low_")) return "glaucoma_suspect_open_angle_low";
  if (stableKey.startsWith("glaucoma_suspect_open_angle_high_")) return "glaucoma_suspect_open_angle_high";
  if (stableKey.startsWith("ocular_hypertension_")) return "ocular_hypertension";
  for (const family of ["hyperopia", "myopia", "astigmatism", "anisometropia", "presbyopia"] as const) {
    if (stableKey === family || stableKey.startsWith(`${family}_`)) return family;
  }
  return stableKey;
}

function readEncounterId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.encounterId;
  return typeof id === "string" && /^[A-Za-z0-9.-]+$/.test(id) ? id : undefined;
}

function staffMay(role: PracticeRoleId, action: "chart.read"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, row]) => row !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
