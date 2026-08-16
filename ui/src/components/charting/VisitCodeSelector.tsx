import { useCallback, useEffect, useRef, useState } from "react";
import {
  visitChargeApi,
  type VisitChargeApi,
  type VisitChargeChange,
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
  const requestVersion = useRef(0);
  const activeEncounter = useRef<string>();

  const read = useCallback(async (reset: boolean) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(undefined);
    if (reset) {
      setOptions([]);
      setDiagnoses([]);
      setProposal(undefined);
      setSelected("");
      onProcedureFamilyChange?.(undefined);
      onVisitChargeChange?.(undefined);
    }
    try {
      const response = await api.read(encounterId);
      if (version !== requestVersion.current) return;
      setOptions(response.options);
      setDiagnoses(response.diagnoses);
      setProposal(response.proposal);
      setSelected(response.selectedProcedureConceptKey ?? "");
      onProcedureFamilyChange?.(response.procedureFamily ?? null);
      onVisitChargeChange?.(response);
    } catch (reason) {
      if (version === requestVersion.current) setError(errorMessage(reason));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [api, encounterId, onProcedureFamilyChange, onVisitChargeChange]);

  useEffect(() => {
    activeEncounter.current = encounterId;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ encounterReference?: string }>).detail;
      if (detail?.encounterReference === `Encounter/${encounterId}`) void read(false);
    };
    void read(true);
    if (typeof window !== "undefined") {
      window.addEventListener("odos:diagnosis-picked", refresh);
      window.addEventListener("odos:encounter-diagnosis-updated", refresh);
    }
    return () => {
      if (activeEncounter.current === encounterId) activeEncounter.current = undefined;
      requestVersion.current += 1;
      if (typeof window !== "undefined") {
        window.removeEventListener("odos:diagnosis-picked", refresh);
        window.removeEventListener("odos:encounter-diagnosis-updated", refresh);
      }
    };
  }, [encounterId, read]);

  async function saveAndRefresh(change: VisitChargeChange) {
    requestVersion.current += 1;
    setSaving(true);
    setError(undefined);
    let saveError: string | undefined;
    try {
      await api.save(encounterId, change);
    } catch (reason) {
      saveError = errorMessage(reason);
    } finally {
      if (activeEncounter.current === encounterId) {
        await read(false);
        if (activeEncounter.current === encounterId) {
          if (saveError) setError(saveError);
          setSaving(false);
        }
      }
    }
  }

  function changeProcedure(value: string) {
    return saveAndRefresh({ procedureConceptKey: value || null });
  }

  function changeDiagnosis(value: string) {
    return saveAndRefresh({ dxPointer: value || null });
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
