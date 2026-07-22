import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { PowerDropdown } from "./PowerDropdown";
import type { SectionSaveStatus } from "./types";

type Slot = "distance-cc" | "distance-sc" | "near-cc" | "near-sc";

interface Row {
  slot: Slot;
  state: "" | "ortho" | "deviation";
  deviationType: string;
  direction: string;
  magnitude: string;
  laterality: string;
  comitancy: string;
  note: string;
}

interface HistoryRow {
  recordedAt: string;
  summary: string;
}

const SLOTS: Array<{ slot: Slot; label: string }> = [
  { slot: "distance-cc", label: "Distance cc" },
  { slot: "distance-sc", label: "Distance sc" },
  { slot: "near-cc", label: "Near cc" },
  { slot: "near-sc", label: "Near sc" },
];
export const COVER_MAGNITUDES = Array.from({ length: 61 }, (_, value) => String(value));

export function CoverTestSection({ patientReference, encounterReference, onSaved }: {
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
}) {
  const [rows, setRows] = useState<Row[]>(() => SLOTS.map(({ slot }) => emptyRow(slot)));
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
    fetch(`${clinicalGraphApiBase()}/clinical-graph/cover-test/history?${query}`, { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { rows?: HistoryRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `Cover-test history failed: ${response.status}`);
        return body.rows ?? [];
      })
      .then(setHistory)
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => controller.abort();
  }, [encounterReference, patientReference, version]);

  function update(slot: Slot, patch: Partial<Row>) {
    setRows((current) => current.map((row) => row.slot === slot ? { ...row, ...patch } : row));
  }

  async function save() {
    const populated = rows.filter((row) => row.state);
    if (!populated.length) {
      setError("Select ortho or deviation for at least one row.");
      return;
    }
    const incomplete = populated.find((row) => row.state === "deviation" && row.magnitude === "");
    if (incomplete) {
      setError(`Choose a 0–60Δ magnitude for ${SLOTS.find((entry) => entry.slot === incomplete.slot)?.label}.`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/cover-test`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          rows: populated.map((row) => row.state === "ortho"
            ? { slot: row.slot, state: "ortho", ...(row.note.trim() ? { note: row.note.trim() } : {}) }
            : {
                slot: row.slot,
                state: "deviation",
                deviationType: row.deviationType,
                direction: row.direction,
                magnitude: Number(row.magnitude),
                laterality: row.laterality,
                comitancy: row.comitancy,
                ...(row.note.trim() ? { note: row.note.trim() } : {}),
              }),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Cover test save failed: ${response.status}`);
      onSaved({ completed: true, summary: `Cover test saved for ${populated.length} row${populated.length === 1 ? "" : "s"}`, savedAt: new Date().toISOString(), operator: "ODOS UI cover test" });
      setVersion((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <header className="border-b border-[color:var(--odos-line)] pb-4">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Entrance Testing</div>
          <h2 className="mt-1 text-xl font-semibold">Cover test</h2>
          <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Record distance and near alignment with and without correction.</p>
        </header>
        <div className="mt-5 space-y-3">
          {rows.map((row) => (
            <div key={row.slot} className="rounded border border-[color:var(--odos-line)] bg-bg-panel/65 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="w-28 font-semibold">{SLOTS.find((candidate) => candidate.slot === row.slot)?.label}</h3>
                <button type="button" onClick={() => update(row.slot, { state: "ortho" })} className={row.state === "ortho" ? "rounded border border-brand bg-brand/20 px-3 py-1.5" : "rounded border border-[color:var(--odos-line-2)] px-3 py-1.5 text-[color:var(--odos-muted)]"}>Ortho</button>
                <button type="button" onClick={() => update(row.slot, { state: "deviation" })} className={row.state === "deviation" ? "rounded border border-brand bg-brand/20 px-3 py-1.5" : "rounded border border-[color:var(--odos-line-2)] px-3 py-1.5 text-[color:var(--odos-muted)]"}>Deviation</button>
              </div>
              {row.state === "deviation" && (
                <div className="mt-3 grid gap-3 md:grid-cols-5">
                  <RowSelect label="Type" value={row.deviationType} values={["phoria", "tropia"]} onChange={(value) => update(row.slot, { deviationType: value })} />
                  <RowSelect label="Direction" value={row.direction} values={["eso", "exo", "hyper", "hypo"]} onChange={(value) => update(row.slot, { direction: value })} />
                  <label className="text-xs text-[color:var(--odos-muted)]">
                    Magnitude
                    <div className="mt-1"><PowerDropdown value={row.magnitude} options={COVER_MAGNITUDES} defaultValue="0" onChange={(magnitude) => update(row.slot, { magnitude })} ariaLabel={`${row.slot} magnitude`} formatOption={(value) => `${value} Δ`} /></div>
                  </label>
                  <RowSelect label="Laterality" value={row.laterality} values={["OD", "OS", "OU", "alternating"]} onChange={(value) => update(row.slot, { laterality: value })} />
                  <RowSelect label="Comitancy" value={row.comitancy} values={["comitant", "incomitant"]} onChange={(value) => update(row.slot, { comitancy: value })} />
                </div>
              )}
              <label className="mt-3 block text-xs text-[color:var(--odos-muted)]">
                Free-text note
                <input value={row.note} onChange={(event) => update(row.slot, { note: event.target.value })} className="mt-1 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-2" />
              </label>
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="text-sm text-rose-200">{error}</span>
          <button type="button" onClick={() => void save()} disabled={saving} className="rounded bg-brand px-5 py-2 text-sm font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save Cover Test"}</button>
        </div>
        <div className="mt-8 overflow-hidden rounded border border-[color:var(--odos-line)]">
          <div className="border-b border-[color:var(--odos-line)] px-4 py-3 font-semibold">History</div>
          {history.length ? history.map((row, index) => <div key={`${row.recordedAt}-${index}`} className="border-b border-[color:var(--odos-line)] px-4 py-3 text-sm text-[color:var(--odos-muted)]">{row.summary}</div>) : <div className="p-5 text-sm text-[color:var(--odos-muted)]">No prior entries</div>}
        </div>
      </div>
    </section>
  );
}

function RowSelect({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange(value: string): void }) {
  return (
    <label className="text-xs text-[color:var(--odos-muted)]">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-2">
        {values.map((option) => <option key={option}>{option}</option>)}
      </select>
    </label>
  );
}

function emptyRow(slot: Slot): Row {
  return { slot, state: "", deviationType: "phoria", direction: "eso", magnitude: "", laterality: "alternating", comitancy: "comitant", note: "" };
}
