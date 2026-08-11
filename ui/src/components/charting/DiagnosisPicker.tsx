import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase, submitDiagnosisPick } from "../../lib/clinical-graph-client";
import { OdosSearchPicker } from "../inputs/OdosSearchPicker";

interface Candidate {
  diagnosisKey: string;
  display: string;
  icd10?: { code?: string; pattern?: Record<string, string> };
  codingStatus: "verified" | "placeholder" | "provisional";
  priority: boolean;
  source: "rule" | "mapping";
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

export function DiagnosisPicker({
  encounterReference,
  observationReferences,
  findingDefinitionKey,
  refreshKey,
}: {
  encounterReference: string;
  observationReferences?: string[];
  findingDefinitionKey?: string;
  refreshKey?: number | string;
}) {
  const [findings, setFindings] = useState<CandidateFinding[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [catalogSelection, setCatalogSelection] = useState<CatalogRow>();
  const [overridden, setOverridden] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const observationKey = observationReferences?.join("|") ?? "";

  async function load(signal?: AbortSignal) {
    const requestVersion = ++loadVersion.current;
    try {
      const [candidateResponse, catalogResponse] = await Promise.all([
        fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/diagnosis-candidates`, { headers: authHeaders(), signal }),
        fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-catalog`, { headers: authHeaders(), signal }),
      ]);
      const candidateBody = await candidateResponse.json() as { findings?: CandidateFinding[]; error?: string };
      const catalogBody = await catalogResponse.json() as { diagnoses?: CatalogRow[]; error?: string };
      if (!candidateResponse.ok) throw new Error(candidateBody.error ?? `Diagnosis candidates request failed: ${candidateResponse.status}`);
      if (!catalogResponse.ok) throw new Error(catalogBody.error ?? `Diagnosis catalog request failed: ${catalogResponse.status}`);
      if (signal?.aborted || requestVersion !== loadVersion.current) return;
      const allowedObservations = new Set(observationReferences ?? []);
      setFindings((candidateBody.findings ?? []).map((finding) => ({
        ...finding,
        candidates: finding.candidates.filter((candidate) => typeof candidate.diagnosisKey === "string"),
        ...(finding.suppressedCandidates ? {
          suppressedCandidates: finding.suppressedCandidates.filter((candidate) => typeof candidate.diagnosisKey === "string"),
        } : {}),
      })).filter((finding) =>
        (finding.candidates.length > 0 || Boolean(finding.suppression && finding.suppressedCandidates?.length)) &&
        (!findingDefinitionKey || finding.findingDefinitionKey === findingDefinitionKey) &&
        (allowedObservations.size === 0 || Boolean(finding.observationReference && allowedObservations.has(finding.observationReference)))
      ));
      setCatalog((catalogBody.diagnoses ?? []).filter((row) => row.active));
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
  }, [encounterId, findingDefinitionKey, observationKey, refreshKey]);

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

  async function pick(finding: CandidateFinding, diagnosisKey: string, action: "possible" | "confirm", source: Candidate["source"] | "catalog-search") {
    setBusy(`${finding.findingInstanceId}:${diagnosisKey}:${action}`);
    setError(null);
    try {
      await submitDiagnosisPick({
        encounterReference,
        findingInstanceId: finding.findingInstanceId,
        diagnosisKey,
        action,
        source,
      });
      await load();
      setOpenId(null);
      setCatalogSelection(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (findings.length === 0) return error ? <div className="mt-3 text-xs text-[color:var(--odos-alert)]">{error}</div> : null;

  return (
    <div className="mt-3 space-y-2">
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
                  busy={busy !== null}
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
                    busy={busy !== null}
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
                  onClear={() => setCatalogSelection(undefined)}
                  onSelect={(option) => setCatalogSelection(option.item)}
                />
                {catalogSelection && (
                  <div className="mt-2">
                    <DiagnosisChoice
                      display={catalogSelection.display}
                      code={catalogCode(catalogSelection)}
                      codingStatus={catalogSelection.codingStatus}
                      busy={busy !== null}
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

function catalogCode(row: Pick<CatalogRow, "icd10">): string | undefined {
  if (!row.icd10) return undefined;
  if (row.icd10.code) return row.icd10.code;
  return row.icd10.pattern?.unspecifiedEye;
}
