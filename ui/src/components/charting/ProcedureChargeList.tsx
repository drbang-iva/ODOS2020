import { useEffect, useMemo, useState } from "react";
import {
  procedureChargeApi,
  type ManualProcedureCharge,
  type ProcedureChargeApi,
  type ProcedureChargeChange,
  type ProcedureChargeDiagnosis,
  type ProcedureChargeOption,
} from "../../lib/clinical-graph-client";

const DEFAULT_API = procedureChargeApi();

export function ProcedureChargeList({
  encounterId,
  disabled = false,
  api = DEFAULT_API,
}: {
  encounterId: string;
  disabled?: boolean;
  api?: ProcedureChargeApi;
}) {
  const [options, setOptions] = useState<ProcedureChargeOption[]>([]);
  const [diagnoses, setDiagnoses] = useState<ProcedureChargeDiagnosis[]>([]);
  const [proposals, setProposals] = useState<ManualProcedureCharge[]>([]);
  const [selectedConcept, setSelectedConcept] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [savingIds, setSavingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void api.read(encounterId)
      .then((response) => {
        if (cancelled) return;
        setOptions(response.options);
        setDiagnoses(response.diagnoses);
        setProposals(response.proposals);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, encounterId]);

  const optionByKey = useMemo(
    () => new Map(options.map((option) => [option.procedureConceptKey, option])),
    [options],
  );

  async function add() {
    if (!selectedConcept) return;
    setAdding(true);
    setError(undefined);
    try {
      const response = await api.create(encounterId, selectedConcept);
      setProposals((current) => replaceProposal(current, response.proposal));
      setSelectedConcept("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAdding(false);
    }
  }

  async function patch(proposalId: string, change: ProcedureChargeChange) {
    setSavingIds((current) => new Set(current).add(proposalId));
    setError(undefined);
    try {
      const response = await api.patch(encounterId, proposalId, change);
      setProposals((current) => replaceProposal(current, response.proposal));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingIds((current) => {
        const next = new Set(current);
        next.delete(proposalId);
        return next;
      });
    }
  }

  return (
    <div className="mt-3 space-y-2" data-testid="procedure-charge-list">
      <div className="flex flex-wrap items-center gap-3">
        <label
          className="text-xs font-semibold uppercase tracking-widest text-[color:var(--odos-faint)]"
          htmlFor={`procedure-charge-add-${encounterId}`}
        >
          Procedure charges
        </label>
        <select
          id={`procedure-charge-add-${encounterId}`}
          aria-label="Procedure to add"
          className="scheduler-input min-w-72"
          value={selectedConcept}
          disabled={disabled || loading || adding}
          onChange={(event) => setSelectedConcept(event.target.value)}
        >
          <option value="">Select procedure</option>
          {options.map((option) => (
            <option key={option.procedureConceptKey} value={option.procedureConceptKey}>
              {option.display} — {option.billingCode}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded border border-[color:var(--odos-line-2)] px-3 py-2 text-sm text-[color:var(--odos-muted)] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || loading || adding || !selectedConcept}
          onClick={() => void add()}
        >
          Add procedure
        </button>
      </div>

      {proposals.filter((proposal) => proposal.state === "accepted").map((proposal) => {
        const option = optionByKey.get(proposal.procedureConceptKey);
        const display = option?.display ?? proposal.procedureConceptKey;
        const saving = savingIds.has(proposal.id);
        return (
          <div
            key={proposal.id}
            data-testid="procedure-charge-row"
            className="flex flex-wrap items-center gap-3 rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface-2)] p-2"
          >
            <span className="text-sm font-medium text-[color:var(--odos-text)]">{display}</span>
            {option?.billingCode && <span className="text-xs text-[color:var(--odos-muted)]">{option.billingCode}</span>}
            <select
              aria-label={`Laterality for ${display}`}
              className="scheduler-input"
              value={proposal.laterality ?? ""}
              disabled={disabled || saving}
              onChange={(event) => void patch(proposal.id, {
                laterality: event.target.value
                  ? event.target.value as "OD" | "OS" | "OU"
                  : null,
              })}
            >
              <option value="">Laterality unset</option>
              <option value="OD">OD</option>
              <option value="OS">OS</option>
              <option value="OU">OU</option>
            </select>
            <select
              aria-label={`Diagnosis for ${display}`}
              className="scheduler-input min-w-64"
              value={proposal.dxPointers[0] ?? ""}
              disabled={disabled || saving}
              onChange={(event) => void patch(proposal.id, {
                dxPointer: event.target.value || null,
              })}
            >
              <option value="">No diagnosis selected</option>
              {diagnoses.map((diagnosis) => (
                <option key={diagnosis.reference} value={diagnosis.reference}>
                  {diagnosis.display}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded border border-red-400/30 px-2 py-1 text-xs text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabled || saving}
              onClick={() => void patch(proposal.id, { state: "removed" })}
            >
              Remove
            </button>
          </div>
        );
      })}

      {error && (
        <div
          aria-live="polite"
          data-testid="procedure-charge-error"
          className="text-xs text-red-200"
        >
          {error}
        </div>
      )}
    </div>
  );
}

function replaceProposal(
  proposals: ManualProcedureCharge[],
  proposal: ManualProcedureCharge,
): ManualProcedureCharge[] {
  const index = proposals.findIndex((candidate) => candidate.id === proposal.id);
  if (index < 0) return [...proposals, proposal];
  return proposals.map((candidate) => candidate.id === proposal.id ? proposal : candidate);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
