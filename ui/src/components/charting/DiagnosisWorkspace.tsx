import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Condition, Encounter, Observation } from "@medplum/fhirtypes";
import {
  DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
  principalDiagnosisOrder,
  updateConditionBodySite,
  updateConditionCode,
  updateEncounterDiagnosisProblemStatus,
  type EyeChoice,
} from "../../lib/clinical-actions";
import {
  authHeaders,
  clinicalGraphApiBase,
  procedureChargeApi,
  readDiagnosisCandidates,
  submitDiagnosisPick,
  updateDiagnosisOrder,
  type AttachedProcedure,
  type DiagnosisCandidateFinding,
  type DiagnosisCandidateSuggestion,
} from "../../lib/clinical-graph-client";
import {
  diagnosisRank,
  displayCode,
  isActiveCondition,
  isEncounterDiagnosisCondition,
} from "../../lib/clinical-view-model";
import { fhir } from "../../lib/fhir";
import {
  encounterDiagnosisProblemStatus,
  FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
} from "../../lib/fhir-clinical/condition";
import { searchAll } from "../../lib/fhir-search";
import { OdosSearchPicker, type OdosSearchPickerOption } from "../inputs/OdosSearchPicker";
import { OdosChips } from "../inputs/OdosChips";
import {
  DiagnosisProblemStatusField,
  DiagnosisRankActions,
  findingProvenanceLine,
} from "./AssessmentSection";
import {
  ReorderImpressionsModal,
  buildReorderImpressionRows,
} from "./ReorderImpressionsModal";
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
import {
  conditionCatalogStableKey,
  conditionCodeForDiagnosisResolution,
  conditionRequiresDeclaredBilateralResolution,
  conditionResolvedCodeLabel,
} from "../../lib/diagnosis-code-resolution";

export interface DiagnosisQuickListRow {
  stableKey: string;
  display: string;
  lateralityRequired: boolean;
  bilateralResolution?: "emit-both-eyes";
  icd10?: { code: string; display?: string } | {
    pattern: { unspecifiedEye?: string; right?: string; left?: string; bilateral?: string };
  };
  pinned: boolean;
  tallyCount: number;
  clinicalFamily?: string;
  axisLabel?: string;
  members?: Array<{
    stableKey: string;
    stageLabel: string;
    display: string;
    lateralityRequired: boolean;
    bilateralResolution?: "emit-both-eyes";
    icd10?: { code: string; display?: string } | {
      pattern: { unspecifiedEye?: string; right?: string; left?: string; bilateral?: string };
    };
  }>;
  selectedMemberKey?: string;
  stageSelectionSource?: "search" | "prompt";
  stageDeferred?: boolean;
  findingInstanceId?: string;
  suggestionSource?: "rule" | "mapping";
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
  const [provenanceLines, setProvenanceLines] = useState<Record<string, string>>({});
  const [quickList, setQuickList] = useState<DiagnosisQuickListRow[]>([]);
  const [catalog, setCatalog] = useState<DiagnosisQuickListRow[]>([]);
  const [pinnedDiagnosisKeys, setPinnedDiagnosisKeys] = useState<string[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [loadedFindings, setLoadedFindings] = useState<{
    key: string;
    payload: DiagnosisFindingsPayload;
  }>();
  const [pendingDiagnosis, setPendingDiagnosis] = useState<DiagnosisQuickListRow>();
  const [candidateFindings, setCandidateFindings] = useState<DiagnosisCandidateFinding[]>([]);
  const [stageHistory, setStageHistory] = useState<{ key: string; conditions: Condition[] }>();
  const [searchSelection, setSearchSelection] = useState<OdosSearchPickerOption<DiagnosisQuickListRow>>();
  const [busy, setBusy] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [attachedProcedures, setAttachedProcedures] = useState<AttachedProcedure[]>([]);
  const [procedureAttachmentError, setProcedureAttachmentError] = useState<string>();
  const [reorderError, setReorderError] = useState<string>();
  const [reorderOpen, setReorderOpen] = useState(false);
  const loadGeneration = useRef(0);
  const findingsKey = `${encounterId}::${selectedReference ?? ""}`;
  const findings = loadedFindings?.key === findingsKey ? loadedFindings.payload : undefined;

  const load = useCallback(async () => {
    const requestGeneration = loadGeneration.current + 1;
    loadGeneration.current = requestGeneration;
    const requestFindingsKey = `${encounterId}::${selectedReference ?? ""}`;
    setLoadedFindings((current) => current?.key === requestFindingsKey ? undefined : current);
    setCandidateFindings([]);
    setLoading(true);
    setError(undefined);
    try {
      const [nextEncounter, searchedConditions, quickResponse, nextFindings, nextCandidateFindings, procedureResult] = await Promise.all([
        fhir.read<Encounter>("Encounter", encounterId),
        searchAll<Condition>(fhir, "Condition", { encounter: encounterReference }),
        fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-quick-list`, { headers: authHeaders() }),
        loadDiagnosisFindings(encounterReference, selectedReference),
        readDiagnosisCandidates(encounterId).catch(() => []),
        procedureChargeApi().read(encounterId).then(
          (response) => ({ response, error: undefined }),
          (caught) => ({
            response: undefined,
            error: caught instanceof Error ? caught.message : String(caught),
          }),
        ),
      ]);
      const quickBody = await quickResponse.json() as QuickListPayload;
      if (!quickResponse.ok) throw new Error(quickBody.error ?? `Common diagnoses failed: ${quickResponse.status}`);
      const nextConditions = orderedEncounterConditions(nextEncounter, searchedConditions);
      const evidenceReferences = [...new Set(nextConditions.flatMap((condition) =>
        (condition.evidence ?? []).flatMap((evidence) => (evidence.detail ?? []).flatMap((detail) =>
          detail.reference?.startsWith("Observation/") ? [detail.reference] : []
        ))
      ))];
      const observationResults = await Promise.allSettled(evidenceReferences.map(async (reference) =>
        fhir.read<Observation>("Observation", reference.replace(/^Observation\//, ""))
      ));
      const observationsByReference = new Map<string, Observation>(observationResults.flatMap((result) =>
        result.status === "fulfilled" ? [[`Observation/${result.value.id}`, result.value] as const] : []
      ));
      const nextProvenanceLines = Object.fromEntries(nextConditions.flatMap((condition) => {
        if (!condition.id) return [];
        const lines = (condition.evidence ?? []).flatMap((evidence) => evidence.detail ?? [])
          .flatMap((detail) => detail.reference ? [observationsByReference.get(detail.reference)] : [])
          .flatMap((observation) => observation ? [findingProvenanceLine(observation)] : []);
        return lines.length ? [[condition.id, lines.join(" · ")]] : [];
      }));
      if (loadGeneration.current !== requestGeneration) return;
      setEncounter(nextEncounter);
      setConditions(nextConditions);
      setProvenanceLines(nextProvenanceLines);
      setQuickList(quickBody.diagnoses ?? []);
      setCatalog(quickBody.catalog ?? []);
      setPinnedDiagnosisKeys(quickBody.pinnedDiagnosisKeys ?? []);
      setCanWrite(quickBody.canWrite === true);
      setAttachedProcedures(procedureResult.response?.attachedProcedures ?? []);
      setProcedureAttachmentError(procedureResult.error ? "Attached procedures could not be loaded." : undefined);
      setLoadedFindings({ key: requestFindingsKey, payload: nextFindings });
      setCandidateFindings(nextCandidateFindings);
    } catch (caught) {
      if (loadGeneration.current !== requestGeneration) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (loadGeneration.current === requestGeneration) setLoading(false);
    }
  }, [encounterId, encounterReference, selectedReference]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
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
  const selectedStableKey = selectedCondition ? conditionCatalogStableKey(selectedCondition) : undefined;
  const selectedStageFamily = selectedStableKey
    ? catalog.find((row) => row.members?.some((member) => member.stableKey === selectedStableKey) ||
      row.stableKey === selectedStableKey && row.members?.length)
    : undefined;
  const activeStageFamily = pendingDiagnosis?.members?.length ? pendingDiagnosis : selectedStageFamily;
  const stageHistoryKey = activeStageFamily ? `${patientReference}::${activeStageFamily.stableKey}` : undefined;
  const priorStage = activeStageFamily && stageHistory && stageHistory.key === stageHistoryKey
    ? mostRecentPriorStage(stageHistory.conditions, activeStageFamily, selectedCondition?.id)
    : undefined;

  useEffect(() => {
    if (!activeStageFamily || !stageHistoryKey) {
      setStageHistory(undefined);
      return;
    }
    let current = true;
    setStageHistory((loaded) => loaded?.key === stageHistoryKey ? loaded : undefined);
    void fhir.search<Condition>("Condition", { subject: patientReference, _count: "200" })
      .then((bundle) => {
        if (!current) return;
        setStageHistory({
          key: stageHistoryKey,
          conditions: (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []),
        });
      })
      .catch(() => {
        if (current) setStageHistory({ key: stageHistoryKey, conditions: [] });
      });
    return () => { current = false; };
  }, [activeStageFamily?.stableKey, patientReference, stageHistoryKey]);

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
    const selectedMember = row.members?.find((member) => member.stableKey === row.selectedMemberKey);
    const resolvedRow = selectedMember ? memberDiagnosisRow(selectedMember) : row;
    if ((row.members || row.lateralityRequired) && !laterality) {
      setPendingDiagnosis(row);
      return;
    }
    if (row.members && !selectedMember && !row.stageDeferred) {
      setPendingDiagnosis(row);
      return;
    }
    const existing = visitConditions.find((condition) => conditionMatchesDiagnosisPick(condition, resolvedRow, laterality));
    if (existing) {
      onSelectDiagnosis(`Condition/${existing.id}`);
      setPendingDiagnosis(undefined);
      return;
    }
    await run(`add:${row.stableKey}`, async () => {
      const result = await submitDiagnosisPick({
        encounterReference,
        diagnosisKey: resolvedRow.stableKey,
        action: "confirm",
        source: row.suggestionSource ?? "catalog-search",
        ...(row.findingInstanceId ? { findingInstanceId: row.findingInstanceId } : {}),
        ...(laterality ? { laterality } : {}),
        ...(row.stageDeferred ? { stageDeferred: true } : {}),
      });
      let condition = result.condition;
      if (laterality) {
        condition = await updateConditionBodySite({
          condition,
          patientReference,
          laterality,
          ...(!row.stageDeferred ? { diagnosis: resolvedRow } : {}),
        });
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
    return Promise.resolve(diagnosisSearchOptions(catalog, query));
  }

  const selectedEntry = encounter?.diagnosis?.find((entry) =>
    entry.condition.reference === selectedReference
  );
  const carryEditedForDisplay = Boolean(
    findings?.carryProvenance?.edited || findings?.carryProvenance?.integrityWarning,
  );
  const suggestionsByObservation = Object.fromEntries(candidateFindings.flatMap((finding) =>
    finding.observationReference ? [[finding.observationReference, finding]] : []
  ));

  function chooseSuggestion(suggestion: DiagnosisCandidateSuggestion, findingInstanceId: string) {
    const stableKey = suggestion.diagnosisKey ?? suggestion.familyGroup;
    const row = catalog.find((candidate) => candidate.stableKey === stableKey);
    if (!row) return;
    void addDiagnosis({
      ...row,
      findingInstanceId,
      suggestionSource: suggestion.source,
    });
  }

  async function saveDiagnosisOrder(conditionReferences: string[]) {
    setBusy("reorder");
    setReorderError(undefined);
    try {
      await updateDiagnosisOrder(encounterId, conditionReferences);
      setReorderOpen(false);
      await load();
    } catch (caught) {
      setReorderError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

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
            const possible = isProvisionalCondition(condition);
            return (
              <button
                type="button"
                key={reference}
                aria-pressed={selectedReference === reference}
                className={`odos-diagnosis-visit-row${possible ? " is-possible" : ""}`}
                onClick={() => onSelectDiagnosis(reference)}
              >
                <span>{displayCode(condition.code)}</span>
                <small>
                  {possible ? "Possible" : rank === undefined ? "Confirmed · Rank missing" : `Confirmed · Rank ${rank}`} · {condition.bodySite?.[0]?.text ?? "Scope not set"} · <ResolvedDiagnosisCode condition={condition} catalog={catalog} />
                </small>
                {condition.id && provenanceLines[condition.id] && (
                  <small className="odos-diagnosis-provenance">← from {provenanceLines[condition.id]}</small>
                )}
              </button>
            );
          })}
        </div>
        {encounter && canReorderEncounterDiagnoses(encounter, visitConditions) && (
          <button
            type="button"
            className="odos-diagnosis-primary-action"
            disabled={!canWrite || busy !== undefined}
            onClick={() => {
              setReorderError(undefined);
              setReorderOpen(true);
            }}
          >
            Reorder Impressions
          </button>
        )}
        {selectedCondition && encounter && (
          <DiagnosisRankActions
            possible={selectedCondition.verificationStatus?.coding?.some((coding) => coding.code === "provisional") === true}
            principal={diagnosisRank(encounter, selectedCondition) === 1}
            busy={diagnosisRankActionsDisabled(canWrite, busy)}
            onMakePrincipal={() => void run("rank", async () => {
              await updateDiagnosisOrder(encounterId, principalDiagnosisOrder(encounter, selectedCondition));
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
                  {row.axisLabel
                    ? <small className="odos-diagnosis-axis-chip">{row.axisLabel}</small>
                    : <small>{diagnosisQuickListCode(row, visitConditions) ?? "No ICD-10-CM code"}</small>}
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
          <div className="odos-diagnosis-scope-prompt" role="group" aria-label={`Resolve ${pendingDiagnosis.display}`}>
            <strong>{pendingDiagnosis.display}</strong>
            {pendingDiagnosis.members && pendingDiagnosis.stageSelectionSource !== "search" && (
              <div className="odos-diagnosis-resolution-row">
                <span>{pendingDiagnosis.axisLabel}</span>
                <OdosChips
                  options={pendingDiagnosis.members.map((member) => ({ value: member.stableKey, label: member.stageLabel }))}
                  selected={pendingDiagnosis.selectedMemberKey ? [pendingDiagnosis.selectedMemberKey] : []}
                  onChange={(selected) => setPendingDiagnosis({
                    ...pendingDiagnosis,
                    selectedMemberKey: selected[0],
                    stageSelectionSource: "prompt",
                    stageDeferred: false,
                  })}
                  ariaLabel={`${pendingDiagnosis.axisLabel} for ${pendingDiagnosis.display}`}
                  disabled={busy !== undefined}
                  exclusive
                />
                {priorStage && (
                  <small className="odos-diagnosis-stage-prior">
                    was {priorStage.stageLabel} · {priorStage.recordedAt.slice(0, 10)}
                  </small>
                )}
              </div>
            )}
            <div className="odos-diagnosis-resolution-row">
              <span>Scope</span>
              <OdosChips
                options={(["OD", "OS", "OU"] as const).map((eye) => ({ value: eye, label: eye }))}
                selected={[]}
                onChange={(selected) => selected[0] && void addDiagnosis(pendingDiagnosis, selected[0])}
                ariaLabel={`Scope for ${pendingDiagnosis.display}`}
                disabled={busy !== undefined || Boolean(pendingDiagnosis.members && !pendingDiagnosis.selectedMemberKey && !pendingDiagnosis.stageDeferred)}
                exclusive
              />
              {pendingDiagnosis.members && pendingDiagnosis.stageSelectionSource !== "search" && (
                <button
                  type="button"
                  aria-pressed={pendingDiagnosis.stageDeferred === true}
                  disabled={busy !== undefined}
                  onClick={() => setPendingDiagnosis({
                    ...pendingDiagnosis,
                    selectedMemberKey: undefined,
                    stageSelectionSource: "prompt",
                    stageDeferred: true,
                  })}
                >{pendingDiagnosis.axisLabel} later</button>
              )}
              <button type="button" onClick={() => setPendingDiagnosis(undefined)}>Cancel</button>
            </div>
          </div>
        )}
        {findings && (
          <UnassignedFindingsTray
            rows={findings.unassigned}
            visitDiagnoses={findings.visitDiagnoses}
            patientReference={patientReference}
            disabled={!findings.canWrite || busy !== undefined}
            suggestionsByObservation={suggestionsByObservation}
            onSuggest={chooseSuggestion}
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
                <p><ResolvedDiagnosisCode condition={selectedCondition} catalog={catalog} /></p>
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
              <div className="odos-diagnosis-header-controls">
                {selectedStageFamily?.members && (
                  <div className="odos-diagnosis-stage-control">
                    <span>{selectedStageFamily.axisLabel}</span>
                    <OdosChips
                      options={selectedStageFamily.members.map((member) => ({ value: member.stableKey, label: member.stageLabel }))}
                      selected={selectedStageFamily.members.some((member) => member.stableKey === selectedStableKey) ? [selectedStableKey!] : []}
                      onChange={(selected) => selected[0] && void run("stage", async () => {
                        const member = selectedStageFamily.members!.find((candidate) => candidate.stableKey === selected[0]);
                        const laterality = selectedCondition.bodySite?.[0]?.text;
                        if (!member || (laterality !== "OD" && laterality !== "OS" && laterality !== "OU")) {
                          throw new Error("Diagnosis stage could not be resolved for the current scope.");
                        }
                        const code = conditionCodeForDiagnosisResolution(memberDiagnosisRow(member), laterality);
                        const coding = code?.coding?.[0];
                        if (!coding?.system || !coding.code) throw new Error("The selected stage has no resolved diagnosis code.");
                        await updateConditionCode({
                          condition: selectedCondition,
                          diagnosisKey: member.stableKey,
                          code: { system: coding.system, code: coding.code, display: member.display },
                        });
                      })}
                      ariaLabel={`${selectedStageFamily.axisLabel} for ${selectedStageFamily.display}`}
                      disabled={!canWrite || busy !== undefined}
                      exclusive
                    />
                    {priorStage && (
                      <small className="odos-diagnosis-stage-prior">
                        was {priorStage.stageLabel} · {priorStage.recordedAt.slice(0, 10)}
                      </small>
                    )}
                  </div>
                )}
                <div className="odos-diagnosis-laterality" role="group" aria-label="Diagnosis scope">
                  {(["OD", "OS", "OU"] as const).map((eye) => (
                    <button
                      key={eye}
                      type="button"
                      aria-pressed={selectedCondition.bodySite?.[0]?.text === eye}
                      disabled={!canWrite || busy !== undefined}
                      onClick={() => void run("laterality", async () => {
                        const diagnosis = catalog.find((row) => row.stableKey === conditionCatalogStableKey(selectedCondition));
                        if (conditionRequiresDeclaredBilateralResolution(selectedCondition) && !diagnosis) {
                          throw new Error("The eyelid diagnosis catalog row is unavailable; laterality was not changed.");
                        }
                        await updateConditionBodySite({ condition: selectedCondition, patientReference, laterality: eye, ...(diagnosis ? { diagnosis } : {}) });
                      })}
                    >{eye}</button>
                  ))}
                </div>
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
      {reorderOpen && encounter && (
        <ReorderImpressionsModal
          rows={buildReorderImpressionRows(encounter, conditions, attachedProcedures)}
          busy={busy === "reorder"}
          attachmentError={reorderError ?? procedureAttachmentError}
          onCancel={() => setReorderOpen(false)}
          onSave={saveDiagnosisOrder}
        />
      )}
    </div>
  );
}

function RailHeading({ children }: { children: string }) {
  return <h2 className="odos-diagnosis-rail-heading">{children}</h2>;
}

function ResolvedDiagnosisCode({
  condition,
  catalog,
}: {
  condition: Condition;
  catalog: readonly DiagnosisQuickListRow[];
}) {
  const label = conditionResolvedCodeLabel(condition, catalog);
  return label === "Code pending — stage required"
    ? <span className="odos-diagnosis-code-warning" role="status">{label}</span>
    : <span>{label}</span>;
}

export function orderedEncounterConditions(encounter: Encounter, conditions: readonly Condition[]): Condition[] {
  return conditions
    .filter(isEncounterDiagnosisCondition)
    .filter((condition) => !["refuted", "entered-in-error"].includes(conditionVerificationStatus(condition)))
    .map((condition) => ({ condition, rank: diagnosisRank(encounter, condition) }))
    .sort((left, right) => {
      const leftGroup = left.rank !== undefined ? 0 : isProvisionalCondition(left.condition) ? 2 : 1;
      const rightGroup = right.rank !== undefined ? 0 : isProvisionalCondition(right.condition) ? 2 : 1;
      if (leftGroup !== rightGroup) return leftGroup - rightGroup;
      if (left.rank !== undefined && right.rank !== undefined && left.rank !== right.rank) return left.rank - right.rank;
      return (left.condition.recordedDate ?? "").localeCompare(right.condition.recordedDate ?? "") ||
        (left.condition.id ?? "").localeCompare(right.condition.id ?? "");
    })
    .map(({ condition }) => condition);
}

function canReorderEncounterDiagnoses(encounter: Encounter, conditions: readonly Condition[]): boolean {
  const entries = encounter.diagnosis ?? [];
  if (entries.length <= 1) return false;
  const rankedConfirmedReferences = new Set(conditions.flatMap((condition) =>
    condition.id &&
    conditionVerificationStatus(condition) === "confirmed" &&
    diagnosisRank(encounter, condition) !== undefined
      ? [`Condition/${condition.id}`]
      : []
  ));
  return rankedConfirmedReferences.size === entries.length && entries.every((entry) =>
    Boolean(entry.condition.reference && rankedConfirmedReferences.has(entry.condition.reference))
  );
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

export function diagnosisSearchOptions(
  catalog: readonly DiagnosisQuickListRow[],
  query: string,
): OdosSearchPickerOption<DiagnosisQuickListRow>[] {
  const tokens = normalizedSearchText(query).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  return catalog.flatMap((row) => {
    const memberMatches = row.members?.filter((member) => tokens.every((token) =>
      normalizedSearchText(`${row.display} ${member.display} ${member.stableKey} ${member.stageLabel}`).includes(token)
    )) ?? [];
    const rowMatches = tokens.every((token) => normalizedSearchText(
      `${row.display} ${row.stableKey} ${diagnosisQuickListCode(row) ?? ""} ${row.members?.map((member) => `${member.display} ${member.stableKey} ${member.stageLabel}`).join(" ") ?? ""}`,
    ).includes(token));
    if (!rowMatches) return [];
    const selectedMember = memberMatches.length === 1 ? memberMatches[0] : undefined;
    const item = selectedMember
      ? { ...row, selectedMemberKey: selectedMember.stableKey, stageSelectionSource: "search" as const }
      : row;
    return [{
      value: row.stableKey,
      label: row.display,
      description: selectedMember && row.axisLabel
        ? `${row.axisLabel}: ${selectedMember.stageLabel}`
        : row.axisLabel ?? diagnosisQuickListCode(row),
      item,
    }];
  }).slice(0, 20);
}

export function mostRecentPriorStage(
  conditions: readonly Condition[],
  family: DiagnosisQuickListRow,
  excludedConditionId?: string,
): { stableKey: string; stageLabel: string; recordedAt: string } | undefined {
  const members = new Map(family.members?.map((member) => [member.stableKey, member.stageLabel]) ?? []);
  const latest = conditions.flatMap((condition) => {
    if (condition.id === excludedConditionId) return [];
    if (condition.verificationStatus?.coding?.some((coding) => ["refuted", "entered-in-error"].includes(coding.code ?? ""))) return [];
    if (condition.clinicalStatus?.coding?.some((coding) => coding.code === "entered-in-error")) return [];
    const stableKey = conditionCatalogStableKey(condition);
    const stageLabel = stableKey ? members.get(stableKey) : undefined;
    const recordedAt = condition.recordedDate ?? condition.meta?.lastUpdated;
    const timestamp = recordedAt ? Date.parse(recordedAt) : Number.NaN;
    return stableKey && stageLabel && recordedAt && Number.isFinite(timestamp)
      ? [{ stableKey, stageLabel, recordedAt, timestamp }]
      : [];
  }).sort((left, right) => right.timestamp - left.timestamp)[0];
  return latest ? {
    stableKey: latest.stableKey,
    stageLabel: latest.stageLabel,
    recordedAt: latest.recordedAt,
  } : undefined;
}

function memberDiagnosisRow(
  member: NonNullable<DiagnosisQuickListRow["members"]>[number],
): DiagnosisQuickListRow {
  return {
    stableKey: member.stableKey,
    display: member.display,
    lateralityRequired: member.lateralityRequired,
    ...(member.bilateralResolution ? { bilateralResolution: member.bilateralResolution } : {}),
    ...(member.icd10 ? { icd10: member.icd10 } : {}),
    pinned: false,
    tallyCount: 0,
  };
}

function normalizedSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N}.]+/gu, " ").trim();
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

export function diagnosisQuickListCode(
  row: DiagnosisQuickListRow,
  conditions: readonly Condition[] = [],
): string | undefined {
  if (!row.lateralityRequired) return catalogFallbackCode(row);
  const stableKeys = new Set([row.stableKey, ...(row.members?.map((member) => member.stableKey) ?? [])]);
  const proposals = conditions.filter((condition) =>
    isProvisionalCondition(condition) &&
    isActiveCondition(condition) &&
    Boolean(conditionCatalogStableKey(condition) && stableKeys.has(conditionCatalogStableKey(condition)!))
  );
  if (proposals.length > 0) {
    const resolved = proposals.map((condition) => ({
      eye: conditionEye(condition),
      codes: condition.code?.coding
        ?.filter((coding) => coding.system === "http://hl7.org/fhir/sid/icd-10-cm" && coding.code)
        .map((coding) => coding.code!) ?? [],
    }));
    if (resolved.some((proposal) => !proposal.eye || proposal.codes.length === 0)) return undefined;
    const byEye = new Map<string, string[]>();
    for (const proposal of resolved) {
      byEye.set(proposal.eye!, [...new Set([...(byEye.get(proposal.eye!) ?? []), ...proposal.codes])].sort());
    }
    const ordered = (["OD", "OS", "OU"] as const).flatMap((eye) => {
      const codes = byEye.get(eye);
      return codes ? [{ eye, label: codes.join(" / ") }] : [];
    });
    if (ordered.length === 1) return ordered[0]!.label;
    return ordered.map(({ eye, label }) => `${eye} ${label}`).join(" · ");
  }
  return catalogFallbackCode(row);
}

function catalogFallbackCode(row: DiagnosisQuickListRow): string | undefined {
  if (!row.icd10) return undefined;
  return "code" in row.icd10 ? row.icd10.code : row.icd10.pattern.unspecifiedEye;
}

function conditionVerificationStatus(condition: Condition): string {
  return condition.verificationStatus?.coding?.find((coding) =>
    coding.system === FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM
  )?.code ?? condition.verificationStatus?.coding?.find((coding) => coding.code)?.code ?? condition.verificationStatus?.text ?? "unknown";
}

function isProvisionalCondition(condition: Condition): boolean {
  return conditionVerificationStatus(condition) === "provisional";
}

function conditionEye(condition: Condition): "OD" | "OS" | "OU" | undefined {
  const bodySite = condition.bodySite?.map((site) => site.text).find((text) => text === "OD" || text === "OS" || text === "OU");
  if (bodySite === "OD" || bodySite === "OS" || bodySite === "OU") return bodySite;
  const bucket = condition.identifier?.find((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM)?.value?.split("::").at(-1);
  return bucket === "right" ? "OD" : bucket === "left" ? "OS" : bucket === "bilateral" ? "OU" : undefined;
}
