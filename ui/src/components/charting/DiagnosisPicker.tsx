import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase, submitDiagnosisPick } from "../../lib/clinical-graph-client";

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
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const observationKey = observationReferences?.join("|") ?? "";

  async function load() {
    const [candidateResponse, catalogResponse] = await Promise.all([
      fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/diagnosis-candidates`, { headers: authHeaders() }),
      fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-catalog`, { headers: authHeaders() }),
    ]);
    const candidateBody = await candidateResponse.json() as { findings?: CandidateFinding[]; error?: string };
    const catalogBody = await catalogResponse.json() as { diagnoses?: CatalogRow[]; error?: string };
    if (!candidateResponse.ok) throw new Error(candidateBody.error ?? `Diagnosis candidates request failed: ${candidateResponse.status}`);
    if (!catalogResponse.ok) throw new Error(catalogBody.error ?? `Diagnosis catalog request failed: ${catalogResponse.status}`);
    const allowedObservations = new Set(observationReferences ?? []);
    setFindings((candidateBody.findings ?? []).filter((finding) =>
      finding.candidates.length > 0 &&
      (!findingDefinitionKey || finding.findingDefinitionKey === findingDefinitionKey) &&
      (allowedObservations.size === 0 || Boolean(finding.observationReference && allowedObservations.has(finding.observationReference)))
    ));
    setCatalog((catalogBody.diagnoses ?? []).filter((row) => row.active));
  }

  useEffect(() => {
    if (!encounterId || observationReferences && observationReferences.length === 0) {
      setFindings([]);
      return;
    }
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [encounterId, findingDefinitionKey, observationKey, refreshKey]);

  const searchRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return catalog.filter((row) => `${row.display} ${row.stableKey} ${catalogCode(row)}`.toLowerCase().includes(term)).slice(0, 12);
  }, [catalog, search]);

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
      setSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (findings.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {findings.map((finding) => (
        <div key={finding.findingInstanceId} className="relative inline-block align-top">
          <button
            type="button"
            onClick={() => setOpenId((current) => current === finding.findingInstanceId ? null : finding.findingInstanceId)}
            className="rounded-full border border-brand/50 bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/20"
            aria-expanded={openId === finding.findingInstanceId}
          >
            dx ▾ {finding.candidates.length}
          </button>
          {openId === finding.findingInstanceId && (
            <div className="absolute left-0 z-30 mt-2 w-[min(520px,calc(100vw-3rem))] rounded border border-white/15 bg-bg-deep p-3 shadow-2xl">
              <div className="space-y-2">
                {finding.candidates.map((candidate) => (
                  <DiagnosisChoice
                    key={candidate.diagnosisKey}
                    display={candidate.display}
                    code={candidate.icd10?.code}
                    codingStatus={candidate.codingStatus}
                    busy={busy !== null}
                    onPossible={() => pick(finding, candidate.diagnosisKey, "possible", candidate.source)}
                    onConfirm={() => pick(finding, candidate.diagnosisKey, "confirm", candidate.source)}
                  />
                ))}
              </div>
              <div className="mt-3 border-t border-white/10 pt-3">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search full diagnosis catalog"
                  className="h-9 w-full rounded border border-white/15 bg-bg-panel px-3 text-sm text-white outline-none focus:border-brand"
                />
                {searchRows.length > 0 && (
                  <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                    {searchRows.map((row) => (
                      <DiagnosisChoice
                        key={row.stableKey}
                        display={row.display}
                        code={catalogCode(row)}
                        codingStatus={row.codingStatus}
                        busy={busy !== null}
                        onPossible={() => pick(finding, row.stableKey, "possible", "catalog-search")}
                        onConfirm={() => pick(finding, row.stableKey, "confirm", "catalog-search")}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
      {error && <div className="text-xs text-red-200">{error}</div>}
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
    <div className="rounded border border-white/10 bg-white/[0.03] p-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-white">{display}</div>
          <div className="mt-0.5 text-xs text-white/45">{code ?? "no code yet"}</div>
        </div>
        {codingStatus === "provisional" && <span className="rounded border border-amber-300/30 px-1.5 py-0.5 text-[10px] uppercase text-amber-100">provisional</span>}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" disabled={busy} onClick={onPossible} className="rounded border border-amber-300/35 bg-amber-400/10 px-2 py-1.5 text-xs font-semibold text-amber-100 disabled:opacity-45">Possible</button>
        <button type="button" disabled={busy} onClick={onConfirm} className="rounded border border-emerald-300/35 bg-emerald-400/10 px-2 py-1.5 text-xs font-semibold text-emerald-100 disabled:opacity-45">Confirm</button>
      </div>
    </div>
  );
}

function catalogCode(row: CatalogRow): string | undefined {
  if (!row.icd10) return undefined;
  if (row.icd10.code) return row.icd10.code;
  return row.icd10.pattern?.unspecifiedEye;
}
