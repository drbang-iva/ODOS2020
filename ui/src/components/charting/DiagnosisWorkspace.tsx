import { useCallback, useEffect, useMemo, useState } from "react";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import {
  makeConditionPrincipal,
  swapConditionRanks,
  updateConditionBodySite,
  updateEncounterDiagnosisProblemStatus,
  type EyeChoice,
} from "../../lib/clinical-actions";
import {
  authHeaders,
  clinicalGraphApiBase,
  submitDiagnosisPick,
} from "../../lib/clinical-graph-client";
import { diagnosisRank, displayCode } from "../../lib/clinical-view-model";
import { fhir } from "../../lib/fhir";
import { encounterDiagnosisProblemStatus } from "../../lib/fhir-clinical/condition";
import { OdosSearchPicker, type OdosSearchPickerOption } from "../inputs/OdosSearchPicker";
import {
  DiagnosisProblemStatusField,
  DiagnosisRankActions,
  diagnosisRankMoveNeighbors,
} from "./AssessmentSection";
import { DiagnosisImagingRegion } from "./DiagnosisImagingRegion";
import {
  DiagnosisFindingsTable,
  UnassignedFindingsTray,
} from "./DiagnosisFindingsTable";
import {
  loadDiagnosisFindings,
  mutateDiagnosisFinding,
  type DiagnosisFindingMutation,
  type DiagnosisFindingsPayload,
} from "../../lib/diagnosis-findings";
import { formatDiagnosisHistoryDate } from "../../lib/diagnosis-carry-forward";
import { PreviousExams } from "./PreviousExams";

const DIAGNOSIS_KEY_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key";

export interface DiagnosisQuickListRow {
  stableKey: string;
  display: string;
  lateralityRequired: boolean;
  icd10?: { code: string; display?: string } | {
    pattern: { unspecifiedEye?: string; right?: string; left?: string; bilateral?: string };
  };
  pinned: boolean;
  tallyCount: number;
}

interface QuickListPayload {
  canWrite: boolean;
  pinnedDiagnosisKeys: string[];
  diagnoses: DiagnosisQuickListRow[];
  catalog: DiagnosisQuickListRow[];
  error?: string;
}

interface Props {
  patientReference: string;
  encounterReference: string;
  selectedReference?: string;
  onSelectDiagnosis: (reference: string | undefined) => void;
}

export function DiagnosisWorkspace({
  patientReference,
  encounterReference,
  selectedReference,
  onSelectDiagnosis,
}: Props) {
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const [encounter, setEncounter] = useState<Encounter>();
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [quickList, setQuickList] = useState<DiagnosisQuickListRow[]>([]);
  const [catalog, setCatalog] = useState<DiagnosisQuickListRow[]>([]);
  const [pinnedDiagnosisKeys, setPinnedDiagnosisKeys] = useState<string[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [findings, setFindings] = useState<DiagnosisFindingsPayload>();
  const [pendingDiagnosis, setPendingDiagnosis] = useState<DiagnosisQuickListRow>();
  const [searchSelection, setSearchSelection] = useState<OdosSearchPickerOption<DiagnosisQuickListRow>>();
  const [busy, setBusy] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextEncounter, quickResponse, nextFindings] = await Promise.all([
        fhir.read<Encounter>("Encounter", encounterId),
        fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-quick-list`, { headers: authHeaders() }),
        loadDiagnosisFindings(encounterReference, selectedReference),
      ]);
      const quickBody = await quickResponse.json() as QuickListPayload;
      if (!quickResponse.ok) throw new Error(quickBody.error ?? `Common diagnoses failed: ${quickResponse.status}`);
      const references = [...new Set((nextEncounter.diagnosis ?? []).flatMap((entry) =>
        entry.condition.reference?.startsWith("Condition/") ? [entry.condition.reference] : []
      ))];
      const nextConditions = await Promise.all(references.map((reference) =>
        fhir.read<Condition>("Condition", reference.replace(/^Condition\//, ""))
      ));
      setEncounter(nextEncounter);
      setConditions(nextConditions);
      setQuickList(quickBody.diagnoses ?? []);
      setCatalog(quickBody.catalog ?? []);
      setPinnedDiagnosisKeys(quickBody.pinnedDiagnosisKeys ?? []);
      setCanWrite(quickBody.canWrite === true);
      setFindings(nextFindings);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [encounterId, encounterReference, selectedReference]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ encounterReference?: string }>).detail;
      if (detail?.encounterReference === encounterReference) void load();
    };
    window.addEventListener("odos:diagnosis-picked", refresh);
    window.addEventListener("odos:encounter-diagnosis-updated", refresh);
    window.addEventListener("odos:encounter-findings-changed", refresh);
    return () => {
      window.removeEventListener("odos:diagnosis-picked", refresh);
      window.removeEventListener("odos:encounter-diagnosis-updated", refresh);
      window.removeEventListener("odos:encounter-findings-changed", refresh);
    };
  }, [encounterReference, load]);

  const visitConditions = useMemo(
    () => encounter ? orderedEncounterConditions(encounter, conditions) : [],
    [conditions, encounter],
  );
  const selectedCondition = visitConditions.find((condition) =>
    `Condition/${condition.id}` === selectedReference
  );

  async function run(label: string, action: () => Promise<void>): Promise<boolean> {
    setBusy(label);
    setError(undefined);
    try {
      await action();
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  async function updateFinding(mutation: DiagnosisFindingMutation) {
    const changed = await run(`finding:${mutation.action}`, async () => {
      await mutateDiagnosisFinding(encounterReference, mutation);
    });
    if (changed && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("odos:encounter-findings-changed", {
        detail: { encounterReference },
      }));
    }
  }

  async function addDiagnosis(row: DiagnosisQuickListRow, laterality?: EyeChoice) {
    if (row.lateralityRequired && !laterality) {
      setPendingDiagnosis(row);
      return;
    }
    const existing = visitConditions.find((condition) => conditionMatchesDiagnosisPick(condition, row, laterality));
    if (existing) {
      onSelectDiagnosis(`Condition/${existing.id}`);
      setPendingDiagnosis(undefined);
      return;
    }
    await run(`add:${row.stableKey}`, async () => {
      const result = await submitDiagnosisPick({
        encounterReference,
        diagnosisKey: row.stableKey,
        action: "confirm",
        source: "catalog-search",
        ...(laterality ? { laterality } : {}),
      });
      let condition = result.condition;
      if (laterality) {
        condition = await updateConditionBodySite({ condition, patientReference, laterality });
      }
      onSelectDiagnosis(`Condition/${condition.id}`);
      setPendingDiagnosis(undefined);
    });
  }

  async function persistPins(nextPins: string[]) {
    await run("pins", async () => {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-quick-list`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedDiagnosisKeys: nextPins }),
      });
      const body = await response.json() as QuickListPayload;
      if (!response.ok) throw new Error(body.error ?? `Common diagnoses update failed: ${response.status}`);
      setQuickList(body.diagnoses ?? []);
      setCatalog(body.catalog ?? []);
      setPinnedDiagnosisKeys(body.pinnedDiagnosisKeys ?? []);
    });
  }

  function searchDiagnoses(query: string): Promise<OdosSearchPickerOption<DiagnosisQuickListRow>[]> {
    const normalized = query.trim().toLocaleLowerCase();
    return Promise.resolve(catalog.flatMap((row) => {
      const code = diagnosisQuickListCode(row);
      if (!`${row.display} ${row.stableKey} ${code ?? ""}`.toLocaleLowerCase().includes(normalized)) return [];
      return [{ value: row.stableKey, label: row.display, description: code, item: row }];
    }).slice(0, 20));
  }

  const neighbors = encounter && selectedCondition
    ? diagnosisRankMoveNeighbors(encounter, visitConditions, selectedCondition)
    : {};
  const selectedEntry = encounter?.diagnosis?.find((entry) =>
    entry.condition.reference === selectedReference
  );
  const carryEditedForDisplay = Boolean(
    findings?.carryProvenance?.edited || findings?.carryProvenance?.integrityWarning,
  );

  return (
    <div className="odos-diagnosis-workspace min-h-0 flex-1" data-testid="diagnosis-workspace">
      <aside className="odos-diagnosis-rail" aria-label="Diagnosis rail">
        <h1 className="odos-diagnosis-rail-title">Diagnoses</h1>
        <RailHeading>This visit</RailHeading>
        <div className="odos-diagnosis-visit-list">
          {loading && <p className="odos-diagnosis-muted">Loading diagnoses…</p>}
          {!loading && visitConditions.length === 0 && <p className="odos-diagnosis-muted">No visit diagnoses.</p>}
          {visitConditions.map((condition) => {
            const reference = `Condition/${condition.id}`;
            const rank = encounter ? diagnosisRank(encounter, condition) : undefined;
            return (
              <button
                type="button"
                key={reference}
                aria-pressed={selectedReference === reference}
                className="odos-diagnosis-visit-row"
                onClick={() => onSelectDiagnosis(reference)}
              >
                <span>{displayCode(condition.code)}</span>
                <small>{condition.bodySite?.[0]?.text ?? "Scope not set"}{rank ? ` · ${rank}` : ""}</small>
              </button>
            );
          })}
        </div>
        {selectedCondition && encounter && (
          <DiagnosisRankActions
            possible={false}
            principal={diagnosisRank(encounter, selectedCondition) === 1}
            busy={diagnosisRankActionsDisabled(canWrite, busy)}
            canMoveUp={Boolean(neighbors.up)}
            canMoveDown={Boolean(neighbors.down)}
            onMakePrincipal={() => void run("rank", async () => {
              await makeConditionPrincipal({ encounter, condition: selectedCondition });
            })}
            onMoveUp={() => neighbors.up && void run("rank", async () => {
              await swapConditionRanks({ encounter, condition: selectedCondition, adjacentCondition: neighbors.up! });
            })}
            onMoveDown={() => neighbors.down && void run("rank", async () => {
              await swapConditionRanks({ encounter, condition: selectedCondition, adjacentCondition: neighbors.down! });
            })}
          />
        )}

        <RailHeading>Previous exams</RailHeading>
        <PreviousExams
          encounterReference={encounterReference}
          onSelectDiagnosis={onSelectDiagnosis}
        />

        <RailHeading>Common</RailHeading>
        <div className="odos-diagnosis-common-list">
          {!loading && quickList.length === 0 && <p className="odos-diagnosis-muted">No Common diagnoses configured.</p>}
          {quickList.map((row) => {
            const pinIndex = pinnedDiagnosisKeys.indexOf(row.stableKey);
            return (
              <div key={row.stableKey} className="odos-diagnosis-common-row">
                <button type="button" disabled={!canWrite || busy !== undefined} onClick={() => void addDiagnosis(row)}>
                  <span>{row.display}</span>
                  <small>{diagnosisQuickListCode(row) ?? "No ICD-10-CM code"}</small>
                </button>
                <div className="odos-diagnosis-pin-actions">
                  <button
                    type="button"
                    disabled={!canWrite || busy !== undefined}
                    aria-label={row.pinned ? `Unpin ${row.display}` : `Pin ${row.display}`}
                    onClick={() => void persistPins(row.pinned
                      ? pinnedDiagnosisKeys.filter((key) => key !== row.stableKey)
                      : [...pinnedDiagnosisKeys, row.stableKey])}
                  >{row.pinned ? "●" : "○"}</button>
                  {row.pinned && (
                    <>
                      <button type="button" aria-label={`Move ${row.display} up`} disabled={diagnosisPinMoveDisabled(canWrite, busy, pinIndex, pinnedDiagnosisKeys.length, -1)} onClick={() => void persistPins(movePinnedDiagnosis(pinnedDiagnosisKeys, row.stableKey, -1))}>↑</button>
                      <button type="button" aria-label={`Move ${row.display} down`} disabled={diagnosisPinMoveDisabled(canWrite, busy, pinIndex, pinnedDiagnosisKeys.length, 1)} onClick={() => void persistPins(movePinnedDiagnosis(pinnedDiagnosisKeys, row.stableKey, 1))}>↓</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <RailHeading>Find dx</RailHeading>
        <OdosSearchPicker
          label="Find diagnosis"
          value={searchSelection?.value ?? ""}
          selectedLabel={searchSelection?.label}
          placeholder="Search diagnosis catalog"
          search={searchDiagnoses}
          searchDelayMs={0}
          onClear={() => setSearchSelection(undefined)}
          onSelect={setSearchSelection}
          disabled={!canWrite || busy !== undefined}
        />
        {searchSelection && (
          <button className="odos-diagnosis-primary-action" type="button" disabled={busy !== undefined} onClick={() => void addDiagnosis(searchSelection.item)}>
            Add to this visit
          </button>
        )}
        {pendingDiagnosis && (
          <div className="odos-diagnosis-scope-prompt" role="group" aria-label={`Choose scope for ${pendingDiagnosis.display}`}>
            <span>Choose scope</span>
            {(["OD", "OS", "OU"] as const).map((eye) => (
              <button key={eye} type="button" disabled={busy !== undefined} onClick={() => void addDiagnosis(pendingDiagnosis, eye)}>{eye}</button>
            ))}
            <button type="button" onClick={() => setPendingDiagnosis(undefined)}>Cancel</button>
          </div>
        )}
        {findings && (
          <UnassignedFindingsTray
            rows={findings.unassigned}
            visitDiagnoses={findings.visitDiagnoses}
            patientReference={patientReference}
            disabled={!findings.canWrite || busy !== undefined}
            onMutate={(mutation) => void updateFinding(mutation)}
          />
        )}
      </aside>

      <main className="odos-diagnosis-center" aria-label="Selected diagnosis workspace">
        {error && <div role="alert" className="odos-diagnosis-error">{error}</div>}
        {!selectedCondition || !encounter || !selectedEntry ? (
          <div className="odos-diagnosis-empty">
            <h2>No diagnosis selected</h2>
            <p>Select a diagnosis from This visit, or add one from Common or Find dx.</p>
          </div>
        ) : (
          <div className="odos-diagnosis-selected">
            <div className="odos-diagnosis-selected-header">
              <div>
                <div className="odos-diagnosis-eyebrow">Selected diagnosis</div>
                <h2>{displayCode(selectedCondition.code)}</h2>
                <p>{selectedCondition.code?.coding?.[0]?.code ?? "Uncoded"}</p>
                {findings?.carryProvenance && (
                  <div className={`odos-diagnosis-carry-state ${carryEditedForDisplay ? "is-edited" : "is-unedited"}`}>
                    {findings.carryProvenance.pulledFromDate && (
                      <p>
                        pulled from {formatDiagnosisHistoryDate(findings.carryProvenance.pulledFromDate)} · {carryEditedForDisplay ? "edited" : "unedited"}
                      </p>
                    )}
                    {!carryEditedForDisplay &&
                      findings.carryProvenance.unchangedSinceDate &&
                      findings.carryProvenance.unchangedSinceDate !== findings.carryProvenance.pulledFromDate && (
                        <p>unchanged since {formatDiagnosisHistoryDate(findings.carryProvenance.unchangedSinceDate)}</p>
                      )}
                    {findings.carryProvenance.integrityWarning && (
                      <p className="odos-diagnosis-carry-warning" role="alert">
                        {findings.carryProvenance.integrityWarning}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="odos-diagnosis-laterality" role="group" aria-label="Diagnosis scope">
                {(["OD", "OS", "OU"] as const).map((eye) => (
                  <button
                    key={eye}
                    type="button"
                    aria-pressed={selectedCondition.bodySite?.[0]?.text === eye}
                    disabled={!canWrite || busy !== undefined}
                    onClick={() => void run("laterality", async () => {
                      await updateConditionBodySite({ condition: selectedCondition, patientReference, laterality: eye });
                    })}
                  >{eye}</button>
                ))}
              </div>
            </div>
            <DiagnosisProblemStatusField
              value={encounterDiagnosisProblemStatus(selectedEntry)}
              disabled={!canWrite || busy !== undefined}
              onChange={(problemStatus) => void run("problem-status", async () => {
                await updateEncounterDiagnosisProblemStatus({ encounter, condition: selectedCondition, problemStatus });
              })}
            />
            {findings ? (
              <DiagnosisFindingsTable
                payload={findings}
                patientReference={patientReference}
                conditionReference={selectedReference!}
                disabled={busy !== undefined}
                onMutate={(mutation) => void updateFinding(mutation)}
              />
            ) : (
              <p className="odos-diagnosis-muted">Loading findings…</p>
            )}
          </div>
        )}
      </main>

      <DiagnosisImagingRegion patientReference={patientReference} />
    </div>
  );
}

function RailHeading({ children }: { children: string }) {
  return <h2 className="odos-diagnosis-rail-heading">{children}</h2>;
}

export function orderedEncounterConditions(encounter: Encounter, conditions: readonly Condition[]): Condition[] {
  const byReference = new Map(conditions.map((condition) => [`Condition/${condition.id}`, condition]));
  return (encounter.diagnosis ?? []).flatMap((entry, index) => {
    const condition = entry.condition.reference ? byReference.get(entry.condition.reference) : undefined;
    return condition ? [{ condition, rank: entry.rank, index }] : [];
  }).sort((left, right) => {
    const leftRank = Number.isInteger(left.rank) ? left.rank! : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isInteger(right.rank) ? right.rank! : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.index - right.index;
  }).map(({ condition }) => condition);
}

export function diagnosisWorkspaceInstanceKey(patientReference: string, encounterReference: string): string {
  return `${patientReference}::${encounterReference}`;
}

export function diagnosisRankActionsDisabled(canWrite: boolean, busy: string | undefined): boolean {
  return !canWrite || busy !== undefined;
}

export function diagnosisPinMoveDisabled(
  canWrite: boolean,
  busy: string | undefined,
  index: number,
  count: number,
  direction: -1 | 1,
): boolean {
  if (!canWrite || busy !== undefined) return true;
  return direction === -1 ? index <= 0 : index < 0 || index >= count - 1;
}

export function diagnosisCatalogKey(condition: Condition): string | undefined {
  const value = diagnosisCatalogIdentifier(condition);
  if (!value) return undefined;
  const parts = value.split("::");
  return parts.length >= 2 ? parts.at(-2) : undefined;
}

export function conditionMatchesDiagnosisPick(
  condition: Condition,
  row: Pick<DiagnosisQuickListRow, "stableKey" | "lateralityRequired">,
  laterality?: EyeChoice,
): boolean {
  if (diagnosisCatalogKey(condition) !== row.stableKey) return false;
  if (!row.lateralityRequired) return true;
  const bucket = diagnosisCatalogIdentifier(condition)?.split("::").at(-1);
  return bucket === (laterality === "OD" ? "right" : laterality === "OS" ? "left" : laterality === "OU" ? "bilateral" : undefined);
}

function diagnosisCatalogIdentifier(condition: Condition): string | undefined {
  return condition.identifier?.find((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
  )?.value;
}

export function movePinnedDiagnosis(keys: readonly string[], key: string, direction: -1 | 1): string[] {
  const next = [...keys];
  const index = next.indexOf(key);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= next.length) return next;
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

function diagnosisQuickListCode(row: DiagnosisQuickListRow): string | undefined {
  if (!row.icd10) return undefined;
  return "code" in row.icd10 ? row.icd10.code : row.icd10.pattern.unspecifiedEye;
}
