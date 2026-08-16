import { useEffect, useRef, useState } from "react";
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
  const visitState = useRef<VisitChargeResponse>();

  useEffect(() => {
    let cancelled = false;
    let readVersion = 0;
    const read = (reset: boolean) => {
      const version = ++readVersion;
      setLoading(true);
      setError(undefined);
      if (reset) {
        visitState.current = undefined;
        setOptions([]);
        setDiagnoses([]);
        setProposal(undefined);
        setSelected("");
        onProcedureFamilyChange?.(undefined);
        onVisitChargeChange?.(undefined);
      }
      void api.read(encounterId)
        .then((response) => {
          if (cancelled || version !== readVersion) return;
          visitState.current = response;
          setOptions(response.options);
          setDiagnoses(response.diagnoses);
          setProposal(response.proposal);
          setSelected(response.selectedProcedureConceptKey ?? "");
          onProcedureFamilyChange?.(response.procedureFamily ?? null);
          onVisitChargeChange?.(response);
        })
        .catch((reason: unknown) => {
          if (!cancelled && version === readVersion) setError(errorMessage(reason));
        })
        .finally(() => {
          if (!cancelled && version === readVersion) setLoading(false);
        });
    };
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ encounterReference?: string }>).detail;
      if (detail?.encounterReference === `Encounter/${encounterId}`) read(false);
    };
    read(true);
    if (typeof window !== "undefined") {
      window.addEventListener("odos:diagnosis-picked", refresh);
      window.addEventListener("odos:encounter-diagnosis-updated", refresh);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("odos:diagnosis-picked", refresh);
        window.removeEventListener("odos:encounter-diagnosis-updated", refresh);
      }
    };
  }, [api, encounterId, onProcedureFamilyChange, onVisitChargeChange]);

  async function changeProcedure(value: string) {
    setSaving(true);
    setError(undefined);
    try {
      const response = await api.save(encounterId, { procedureConceptKey: value || null });
      const current = visitState.current;
      const next: VisitChargeResponse = {
        options: current?.options ?? options,
        diagnoses: current?.diagnoses ?? diagnoses,
        ...(value ? { selectedProcedureConceptKey: value } : {}),
        ...(response.procedureFamily ? { procedureFamily: response.procedureFamily } : {}),
        ...(response.proposal ? { proposal: response.proposal } : {}),
      };
      visitState.current = next;
      setSelected(value);
      setProposal(response.proposal);
      onProcedureFamilyChange?.(response.procedureFamily ?? null);
      onVisitChargeChange?.(next);
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
      const current = visitState.current;
      const nextProposal = response.proposal ?? current?.proposal ?? proposal;
      const nextSelected = current?.selectedProcedureConceptKey ?? selected;
      const nextFamily = response.procedureFamily ?? current?.procedureFamily;
      const next: VisitChargeResponse = {
        options: current?.options ?? options,
        diagnoses: current?.diagnoses ?? diagnoses,
        ...(nextSelected ? { selectedProcedureConceptKey: nextSelected } : {}),
        ...(nextFamily ? { procedureFamily: nextFamily } : {}),
        ...(nextProposal ? { proposal: nextProposal } : {}),
      };
      visitState.current = next;
      if (response.proposal) setProposal(response.proposal);
      if (response.procedureFamily !== undefined) {
        onProcedureFamilyChange?.(response.procedureFamily);
      }
      onVisitChargeChange?.(next);
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
