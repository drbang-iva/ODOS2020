import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
type Quadrant = "superior" | "nasal" | "inferior" | "temporal";
type Structure = "closed" | "sl" | "atm" | "ptm" | "ss" | "cb";
type EntryMode = "propagated-uniform" | "quadrant-specific";
interface RecordRow {
  eye: Eye;
  quadrant: Quadrant;
  value: Structure;
  entryMode: EntryMode;
  source?: "protocol-default" | "clinician-entered";
}
interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
}

const EYES: Eye[] = ["OD", "OS"];
const QUADRANTS: Quadrant[] = ["superior", "nasal", "inferior", "temporal"];
const OPTIONS: Structure[] = ["closed", "sl", "atm", "ptm", "ss", "cb"];
const PIGMENT = ["0", "1+", "2+", "3+", "4+"];

export function GonioscopySection({ patientReference, encounterReference, onSaved }: Props) {
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [dirtyRecords, setDirtyRecords] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<Eye, boolean>>({ OD: false, OS: false });
  const [pigmentation, setPigmentation] = useState<Partial<Record<Eye, string>>>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setRecords([]);
    setPigmentation({});
    setNote("");
    setDirtyRecords(new Set());
    setError(undefined);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/gonioscopy?encounterReference=${encodeURIComponent(encounterReference)}`, {
      headers: authHeaders(), signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as {
        records?: RecordRow[];
        pigmentation?: Partial<Record<Eye, string>>;
        note?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `Gonioscopy load failed: ${response.status}`);
      if (controller.signal.aborted) return;
      setRecords(body.records ?? []);
      setPigmentation(body.pigmentation ?? {});
      setNote(body.note ?? "");
      setDirtyRecords(new Set());
    }).catch((reason) => {
      if ((reason as Error).name !== "AbortError") setError(String((reason as Error).message ?? reason));
    });
    return () => controller.abort();
  }, [encounterReference]);

  function setAll(eye: Eye, value: Structure) {
    setRecords((current) => [
      ...current.filter((row) => row.eye !== eye),
      ...QUADRANTS.map((quadrant) => ({ eye, quadrant, value, entryMode: "propagated-uniform" as const, source: "clinician-entered" as const })),
    ]);
    setDirtyRecords((current) => new Set([...current, ...QUADRANTS.map((quadrant) => `${eye}:${quadrant}`)]));
  }

  function setQuadrant(eye: Eye, quadrant: Quadrant, value: Structure) {
    setRecords((current) => [
      ...current.filter((row) => !(row.eye === eye && row.quadrant === quadrant)),
      { eye, quadrant, value, entryMode: "quadrant-specific", source: "clinician-entered" },
    ]);
    setDirtyRecords((current) => new Set(current).add(`${eye}:${quadrant}`));
  }

  async function save() {
    if (!records.length && !Object.keys(pigmentation).length && !note.trim()) {
      setError("Document at least one gonioscopy value before saving.");
      return;
    }
    setSaving(true); setError(undefined);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/gonioscopy`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          records: records.filter((row) => dirtyRecords.has(`${row.eye}:${row.quadrant}`)),
          pigmentation,
          note,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Gonioscopy save failed: ${response.status}`);
      const status = {
        completed: EYES.every((eye) => QUADRANTS.every((quadrant) =>
          records.some((row) => row.eye === eye && row.quadrant === quadrant))),
        summary: `${records.length}/8 angle quadrants`,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI save_gonioscopy",
      };
      onSaved(status);
      setDirtyRecords(new Set());
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally { setSaving(false); }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <h2 className="text-lg font-semibold text-[color:var(--odos-text)]">Gonioscopy</h2>
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {EYES.map((eye) => {
            const eyeRecords = QUADRANTS.map((quadrant) => records.find((row) => row.eye === eye && row.quadrant === quadrant));
            const uniform = eyeRecords.every(Boolean) && eyeRecords.every((row) => row?.value === eyeRecords[0]?.value)
              ? eyeRecords[0]?.value : "";
            return (
              <div key={eye} className="rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4">
                <div className="text-sm font-semibold text-[color:var(--odos-text)]">{eye}</div>
                <label className="mt-4 block text-xs uppercase tracking-widest text-[color:var(--odos-faint)]">
                  All quadrants
                  <select aria-label={`${eye} all quadrants`} value={uniform}
                    onChange={(event) => event.target.value && setAll(eye, event.target.value as Structure)}
                    className="mt-1 h-11 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-3 text-[color:var(--odos-text)]">
                    <option value="">{eyeRecords.some(Boolean) ? "Mixed" : "Select"}</option>
                    {OPTIONS.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
                  </select>
                </label>
                <button type="button" aria-expanded={expanded[eye]}
                  onClick={() => setExpanded((current) => ({ ...current, [eye]: !current[eye] }))}
                  className="mt-3 rounded text-sm text-[color:var(--odos-accent-hi)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--odos-accent-border)]">
                  {expanded[eye] ? "⌄ Hide quadrants" : "› Show quadrants"}
                </button>
                {expanded[eye] && (
                  <div className="mt-3 space-y-2">
                    {QUADRANTS.map((quadrant) => {
                      const row = records.find((candidate) => candidate.eye === eye && candidate.quadrant === quadrant);
                      return (
                        <label key={quadrant} className={[
                          "grid grid-cols-2 items-center rounded border px-3 py-2 text-sm",
                          row?.entryMode === "quadrant-specific" ? "border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-hi)]" : "border-[color:var(--odos-line)]",
                        ].join(" ")}>
                          <span className="capitalize text-[color:var(--odos-muted)]">{quadrant}</span>
                          <select aria-label={`${eye} ${quadrant}`} value={row?.value ?? ""}
                            onChange={(event) => event.target.value && setQuadrant(eye, quadrant, event.target.value as Structure)}
                            className="h-9 rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-2 text-[color:var(--odos-text)]">
                            <option value="">Select</option>
                            {OPTIONS.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                )}
                <label className="mt-4 block text-xs uppercase tracking-widest text-[color:var(--odos-faint)]">
                  TM pigmentation
                  <select aria-label={`${eye} TM pigmentation`} value={pigmentation[eye] ?? ""} onChange={(event) => setPigmentation((current) => ({ ...current, [eye]: event.target.value }))}
                    className="mt-1 h-11 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-3 text-[color:var(--odos-text)]">
                    <option value="">Select</option>
                    {PIGMENT.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              </div>
            );
          })}
        </div>
        <label className="mt-4 block text-xs uppercase tracking-widest text-[color:var(--odos-faint)]">
          Note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3}
            className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] p-3 text-[color:var(--odos-text)]" />
        </label>
        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="text-sm text-[color:var(--odos-alert)]">{error}</div>
          <button onClick={save} disabled={saving}
            className="rounded border border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-hi)] px-4 py-2 text-sm font-semibold text-[color:var(--odos-text)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--odos-accent-border)] disabled:opacity-50">
            {saving ? "Saving..." : "Save Gonioscopy"}
          </button>
        </div>
      </div>
    </section>
  );
}
