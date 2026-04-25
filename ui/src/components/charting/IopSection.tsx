import { useState } from "react";
import { fhir } from "../../lib/fhir";
import { assertTransactionSuccess } from "../../lib/encounter-bundles";
import {
  buildSectionSaveBundle,
  type IopSectionSaveEntry,
} from "../../lib/fhir-ophthalmology/save-section-bundle";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

interface IopRowState {
  value: string;
  method: IopSectionSaveEntry["method"];
}

const OPERATOR = "OSOD UI save_iop";

export function IopSection({ patientReference, encounterReference, onSaved }: Props) {
  const [rows, setRows] = useState<Record<"OD" | "OS", IopRowState>>({
    OD: { value: "", method: "GAT" },
    OS: { value: "", method: "GAT" },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);

  async function save() {
    let entries: IopSectionSaveEntry[];
    try {
      entries = (["OD", "OS"] as const).flatMap((laterality) => {
        const row = rows[laterality];
        if (!row.value.trim()) return [];
        const value = Number(row.value);
        if (!Number.isFinite(value)) {
          throw new Error(`${laterality} IOP must be numeric.`);
        }
        return [{ laterality, value, method: row.method }];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (entries.length === 0) {
      setError("Enter at least one IOP row before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fhir.executeTransaction(
        buildSectionSaveBundle({
          patientReference,
          encounterReference,
          section: "iop",
          entries,
          operatorDisplay: OPERATOR,
        }),
        "save_iop",
      );
      assertTransactionSuccess(response);
      const status = {
        completed: true,
        summary: entries.map((entry) => `${entry.laterality} ${entry.value} mmHg`).join(" - "),
        savedAt: new Date().toISOString(),
        operator: OPERATOR,
      };
      setSaved(status);
      onSaved(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl">
        <h2 className="text-lg font-semibold text-white">Intraocular Pressure</h2>
        <div className="mt-5 overflow-hidden rounded border border-white/10">
          <div className="grid grid-cols-[72px_1fr_180px] bg-white/5 px-4 py-2 text-xs uppercase tracking-widest text-white/35">
            <div>Eye</div>
            <div>mmHg</div>
            <div>Method</div>
          </div>
          {(["OD", "OS"] as const).map((laterality) => (
            <div key={laterality} className="grid grid-cols-[72px_1fr_180px] gap-3 border-t border-white/10 p-4">
              <div className="pt-3 text-sm font-semibold text-white">{laterality}</div>
              <input
                value={rows[laterality].value}
                onChange={(event) =>
                  setRows((current) => ({
                    ...current,
                    [laterality]: { ...current[laterality], value: event.target.value },
                  }))
                }
                inputMode="decimal"
                placeholder="14"
                className="h-11 rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
              />
              <select
                value={rows[laterality].method}
                onChange={(event) =>
                  setRows((current) => ({
                    ...current,
                    [laterality]: {
                      ...current[laterality],
                      method: event.target.value as IopRowState["method"],
                    },
                  }))
                }
                className="h-11 rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
              >
                {["GAT", "ICARE", "TONOPEN", "NCT", "PERKINS", "OTHER", "UNKNOWN"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <SectionFooter error={error} saved={saved} saving={saving} onSave={save} />
      </div>
    </section>
  );
}

function SectionFooter({
  error,
  saved,
  saving,
  onSave,
}: {
  error: string | null;
  saved: SectionSaveStatus | null;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-h-10">
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
        {saved && !error && (
          <div className="text-sm text-white/70">
            {saved.summary}
            <span className="ml-3 rounded border border-white/10 px-2 py-1 text-xs text-white/45">
              {saved.operator} {saved.savedAt}
            </span>
          </div>
        )}
      </div>
      <button
        onClick={onSave}
        disabled={saving}
        className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save IOP"}
      </button>
    </div>
  );
}
