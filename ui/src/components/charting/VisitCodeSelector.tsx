import { useEffect, useState } from "react";
import {
  visitChargeApi,
  type VisitChargeApi,
  type VisitChargeDiagnosis,
  type VisitChargeOption,
  type VisitChargeProposal,
  type VisitChargeResponse,
  type VisitProcedureFamily,
} from "../../lib/clinical-graph-client";

const DEFAULT_API = visitChargeApi();

export function VisitCodeSelector({
  encounterId,
  disabled = false,
  api = DEFAULT_API,
  onProcedureFamilyChange,
  onVisitChargeChange,
}: {
  encounterId: string;
  disabled?: boolean;
  api?: VisitChargeApi;
  onProcedureFamilyChange?: (family: VisitProcedureFamily | null | undefined) => void;
  onVisitChargeChange?: (response: VisitChargeResponse | undefined) => void;
}) {
  const [options, setOptions] = useState<VisitChargeOption[]>([]);
  const [diagnoses, setDiagnoses] = useState<VisitChargeDiagnosis[]>([]);
  const [proposal, setProposal] = useState<VisitChargeProposal>();
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setOptions([]);
    setDiagnoses([]);
    setProposal(undefined);
    setSelected("");
    onProcedureFamilyChange?.(undefined);
    onVisitChargeChange?.(undefined);
    void api.read(encounterId)
      .then((response) => {
        if (cancelled) return;
        setOptions(response.options);
        setDiagnoses(response.diagnoses);
        setProposal(response.proposal);
        setSelected(response.selectedProcedureConceptKey ?? "");
        onProcedureFamilyChange?.(response.procedureFamily ?? null);
        onVisitChargeChange?.(response);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, encounterId, onProcedureFamilyChange, onVisitChargeChange]);

  async function changeProcedure(value: string) {
    setSaving(true);
    setError(undefined);
    try {
      const response = await api.save(encounterId, { procedureConceptKey: value || null });
      setSelected(value);
      setProposal(response.proposal);
      onProcedureFamilyChange?.(response.procedureFamily ?? null);
      onVisitChargeChange?.({
        options,
        diagnoses,
        ...(value ? { selectedProcedureConceptKey: value } : {}),
        ...(response.procedureFamily ? { procedureFamily: response.procedureFamily } : {}),
        ...(response.proposal ? { proposal: response.proposal } : {}),
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function changeDiagnosis(value: string) {
    setSaving(true);
    setError(undefined);
    try {
      const response = await api.save(encounterId, { dxPointer: value || null });
      const nextProposal = response.proposal ?? proposal;
      if (response.proposal) setProposal(response.proposal);
      if (response.procedureFamily !== undefined) {
        onProcedureFamilyChange?.(response.procedureFamily);
      }
      onVisitChargeChange?.({
        options,
        diagnoses,
        ...(selected ? { selectedProcedureConceptKey: selected } : {}),
        ...(response.procedureFamily ? { procedureFamily: response.procedureFamily } : {}),
        ...(nextProposal ? { proposal: nextProposal } : {}),
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="visit-code-selector">
      <label className="text-xs font-semibold uppercase tracking-widest text-[color:var(--odos-faint)]" htmlFor={`visit-code-${encounterId}`}>
        Visit billing code
      </label>
      <select
        id={`visit-code-${encounterId}`}
        aria-label="Visit billing code"
        className="scheduler-input min-w-72"
        value={selected}
        disabled={disabled || loading || saving}
        onChange={(event) => changeProcedure(event.target.value)}
      >
        <option value="">No visit billing code</option>
        {options.map((option) => (
          <option key={option.procedureConceptKey} value={option.procedureConceptKey}>
            {option.display}{option.billingCode ? ` — ${option.billingCode}` : ""}
          </option>
        ))}
      </select>
      {selected && proposal?.state === "accepted" && (
        <>
          <label
            className="text-xs font-semibold uppercase tracking-widest text-[color:var(--odos-faint)]"
            htmlFor={`visit-code-diagnosis-${encounterId}`}
          >
            Diagnosis
          </label>
          <select
            id={`visit-code-diagnosis-${encounterId}`}
            aria-label="Visit billing diagnosis"
            className="scheduler-input min-w-64"
            value={proposal.dxPointers[0] ?? ""}
            disabled={disabled || loading || saving}
            onChange={(event) => changeDiagnosis(event.target.value)}
          >
            <option value="">No diagnosis selected</option>
            {diagnoses.map((diagnosis) => (
              <option key={diagnosis.reference} value={diagnosis.reference}>
                {diagnosis.display}
              </option>
            ))}
          </select>
          {proposal.dxPointers.length === 0 && (
            <span
              data-testid="visit-code-diagnosis-warning"
              className="text-xs text-amber-100"
            >
              No diagnosis selected — this visit charge will not be included in a claim.
            </span>
          )}
        </>
      )}
      {saving && <span className="text-xs text-[color:var(--odos-faint)]">Saving…</span>}
      {error && <span aria-live="polite" data-testid="visit-code-error" className="text-xs text-red-200">{error}</span>}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
