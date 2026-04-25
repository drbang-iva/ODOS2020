import { useState } from "react";
import { fhir } from "../../lib/fhir";
import { assertTransactionSuccess } from "../../lib/encounter-bundles";
import {
  buildSectionSaveBundle,
  type VisualAcuitySectionSaveEntry,
} from "../../lib/fhir-ophthalmology/save-section-bundle";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

interface VaRowState {
  snellen: string;
  chartType: VisualAcuitySectionSaveEntry["chartType"];
  correction: VisualAcuitySectionSaveEntry["correction"];
}

const OPERATOR = "OSOD UI save_va";

export function VaSection({ patientReference, encounterReference, onSaved }: Props) {
  const [rows, setRows] = useState<Record<"OD" | "OS", VaRowState>>({
    OD: { snellen: "", chartType: "SNELLEN", correction: "SC" },
    OS: { snellen: "", chartType: "SNELLEN", correction: "SC" },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);

  async function save() {
    const entries = (["OD", "OS"] as const).flatMap((laterality) => {
      const row = rows[laterality];
      if (!row.snellen.trim()) return [];
      return [{ laterality, ...row, snellen: row.snellen.trim() }];
    });

    if (entries.length === 0) {
      setError("Enter at least one visual acuity row before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fhir.executeTransaction(
        buildSectionSaveBundle({
          patientReference,
          encounterReference,
          section: "va",
          entries,
          operatorDisplay: OPERATOR,
        }),
        "save_va",
      );
      assertTransactionSuccess(response);
      const status = {
        completed: true,
        summary: entries.map((entry) => `${entry.laterality} ${entry.snellen} ${entry.correction.toLowerCase()}`).join(" - "),
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
      <div className="max-w-4xl">
        <h2 className="text-lg font-semibold text-white">Visual Acuity</h2>
        <div className="mt-5 overflow-hidden rounded border border-white/10">
          <div className="grid grid-cols-[72px_1fr_180px_180px] gap-0 bg-white/5 px-4 py-2 text-xs uppercase tracking-widest text-white/35">
            <div>Eye</div>
            <div>Snellen</div>
            <div>Chart</div>
            <div>Correction</div>
          </div>
          {(["OD", "OS"] as const).map((laterality) => (
            <div key={laterality} className="grid grid-cols-[72px_1fr_180px_180px] gap-3 border-t border-white/10 p-4">
              <div className="pt-3 text-sm font-semibold text-white">{laterality}</div>
              <input
                value={rows[laterality].snellen}
                onChange={(event) =>
                  setRows((current) => ({
                    ...current,
                    [laterality]: { ...current[laterality], snellen: event.target.value },
                  }))
                }
                placeholder="20/20"
                className="h-11 rounded border border-white/15 bg-bg px-3 text-white outline-none focus:border-brand"
              />
              <select
                value={rows[laterality].chartType}
                onChange={(event) =>
                  setRows((current) => ({
                    ...current,
                    [laterality]: {
                      ...current[laterality],
                      chartType: event.target.value as VaRowState["chartType"],
                    },
                  }))
                }
                className="h-11 rounded border border-white/15 bg-bg px-3 text-white outline-none focus:border-brand"
              >
                {["SNELLEN", "ETDRS", "LOGMAR", "JAEGER", "OTHER", "UNKNOWN"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
              <select
                value={rows[laterality].correction}
                onChange={(event) =>
                  setRows((current) => ({
                    ...current,
                    [laterality]: {
                      ...current[laterality],
                      correction: event.target.value as VaRowState["correction"],
                    },
                  }))
                }
                className="h-11 rounded border border-white/15 bg-bg px-3 text-white outline-none focus:border-brand"
              >
                {["SC", "CC", "BCVA", "PH", "NI", "OTHER", "UNKNOWN"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <SectionFooter
          error={error}
          saved={saved}
          saving={saving}
          onSave={save}
        />
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
        {saving ? "Saving..." : "Save VA"}
      </button>
    </div>
  );
}
