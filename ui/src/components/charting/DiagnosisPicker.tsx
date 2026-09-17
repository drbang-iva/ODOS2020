import { supportedDiagnosisPick, supportedFindingLink } from "../../lib/supported-diagnosis-pick";
import { loadDiagnosisFindings, handleFindingOutcome, mutateDiagnosisFinding, type DiagnosisFindingsPayload, type DiagnosisFindingMutation } from "../../lib/diagnosis-findings";
import type { SupportingFindingFact } from "../../lib/clinical-graph-client";
import type { Condition } from "@medplum/fhirtypes";
import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../../lib/clinical-actions";
import {
  authHeaders,
  clinicalGraphApiBase,
  readDiagnosisCandidates,
  submitDiagnosisPick,
  type DiagnosisCandidateSuggestion,
  type DiagnosisDemotionImpact,
} from "../../lib/clinical-graph-client";
import { fhir } from "../../lib/fhir";
import { searchAll } from "../../lib/fhir-search";
import { OdosSearchPicker } from "../inputs/OdosSearchPicker";
import { DiagnosisDemotionImpactNotice } from "./DiagnosisDemotionImpactNotice";

interface Candidate {
  diagnosisKey: string;
  display: string;
  icd10?: { code?: string; pattern?: Record<string, string> };
  codingStatus: "verified" | "placeholder" | "provisional";
  priority: boolean;
  source: "rule" | "mapping" | "catalog-search";
  supportingFacts?: SupportingFindingFact[];
}

interface CandidateFinding {
  findingInstanceId: string;
  findingDefinitionKey?: string;
  observationReference?: string;
  candidates: Candidate[];
  suppressedCandidates?: Candidate[];
  suppression?: { message: string; overridable: boolean };
}

interface CatalogRow {
  stableKey: string;
  display: string;
  active: boolean;
  codingStatus: Candidate["codingStatus"];
  icd10?: { code?: string; pattern?: Record<string, string> };
}

interface DiagnosisPickerProps {
  encounterReference: string; patientReference?: string; observationReferences?: string[]; findingDefinitionKey?: string;
  refreshKey?: number | string; mode?: "decision" | "proposal"; linkMode?: "facts";
}
export function DiagnosisPicker(props: DiagnosisPickerProps) {
  return props.linkMode === "facts" ? <FactsDiagnosisPicker {...props} /> : <LegacyDiagnosisPicker {...props} />;
}
function LegacyDiagnosisPicker({
  encounterReference,
  observationReferences,
  findingDefinitionKey,
  refreshKey,
  mode = "decision",
}: {
  encounterReference: string;
  observationReferences?: string[];
  findingDefinitionKey?: string;
  refreshKey?: number | string;
  mode?: "decision" | "proposal";
}) {
  const [findings, setFindings] = useState<CandidateFinding[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [catalogSelection, setCatalogSelection] = useState<CatalogRow>();
  const [proposalCatalogSelections, setProposalCatalogSelections] = useState<Record<string, CatalogRow>>({});
  const [proposedConditions, setProposedConditions] = useState<Condition[]>([]);
  const [overridden, setOverridden] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnosisDemotionImpact, setDiagnosisDemotionImpact] = useState<DiagnosisDemotionImpact>();
  const loadVersion = useRef(0);
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const observationKey = observationReferences?.join("|") ?? "";
  const loadScopeKey = [encounterReference, findingDefinitionKey, mode, observationKey, refreshKey].join("\u0000");
  const [diagnosisCapability, setDiagnosisCapability] = useState<{ scopeKey: string; allowed: boolean }>();
  const canWriteDiagnosis = diagnosisCapability?.scopeKey === loadScopeKey && diagnosisCapability.allowed;
  const currentLoadScopeKey = useRef(loadScopeKey);
  currentLoadScopeKey.current = loadScopeKey;

  async function load(signal?: AbortSignal) {
    setDiagnosisDemotionImpact(undefined);
    setDiagnosisCapability(undefined);
    const requestVersion = ++loadVersion.current;
    try {
      const [candidateFindings, catalogResponse, conditions] = await Promise.all([
        readDiagnosisCandidates(encounterId),
        fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-catalog`, { headers: authHeaders(), signal }),
        mode === "proposal"
          ? searchAll<Condition>(fhir, "Condition", { encounter: encounterReference })
          : Promise.resolve([]),
      ]);
      const catalogBody = await catalogResponse.json() as { diagnoses?: CatalogRow[]; canWriteDiagnosis?: boolean; error?: string };
      if (!catalogResponse.ok) throw new Error(catalogBody.error ?? `Diagnosis catalog request failed: ${catalogResponse.status}`);
      if (signal?.aborted || requestVersion !== loadVersion.current) return;
      const allowedObservations = new Set(observationReferences ?? []);
      setFindings(candidateFindings.map((finding) => ({
        ...finding,
        candidates: finding.candidates.filter(isLeafCandidate),
        suppressedCandidates: finding.suppressedCandidates?.filter(isLeafCandidate),
      })).filter((finding) =>
        (mode === "proposal" || finding.candidates.length > 0 || Boolean(finding.suppression && finding.suppressedCandidates?.length)) &&
        (!findingDefinitionKey || finding.findingDefinitionKey === findingDefinitionKey) &&
        (allowedObservations.size === 0 || Boolean(finding.observationReference && allowedObservations.has(finding.observationReference)))
      ));
      setCatalog((catalogBody.diagnoses ?? []).filter((row) => row.active));
      setDiagnosisCapability({ scopeKey: loadScopeKey, allowed: catalogBody.canWriteDiagnosis === true });
      setProposedConditions(conditions.filter(isProvisional));
      setError(null);
    } catch (err) {
      if (!signal?.aborted && requestVersion === loadVersion.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    if (!encounterId || observationReferences && observationReferences.length === 0) {
      loadVersion.current += 1;
      setFindings([]);
      setError(null);
      return () => controller.abort();
    }
    void load(controller.signal);
    return () => {
      controller.abort();
      loadVersion.current += 1;
    };
  }, [encounterId, encounterReference, findingDefinitionKey, mode, observationKey, refreshKey]);

  const searchCatalog = useMemo(() => async (query: string) => {
    const term = query.trim().toLocaleLowerCase();
    return catalog
      .filter((row) => `${row.display} ${row.stableKey} ${catalogCode(row)}`.toLocaleLowerCase().includes(term))
      .slice(0, 12)
      .map((row) => ({
        value: row.stableKey,
        label: row.display,
        description: catalogCode(row) ?? "No code yet",
        item: row,
      }));
  }, [catalog]);

  async function pick(finding: CandidateFinding, diagnosisKey: string, action: "possible" | "confirm" | "discard", source: Candidate["source"] | "catalog-search") {
    if (!canWriteDiagnosis) return;
    const actionLoadScopeKey = loadScopeKey;
    setBusy(`${finding.findingInstanceId}:${diagnosisKey}:${action}`);
    setError(null);
    try {
      const result = await submitDiagnosisPick({
        encounterReference,
        findingInstanceId: finding.findingInstanceId,
        diagnosisKey,
        action,
        source,
      });
      if (currentLoadScopeKey.current !== actionLoadScopeKey) return;
      try {
        await load();
      } finally {
        if (currentLoadScopeKey.current === actionLoadScopeKey) setDiagnosisDemotionImpact(result);
      }
      setOpenId(null);
      setCatalogSelection(undefined);
      setProposalCatalogSelections((current) => {
        const next = { ...current };
        delete next[finding.findingInstanceId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (findings.length === 0) {
    if (!error && !diagnosisDemotionImpact) return null;
    return (
      <div className="mt-3 space-y-2">
        <DiagnosisDemotionImpactNotice impact={diagnosisDemotionImpact} />
        {error && <div className="text-xs text-[color:var(--odos-alert)]">{error}</div>}
      </div>
    );
  }

  if (mode === "proposal") {
    return (
      <div data-testid="structure-diagnosis-rail" className="mt-4 space-y-3 border-t border-[color:var(--odos-line)] pt-4">
        <DiagnosisDemotionImpactNotice impact={diagnosisDemotionImpact} />
        {findings.map((finding) => (
          <div key={finding.findingInstanceId} className="space-y-3 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-3">
            {finding.candidates.length > 0 && (
              <div data-testid="suggested-diagnoses" className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--odos-muted)]">Suggested diagnoses</div>
                <div className="flex flex-wrap gap-2">
                  {finding.candidates.map((candidate) => {
                    const proposed = isProposedDiagnosis(proposedConditions, candidate.diagnosisKey, finding.observationReference);
                    return <ProposalChoice
                      key={candidate.diagnosisKey}
                      display={candidate.display}
                      code={catalogCode(candidate)}
                      proposed={proposed}
                      busy={!canWriteDiagnosis || busy !== null}
                      onToggle={() => pick(finding, candidate.diagnosisKey, proposed ? "discard" : "possible", candidate.source)}
                    />;
                  })}
                </div>
              </div>
            )}
            <div>
              <OdosSearchPicker
                label="Full diagnosis catalog"
                value={proposalCatalogSelections[finding.findingInstanceId]?.stableKey ?? ""}
                selectedLabel={proposalCatalogSelections[finding.findingInstanceId]?.display}
                placeholder="Search full diagnosis catalog"
                search={searchCatalog}
                disabled={!canWriteDiagnosis || busy !== null}
                onClear={() => setProposalCatalogSelections((current) => {
                  const next = { ...current };
                  delete next[finding.findingInstanceId];
                  return next;
                })}
                onSelect={(option) => setProposalCatalogSelections((current) => ({
                  ...current,
                  [finding.findingInstanceId]: option.item,
                }))}
              />
              {proposalCatalogSelections[finding.findingInstanceId] && (() => {
                const selected = proposalCatalogSelections[finding.findingInstanceId]!;
                const proposed = isProposedDiagnosis(proposedConditions, selected.stableKey, finding.observationReference);
                return <div className="mt-2">
                  <ProposalChoice
                    display={selected.display}
                    code={catalogCode(selected)}
                    proposed={proposed}
                    busy={!canWriteDiagnosis || busy !== null}
                    onToggle={() => pick(finding, selected.stableKey, proposed ? "discard" : "possible", "catalog-search")}
                  />
                </div>;
              })()}
            </div>
          </div>
        ))}
        {error && <div className="text-xs text-[color:var(--odos-alert)]">{error}</div>}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <DiagnosisDemotionImpactNotice impact={diagnosisDemotionImpact} />
      {findings.map((finding) => (
        <div key={finding.findingInstanceId} className="relative inline-block align-top">
          {finding.suppression && !overridden.has(finding.findingInstanceId) ? (
            <div className="rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface-2)] px-3 py-2 text-xs text-[color:var(--odos-text)]">
              <span>{finding.suppression.message}</span>
              {finding.suppression.overridable && (
                <button
                  type="button"
                  onClick={() => setOverridden((current) => new Set(current).add(finding.findingInstanceId))}
                  className="ml-2 font-semibold text-brand-light underline underline-offset-2"
                >
                  Override
                </button>
              )}
            </div>
          ) : finding.suppression ? (
            <div className="space-y-2 rounded border border-brand/40 bg-brand/10 p-3">
              <div className="text-xs text-[color:var(--odos-muted)]">Override active — clinician review required.</div>
              {(finding.suppressedCandidates ?? []).map((candidate) => (
                <DiagnosisChoice
                  key={candidate.diagnosisKey}
                  display={candidate.display}
                  code={catalogCode(candidate)}
                  codingStatus={candidate.codingStatus}
                  busy={!canWriteDiagnosis || busy !== null}
                  onPossible={() => pick(finding, candidate.diagnosisKey, "possible", candidate.source)}
                  onConfirm={() => pick(finding, candidate.diagnosisKey, "confirm", candidate.source)}
                />
              ))}
            </div>
          ) : (
          <>
          <button
            type="button"
            onClick={() => {
              setCatalogSelection(undefined);
              setOpenId((current) => current === finding.findingInstanceId ? null : finding.findingInstanceId);
            }}
            className="rounded-full border border-brand/50 bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/20"
            aria-expanded={openId === finding.findingInstanceId}
          >
            dx ▾ {finding.candidates.length}
          </button>
          {openId === finding.findingInstanceId && (
            <div className="absolute left-0 z-30 mt-2 w-[min(520px,calc(100vw-3rem))] rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-popover)] p-3 shadow-2xl">
              <div className="space-y-2">
                {finding.candidates.map((candidate) => (
                  <DiagnosisChoice
                    key={candidate.diagnosisKey}
                    display={candidate.display}
                    code={catalogCode(candidate)}
                    codingStatus={candidate.codingStatus}
                    busy={!canWriteDiagnosis || busy !== null}
                    onPossible={() => pick(finding, candidate.diagnosisKey, "possible", candidate.source)}
                    onConfirm={() => pick(finding, candidate.diagnosisKey, "confirm", candidate.source)}
                  />
                ))}
              </div>
              <div className="mt-3 border-t border-[color:var(--odos-line)] pt-3">
                <OdosSearchPicker
                  label="Full diagnosis catalog"
                  value={catalogSelection?.stableKey ?? ""}
                  selectedLabel={catalogSelection?.display}
                  placeholder="Search full diagnosis catalog"
                  search={searchCatalog}
                  disabled={!canWriteDiagnosis || busy !== null}
                  onClear={() => setCatalogSelection(undefined)}
                  onSelect={(option) => setCatalogSelection(option.item)}
                />
                {catalogSelection && (
                  <div className="mt-2">
                    <DiagnosisChoice
                      display={catalogSelection.display}
                      code={catalogCode(catalogSelection)}
                      codingStatus={catalogSelection.codingStatus}
                      busy={!canWriteDiagnosis || busy !== null}
                      onPossible={() => pick(finding, catalogSelection.stableKey, "possible", "catalog-search")}
                      onConfirm={() => pick(finding, catalogSelection.stableKey, "confirm", "catalog-search")}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
          </>
          )}
        </div>
      ))}
      {error && <div className="text-xs text-[color:var(--odos-alert)]">{error}</div>}
    </div>
  );
}

function ProposalChoice({
  display,
  code,
  proposed,
  busy,
  onToggle,
}: {
  display: string;
  code?: string;
  proposed: boolean;
  busy: boolean;
  onToggle: () => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      aria-label={proposed ? `Retract proposed ${display}` : `Propose ${display}`}
      aria-pressed={proposed}
      disabled={busy}
      onClick={onToggle}
      className={proposed
        ? "rounded-full border border-[color:var(--odos-amber)] bg-[color:var(--odos-accent-tint-hi)] px-3 py-2 text-left text-xs font-semibold text-[color:var(--odos-text)] disabled:opacity-45"
        : "rounded-full border border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-lo)] px-3 py-2 text-left text-xs font-semibold text-[color:var(--odos-text)] disabled:opacity-45"}
    >
      <span>{display}</span>
      {code && <small className="ml-2 text-[color:var(--odos-muted)]">{code}</small>}
    </button>
  );
}

function DiagnosisChoice({
  display,
  code,
  codingStatus,
  busy,
  onPossible,
  onConfirm,
}: {
  display: string;
  code?: string;
  codingStatus: Candidate["codingStatus"];
  busy: boolean;
  onPossible: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-[color:var(--odos-text)]">{display}</div>
          <div className="mt-0.5 text-xs text-[color:var(--odos-muted)]">{code ?? "no code yet"}</div>
        </div>
        {codingStatus === "provisional" && <span className="rounded border border-[color:var(--odos-amber)] px-1.5 py-0.5 text-[10px] uppercase text-[color:var(--odos-text)]">provisional</span>}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" disabled={busy} onClick={onPossible} className="rounded border border-[color:var(--odos-amber)] bg-[color:var(--odos-surface)] px-2 py-1.5 text-xs font-semibold text-[color:var(--odos-text)] disabled:opacity-45">Possible</button>
        <button type="button" disabled={busy} onClick={onConfirm} className="rounded border border-[color:var(--odos-emerald)] bg-[color:var(--odos-surface)] px-2 py-1.5 text-xs font-semibold text-[color:var(--odos-text)] disabled:opacity-45">Confirm</button>
      </div>
    </div>
  );
}

export function catalogCode(row: Pick<CatalogRow, "icd10">): string | undefined {
  if (!row.icd10) return undefined;
  if (row.icd10.code) return row.icd10.code;
  return row.icd10.pattern?.unspecifiedEye;
}

function isLeafCandidate(candidate: DiagnosisCandidateSuggestion): candidate is Candidate & { source: "rule" | "mapping" } {
  return typeof candidate.diagnosisKey === "string" &&
    "codingStatus" in candidate &&
    (candidate.codingStatus === "verified" || candidate.codingStatus === "placeholder" || candidate.codingStatus === "provisional");
}

function isProvisional(condition: Condition): boolean {
  return condition.verificationStatus?.coding?.some((coding) => coding.code === "provisional") === true;
}

function isProposedDiagnosis(
  conditions: readonly Condition[],
  diagnosisKey: string,
  observationReference: string | undefined,
): boolean {
  return conditions.some((condition) =>
    conditionDiagnosisKey(condition) === diagnosisKey &&
    (!observationReference || condition.evidence?.some((evidence) =>
      evidence.detail?.some((detail) => detail.reference === observationReference)
    ) === true)
  );
}

function conditionDiagnosisKey(condition: Condition): string | undefined {
  const value = condition.identifier?.find((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
  )?.value;
  return value?.split("::").at(-2);
}

function FactsDiagnosisPicker({ encounterReference, patientReference, findingDefinitionKey, refreshKey }: DiagnosisPickerProps) {
  const [projection, setProjection] = useState<DiagnosisFindingsPayload>();
  const [candidates, setCandidates] = useState<Array<Candidate & { supportingFacts: SupportingFindingFact[] }>>([]);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pendingLink, setPendingLink] = useState<DiagnosisFindingMutation>();
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [selection, setSelection] = useState<CatalogRow>();
  const version = useRef(0);
  const scopeKey = `${encounterReference}\u0000${patientReference}\u0000${findingDefinitionKey}`;
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;
  async function load() {
    const requested = ++version.current;
    try {
      const [payload, findings, currentConditions, response] = await Promise.all([
        loadDiagnosisFindings(encounterReference),
        readDiagnosisCandidates(encounterReference.replace(/^Encounter\//, "")),
        searchAll<Condition>(fhir, "Condition", { encounter: encounterReference }),
        fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-catalog`, { headers: authHeaders() }),
      ]);
      const catalogBody = await response.json() as { diagnoses?: CatalogRow[]; error?: string };
      if (requested !== version.current || activeScope.current !== scopeKey) return;
      if ("result" in payload) throw new Error(payload.error);
      if (!response.ok) throw new Error(catalogBody.error ?? "Diagnosis catalog unavailable");
      setProjection(payload); setConditions(currentConditions); setCatalog((catalogBody.diagnoses ?? []).filter(row => row.active));
      setCandidates(findings.flatMap(finding => finding.candidates.filter(isLeafCandidate).flatMap(candidate => {
        const supports = candidate.supportingFacts?.filter(support => support.key.stableKey === findingDefinitionKey && payload.searchIndex.some(row => row.rowKey === support.rowKey && row.status === "live" && row.presence === "present"));
        return supports?.length ? [{ ...candidate, supportingFacts: supports }] : [];
      })));
    } catch (caught) { if (requested === version.current && activeScope.current === scopeKey) { setProjection(undefined); setMessage(caught instanceof Error ? caught.message : String(caught)); } }
  }
  useEffect(() => {
    void load();
    const refresh = (event: Event) => { if ((event as CustomEvent).detail?.encounterReference === encounterReference) void load(); };
    window.addEventListener("odos:encounter-findings-changed", refresh);
    return () => { version.current++; window.removeEventListener("odos:encounter-findings-changed", refresh); };
  }, [encounterReference, findingDefinitionKey, refreshKey]);
  function supportsFor(diagnosisKey: string) {
    return [...new Map(candidates.filter(candidate => candidate.diagnosisKey === diagnosisKey).flatMap(candidate => candidate.supportingFacts).map(support => [support.rowKey, support])).values()];
  }
  function proposed(candidate: Candidate & { supportingFacts: SupportingFindingFact[] }) {
    return conditions.some(condition => isProvisional(condition) && conditionDiagnosisKey(condition) === candidate.diagnosisKey && candidate.supportingFacts.every(support => projection?.searchIndex.find(row => row.rowKey === support.rowKey)?.homes.includes(`Condition/${condition.id}`)));
  }
  async function finishLink(command: DiagnosisFindingMutation) {
    const result = await mutateDiagnosisFinding(encounterReference, command);
    const outcome = await handleFindingOutcome(result, { encounterReference, refresh: load });
    const complete = result.body.result === "command" && result.body.complete;
    setPendingLink(complete || outcome.reloadChoice ? undefined : command);
    setMessage(complete ? "Diagnosis saved · Scope saved · Findings linked" : `Diagnosis saved · Linking incomplete: ${outcome.message ?? "Retry linking"}`);
  }
  async function pick(candidate: Candidate & { supportingFacts: SupportingFindingFact[] }) {
    if (!projection?.canWrite || !projection.encounterEditable || busy) return;
    const merged = supportsFor(candidate.diagnosisKey);
    const supports = merged.length ? merged : candidate.supportingFacts;
    if (supports.some(support => !projection.searchIndex.find(row => row.rowKey === support.rowKey)?.editable)) { setMessage("Supporting findings need review before picking a diagnosis."); return; }
    const patient = patientReference ?? (supports[0] ? `Patient/${supports[0].key.patientId}` : undefined);
    if (!patient || !supports.length) return;
    const eyes = new Set(supports.map(support => support.key.eye));
    const laterality = eyes.size === 2 ? "OU" : supports[0]!.key.eye;
    const retract = proposed(candidate);
    const commandId = crypto.randomUUID();
    const existing = projection.visitDiagnoses.find(row => row.diagnosisKey === candidate.diagnosisKey && row.laterality === laterality);
    setBusy(true); setMessage(undefined); setPendingLink(undefined);
    try {
      const link = async (reference: string) => {
        const command = supportedFindingLink(commandId, supports, projection, patient, reference);
        if (!command) { setMessage("Diagnosis saved; supporting findings need review before linking."); return; }
        await finishLink(command);
      };
      if (existing && !retract) { await link(existing.conditionReference); return; }
      if (!projection.canWriteDiagnosis) { setMessage("A provider must add this diagnosis before linking."); return; }
      await supportedDiagnosisPick({
        request: { encounterReference, commandId, diagnosisKey: candidate.diagnosisKey, action: retract ? "discard" : "possible", source: candidate.source, laterality, supportingFacts: supports },
        ...(!retract ? { scope: { patientReference: patient, laterality, ...(candidate.icd10?.code || candidate.icd10?.pattern ? { diagnosis: { stableKey: candidate.diagnosisKey, display: candidate.display, icd10: candidate.icd10.code ? { code: candidate.icd10.code } : { pattern: candidate.icd10.pattern! } } } : {}) } } : {}),
        onPicked: async () => { if (activeScope.current !== scopeKey) return false; await load(); if (activeScope.current !== scopeKey) return false; window.dispatchEvent(new CustomEvent("odos:encounter-findings-changed", { detail: { encounterReference } })); }, onScoped: () => undefined,
        ...(!retract ? { link: async (reference: string) => { if (activeScope.current === scopeKey) await link(reference); } } : {}), message: value => { if (activeScope.current === scopeKey) setMessage(value); },
      });
    } finally { setBusy(false); }
  }
  const disabled = busy || !projection?.canWrite || !projection.encounterEditable;
  return <div data-testid="structure-diagnosis-rail" className="mt-4 space-y-3 border-t border-white/10 pt-4">
    <div className="text-xs uppercase">Suggested diagnoses</div>
    {candidates.map((candidate, index) => <ProposalChoice key={`${candidate.diagnosisKey}:${index}`} display={candidate.display} code={catalogCode(candidate)} proposed={proposed(candidate)} busy={disabled} onToggle={() => pick(candidate)} />)}
    <OdosSearchPicker<CatalogRow> label="Full diagnosis catalog" placeholder="Search full diagnosis catalog" value={selection?.stableKey ?? ""} selectedLabel={selection?.display} disabled={disabled} onClear={() => setSelection(undefined)} search={async query => catalog.filter(row => row.display.toLowerCase().includes(query.toLowerCase())).slice(0,12).map(row => ({value:row.stableKey,label:row.display,item:row}))} onSelect={option => setSelection(option.item)} />
    {selection && (() => {
      const supportingFacts = projection?.searchIndex.filter(row => row.key?.stableKey === findingDefinitionKey && row.status === "live" && row.presence === "present" && row.baseline?.kind === "canonical").map(row => ({ rowKey: row.rowKey, key: row.key!, baseline: row.baseline as SupportingFindingFact["baseline"] })) ?? [];
      const candidate = { ...selection, diagnosisKey: selection.stableKey, source: "catalog-search" as const, priority: false, supportingFacts };
      return <ProposalChoice display={candidate.display} code={catalogCode(candidate)} proposed={proposed(candidate)} busy={disabled || !supportingFacts.length} onToggle={() => pick(candidate)} />;
    })()}
    {pendingLink && <button disabled={disabled} type="button" onClick={async () => { setBusy(true); try { await finishLink(pendingLink); } finally { setBusy(false); } }}>Finish linking</button>}
    {message && <p role="status">{message}</p>}
  </div>;
}
