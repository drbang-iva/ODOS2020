import { useState } from "react";
import { fhir } from "../../lib/fhir";
import { assertTransactionSuccess } from "../../lib/encounter-bundles";
import {
  buildSectionSaveBundle,
  type RefractionSectionSaveEntry,
} from "../../lib/fhir-ophthalmology/save-section-bundle";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

interface RefractionRowState {
  refractionType: RefractionSectionSaveEntry["refractionType"];
  sphere: string;
  cylinder: string;
  axis: string;
  add: string;
}

const OPERATOR = "OSOD UI save_refraction";

export function RefractionSection({ patientReference, encounterReference, onSaved }: Props) {
  const [rows, setRows] = useState<Record<"OD" | "OS", RefractionRowState>>({
    OD: { refractionType: "MANIFEST", sphere: "", cylinder: "", axis: "", add: "" },
    OS: { refractionType: "MANIFEST", sphere: "", cylinder: "", axis: "", add: "" },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);

  async function save() {
    let entries: RefractionSectionSaveEntry[];
    try {
      entries = (["OD", "OS"] as const).flatMap((laterality) => {
        const row = rows[laterality];
        if (![row.sphere, row.cylinder, row.axis, row.add].some((value) => value.trim())) {
          return [];
        }
        if ((row.cylinder.trim() && !row.axis.trim()) || (!row.cylinder.trim() && row.axis.trim())) {
          throw new Error(`${laterality} cylinder and axis must be saved together.`);
        }
        return [
          {
            laterality,
            refractionType: row.refractionType,
            sphere: parseOptionalNumber(row.sphere, `${laterality} sphere`),
            cylinder: parseOptionalNumber(row.cylinder, `${laterality} cylinder`),
            axis: parseOptionalNumber(row.axis, `${laterality} axis`),
            add: parseOptionalNumber(row.add, `${laterality} add`),
          },
        ];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (entries.length === 0) {
      setError("Enter at least one refraction row before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fhir.executeTransaction(
        buildSectionSaveBundle({
          patientReference,
          encounterReference,
          section: "refraction",
          entries,
          operatorDisplay: OPERATOR,
        }),
        "save_refraction",
      );
      assertTransactionSuccess(response);
      const status = {
        completed: true,
        summary: entries.map(formatEntrySummary).join(" - "),
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
      <div className="max-w-5xl">
        <h2 className="text-lg font-semibold text-white">Refraction</h2>
        <div className="mt-5 overflow-hidden rounded border border-white/10">
          <div className="grid grid-cols-[72px_170px_repeat(4,minmax(110px,1fr))] bg-white/5 px-4 py-2 text-xs uppercase tracking-widest text-white/35">
            <div>Eye</div>
            <div>Type</div>
            <div>Sphere</div>
            <div>Cyl</div>
            <div>Axis</div>
            <div>Add</div>
          </div>
          {(["OD", "OS"] as const).map((laterality) => (
            <div key={laterality} className="grid grid-cols-[72px_170px_repeat(4,minmax(110px,1fr))] gap-3 border-t border-white/10 p-4">
              <div className="pt-3 text-sm font-semibold text-white">{laterality}</div>
              <select
                value={rows[laterality].refractionType}
                onChange={(event) =>
                  setRows((current) => ({
                    ...current,
                    [laterality]: {
                      ...current[laterality],
                      refractionType: event.target.value as RefractionRowState["refractionType"],
                    },
                  }))
                }
                className="h-11 rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
              >
                {["AUTOREFRACTION", "MANIFEST", "CYCLOPLEGIC", "FINAL_RX", "OTHER"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
              {(["sphere", "cylinder", "axis", "add"] as const).map((field) => (
                <input
                  key={field}
                  value={rows[laterality][field]}
                  onChange={(event) =>
                    setRows((current) => ({
                      ...current,
                      [laterality]: { ...current[laterality], [field]: event.target.value },
                    }))
                  }
                  inputMode="decimal"
                  placeholder={field === "axis" ? "180" : "0.00"}
                  className="h-11 rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
                />
              ))}
            </div>
          ))}
        </div>

        <SectionFooter error={error} saved={saved} saving={saving} onSave={save} />
      </div>
    </section>
  );
}

function parseOptionalNumber(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be numeric.`);
  }
  return parsed;
}

function formatEntrySummary(entry: RefractionSectionSaveEntry): string {
  return [
    entry.laterality,
    formatDiopter(entry.sphere),
    formatDiopter(entry.cylinder),
    entry.axis !== undefined ? `x${entry.axis}` : undefined,
    entry.add !== undefined ? `add ${formatDiopter(entry.add)}` : undefined,
  ].filter(Boolean).join(" ");
}

function formatDiopter(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === 0) return "plano";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
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
        {saving ? "Saving..." : "Save Refraction"}
      </button>
    </div>
  );
}
