import { useEffect, useState } from "react";
import {
  visitChargeApi,
  type VisitChargeApi,
  type VisitChargeOption,
} from "../../lib/visit-charge";

const DEFAULT_API = visitChargeApi();

export function VisitCodeSelector({
  encounterId,
  disabled = false,
  api = DEFAULT_API,
}: {
  encounterId: string;
  disabled?: boolean;
  api?: VisitChargeApi;
}) {
  const [options, setOptions] = useState<VisitChargeOption[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void api.read(encounterId)
      .then((response) => {
        if (cancelled) return;
        setOptions(response.options);
        setSelected(response.selectedProcedureConceptKey ?? "");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, encounterId]);

  async function change(value: string) {
    setSaving(true);
    setError(undefined);
    try {
      await api.save(encounterId, value || null);
      setSelected(value);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="visit-code-selector">
      <label className="text-xs font-semibold uppercase tracking-widest text-white/45" htmlFor={`visit-code-${encounterId}`}>
        Visit billing code
      </label>
      <select
        id={`visit-code-${encounterId}`}
        aria-label="Visit billing code"
        className="scheduler-input min-w-72"
        value={selected}
        disabled={disabled || loading || saving}
        onChange={(event) => change(event.target.value)}
      >
        <option value="">No visit billing code</option>
        {options.map((option) => (
          <option key={option.procedureConceptKey} value={option.procedureConceptKey}>
            {option.display}{option.billingCode ? ` — ${option.billingCode}` : ""}
          </option>
        ))}
      </select>
      {saving && <span className="text-xs text-white/45">Saving…</span>}
      {error && <span role="alert" className="text-xs text-red-200">{error}</span>}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
