import { useEffect, useState } from "react";
import { fhir } from "../../lib/fhir";
import { voidEncounterEntries } from "../../lib/encounter-void";
import { ClearSectionButton } from "./ClearControls";
import { EditEntriesToggle, RemoveValueButton, SectionEditingProvider } from "./section-editing";
import { useEncounterEdit } from "./encounter-edit-context";
import { usePersistedVoidEntries } from "./use-persisted-void-entries";
import { assertTransactionSuccess } from "../../lib/encounter-bundles";
import {
  buildSectionSaveBundle,
  type VisualAcuitySectionSaveEntry,
} from "../../lib/fhir-ophthalmology/save-section-bundle";
import type { SectionSaveStatus } from "./types";
import { VaValueSelect } from "./VaValueSelect";

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

const OPERATOR = "ODOS UI save_va";

export function VaSection({ patientReference, encounterReference, onSaved }: Props) {
  const [rows, setRows] = useState<Record<"OD" | "OS", VaRowState>>({
    OD: { snellen: "", chartType: "SNELLEN", correction: "SC" },
    OS: { snellen: "", chartType: "SNELLEN", correction: "SC" },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [savedEyes, setSavedEyes] = useState<Array<"OD" | "OS">>([]);
  const { onCleared } = useEncounterEdit();
  // Values persisted before this session are recorded values too: offer their × on reopen.
  const persisted = usePersistedVoidEntries(encounterReference, "va");
  useEffect(() => {
    if (!persisted.loaded) return;
    const eyes = [...new Set(persisted.entries.flatMap((entry) => entry.laterality === "OD" || entry.laterality === "OS" ? [entry.laterality] : []))];
    setSavedEyes((current) => [...new Set([...current, ...eyes])]);
  }, [persisted]);

  function emptyRows(): Record<"OD" | "OS", VaRowState> {
    return {
      OD: { snellen: "", chartType: "SNELLEN", correction: "SC" },
      OS: { snellen: "", chartType: "SNELLEN", correction: "SC" },
    };
  }

  async function removeEye(laterality: "OD" | "OS") {
    try {
      const result = await voidEncounterEntries(encounterReference, { scope: "finding", findingKey: "VISUAL_ACUITY", laterality });
      setSavedEyes((current) => current.filter((eye) => eye !== laterality));
      setRows((current) => ({ ...current, [laterality]: emptyRows()[laterality] }));
      setSaved(null);
      onCleared?.({ scope: "finding", result });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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
      setSavedEyes(entries.map((entry) => entry.laterality));
      onSaved(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionEditingProvider hasRecorded={savedEyes.length > 0}>
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-4xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Visual Acuity</h2>
          <div className="flex flex-wrap items-center gap-2">
            <EditEntriesToggle />
            <ClearSectionButton
              encounterReference={encounterReference}
              sectionKey="va"
              label="Visual acuity"
              hasRecorded={savedEyes.length > 0}
              onCleared={(result) => {
                setRows(emptyRows());
                setSavedEyes([]);
                setSaved(null);
                setError(null);
                onCleared?.({ scope: "section", result });
              }}
            />
          </div>
        </div>
        <div className="mt-5 overflow-hidden rounded border border-white/10">
          <div className="grid grid-cols-[72px_1fr_180px_180px] gap-0 bg-white/5 px-4 py-2 text-xs uppercase tracking-widest text-white/35">
            <div>Eye</div>
            <div>Value</div>
            <div>Chart</div>
            <div>Correction</div>
          </div>
          {(["OD", "OS"] as const).map((laterality) => (
            <div key={laterality} className="grid grid-cols-[72px_1fr_180px_180px] gap-3 border-t border-white/10 p-4">
              <div className="flex items-start gap-2 pt-3 text-sm font-semibold text-white">
                <span>{laterality}</span>
                {savedEyes.includes(laterality) && (
                  <RemoveValueButton label={`Visual acuity ${laterality}`} onRemove={() => removeEye(laterality)} />
                )}
              </div>
              {rows[laterality].chartType === "SNELLEN" ? (
                <VaValueSelect
                  value={rows[laterality].snellen}
                  onChange={(value) =>
                    setRows((current) => ({
                      ...current,
                      [laterality]: { ...current[laterality], snellen: value },
                    }))
                  }
                  ariaLabel={`${laterality} visual acuity`}
                />
              ) : (
                <input
                  value={rows[laterality].snellen}
                  onChange={(event) =>
                    setRows((current) => ({
                      ...current,
                      [laterality]: { ...current[laterality], snellen: event.target.value },
                    }))
                  }
                  aria-label={`${laterality} visual acuity`}
                  className="h-11 rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
                />
              )}
              <select
                value={rows[laterality].chartType}
                onChange={(event) =>
                  setRows((current) => ({
                    ...current,
                    [laterality]: {
                      ...current[laterality],
                      chartType: event.target.value as VaRowState["chartType"],
                      snellen: "",
                    },
                  }))
                }
                aria-label={`${laterality} visual acuity chart`}
                className="h-11 rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
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
                className="h-11 rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
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
    </SectionEditingProvider>
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
