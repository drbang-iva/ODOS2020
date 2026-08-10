import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export type FindingLaterality = "OD" | "OS" | "OU" | "UNKNOWN";

export interface AtomicFindingCatalogRow {
  atomicFindingId: string;
  findingDefinitionId: string;
  findingDefinitionKey: string;
  fieldCode: string;
  optionCode: string;
  display: string;
  sectionKey: string;
  gradeScale: string[];
  diagnosisKeys: string[];
  origin: "shipped" | "custom";
}

export interface EncounterFindingRow extends AtomicFindingCatalogRow {
  laterality: FindingLaterality;
  lateralitySource: "inherited" | "explicit";
  source: "atomic" | "section" | "offered";
  presence?: "present" | "absent";
  grade?: string;
  observationReference?: string;
  conditionReference?: string;
  carried?: boolean;
  priorPresence?: "present" | "absent";
  priorGrade?: string;
  priorLaterality?: FindingLaterality;
}

export interface DiagnosisFindingsPayload {
  canWrite: boolean;
  diagnosis?: {
    id: string;
    stableKey: string;
    display: string;
    applicableFindingDefinitionIds: string[];
  };
  carryProvenance?: {
    pulledFromDate?: string;
    unchangedSinceDate?: string;
    edited: boolean;
    integrityWarning?: string;
  };
  findings: EncounterFindingRow[];
  catalog: AtomicFindingCatalogRow[];
  unassigned: EncounterFindingRow[];
  bySection: Record<string, EncounterFindingRow[]>;
  visitDiagnoses: Array<{
    conditionReference: string;
    diagnosisKey: string;
    display: string;
    laterality: FindingLaterality;
  }>;
  error?: string;
}

export type DiagnosisFindingMutation =
  | {
      action: "assert";
      patientReference: string;
      conditionReference: string;
      atomicFindingId: string;
      presence: "present" | "absent";
      laterality?: Exclude<FindingLaterality, "UNKNOWN">;
    }
  | { action: "clear"; patientReference: string; observationReference: string }
  | { action: "grade"; patientReference: string; observationReference: string; grade: string | null }
  | {
      action: "laterality";
      patientReference: string;
      observationReference: string;
      laterality: Exclude<FindingLaterality, "UNKNOWN"> | null;
    }
  | {
      action: "assign";
      patientReference: string;
      observationReference: string;
      conditionReference: string;
    }
  | { action: "standalone"; patientReference: string; observationReference: string };

export function orderedFindingRows(rows: readonly EncounterFindingRow[]): EncounterFindingRow[] {
  return [...rows].sort((left, right) => {
    const leftOffered = left.source === "offered" ? 1 : 0;
    const rightOffered = right.source === "offered" ? 1 : 0;
    return leftOffered - rightOffered || left.display.localeCompare(right.display) ||
      left.laterality.localeCompare(right.laterality);
  });
}

export function orderedFindingSearchRows(
  rows: readonly AtomicFindingCatalogRow[],
  diagnosisKey: string | undefined,
): AtomicFindingCatalogRow[] {
  return rows.map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftCandidate = diagnosisKey && left.row.diagnosisKeys.includes(diagnosisKey) ? 0 : 1;
      const rightCandidate = diagnosisKey && right.row.diagnosisKeys.includes(diagnosisKey) ? 0 : 1;
      return leftCandidate - rightCandidate || left.index - right.index;
    })
    .map(({ row }) => row);
}

export async function loadDiagnosisFindings(
  encounterReference: string,
  conditionReference?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiagnosisFindingsPayload> {
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const query = conditionReference ? `?condition=${encodeURIComponent(conditionReference)}` : "";
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/findings${query}`,
    { headers: authHeaders() },
  );
  const body = await response.json() as DiagnosisFindingsPayload;
  if (!response.ok) throw new Error(body.error ?? `Encounter findings failed: ${response.status}`);
  return body;
}

export async function mutateDiagnosisFinding(
  encounterReference: string,
  mutation: DiagnosisFindingMutation,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/findings`,
    {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(mutation),
    },
  );
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Encounter finding update failed: ${response.status}`);
}
