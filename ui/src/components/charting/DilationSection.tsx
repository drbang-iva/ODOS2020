import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { OdosSelect } from "../inputs/OdosSelect";
import type { CustomFindingDefinition } from "./CustomFindingSection";
import type { SectionSaveStatus } from "./types";

interface AgentRow { agent: string; drops: string; eyes: "OD" | "OS" | "OU"; time: string }
interface History { notes: Array<{ recordedAt: string; text: string }>; administrations: Array<{ recordedAt: string; agent: string; drops?: number; eyes?: string; administeredBy?: string }> }

export function DilationSection({ definition, patientReference, encounterReference, onSaved }: {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
}) {
  const [agents, setAgents] = useState<AgentRow[]>(() => [emptyAgent()]);
  const [dfePerformed, setDfePerformed] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [reason, setReason] = useState("");
  const [risks, setRisks] = useState("");
  const [history, setHistory] = useState<History>({ notes: [], administrations: [] });
  const [historyVersion, setHistoryVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentOptions = definition.fields?.agent?.options?.filter((option) => option.active !== false) ?? [];

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
    fetch(`${clinicalGraphApiBase()}/clinical-graph/dilation/history?${query}`, { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as History & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `Dilation history failed: ${response.status}`);
        return body;
      })
      .then(setHistory)
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => controller.abort();
  }, [patientReference, encounterReference, historyVersion]);

  function updateAgent(index: number, update: Partial<AgentRow>) {
    setAgents((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...update } : row));
  }

  async function save() {
    const rows = declined ? [] : agents.filter((agent) => agent.agent);
    if (declined && (!reason.trim() || !risks.trim())) {
      setError("Declined dilation requires a reason and counseled-risks note.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/dilation`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          agents: rows.map((row) => ({ agent: row.agent, drops: Number(row.drops), eyes: row.eyes, time: timeIso(row.time) })),
          dfePerformed: declined ? false : dfePerformed,
          ...(declined ? { declined: { reason: reason.trim(), counseledRisksNote: risks.trim() } } : {}),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Dilation save failed: ${response.status}`);
      const status = { completed: true, summary: declined ? "Dilation declined and counseling recorded" : "Dilation recorded", savedAt: new Date().toISOString(), operator: "ODOS UI dilation" };
      onSaved(status);
      setHistoryVersion((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <div className="border-b border-[color:var(--odos-line)] pb-4">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Entrance Testing</div>
          <h2 className="mt-1 text-xl font-semibold text-[color:var(--odos-text)]">Dilation</h2>
          <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Medication administration, DFE status, and declined-dilation counseling.</p>
        </div>
        <label className="mt-5 flex items-center gap-3 text-sm font-semibold text-[color:var(--odos-text)]">
          <input type="checkbox" checked={declined} onChange={(event) => setDeclined(event.target.checked)} className="accent-brand" />
          Patient declined dilation
        </label>
        {declined ? (
          <div className="mt-4 grid gap-4 rounded border border-amber-300/25 bg-amber-300/[0.05] p-4">
            <label>
              <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--odos-muted)]">Reason</span>
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} className="w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-3 text-[color:var(--odos-text)] outline-none focus:border-brand" />
            </label>
            <label>
              <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--odos-muted)]">Counseled risks note</span>
              <textarea value={risks} onChange={(event) => setRisks(event.target.value)} rows={3} className="w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-3 text-[color:var(--odos-text)] outline-none focus:border-brand" />
            </label>
          </div>
        ) : (
          <>
            <div className="mt-5 space-y-3">
              {agents.map((row, index) => (
                <div key={index} className="grid gap-3 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-4 md:grid-cols-[2fr_100px_110px_150px_auto]">
                  <OdosSelect
                    ariaLabel={`Dilation agent ${index + 1}`}
                    value={row.agent}
                    options={[
                      { value: "", label: "Agent" },
                      ...agentOptions.map((option) => ({ value: option.code, label: option.display })),
                    ]}
                    onChange={(agent) => updateAgent(index, { agent })}
                  />
                  <input aria-label={`Drops ${index + 1}`} type="number" min="1" max="10" value={row.drops} placeholder="Drops" onChange={(event) => updateAgent(index, { drops: event.target.value })} className="h-10 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-[color:var(--odos-text)]" />
                  <OdosSelect
                    ariaLabel={`Eyes ${index + 1}`}
                    value={row.eyes}
                    options={[
                      { value: "OU", label: "OU" },
                      { value: "OD", label: "OD" },
                      { value: "OS", label: "OS" },
                    ]}
                    onChange={(eyes) => updateAgent(index, { eyes: eyes as AgentRow["eyes"] })}
                  />
                  <input aria-label={`Administration time ${index + 1}`} type="time" value={row.time} onChange={(event) => updateAgent(index, { time: event.target.value })} className="h-10 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-[color:var(--odos-text)]" />
                  <button type="button" onClick={() => setAgents((current) => current.filter((_, rowIndex) => rowIndex !== index))} className="text-sm text-[color:var(--odos-muted)] hover:text-[color:var(--odos-text)]">Remove</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setAgents((current) => [...current, emptyAgent()])} className="mt-3 rounded border border-[color:var(--odos-line-2)] px-3 py-2 text-sm text-[color:var(--odos-muted)]">+ Add agent</button>
            <label className="mt-5 flex items-center gap-3 text-sm font-semibold text-[color:var(--odos-text)]">
              <input type="checkbox" checked={dfePerformed} onChange={(event) => setDfePerformed(event.target.checked)} className="accent-brand" />
              Dilated fundus examination performed
            </label>
          </>
        )}
        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="text-sm text-rose-200">{error}</div>
          <button type="button" onClick={save} disabled={saving} className="rounded bg-brand px-5 py-2 text-sm font-semibold text-[color:var(--odos-text)] disabled:opacity-45">{saving ? "Saving…" : "Save Dilation"}</button>
        </div>
        <div className="mt-8 overflow-hidden rounded border border-[color:var(--odos-line)] bg-bg-panel/55">
          <div className="border-b border-[color:var(--odos-line)] px-4 py-3 text-sm font-semibold text-[color:var(--odos-text)]">Chart note history</div>
          {history.notes.length === 0 && history.administrations.length === 0 ? (
            <div className="p-6 text-sm text-[color:var(--odos-muted)]">No prior entries</div>
          ) : (
            <div className="divide-y divide-white/10">
              {history.notes.map((note, index) => <div key={`${note.recordedAt}-${index}`} className="px-4 py-3 text-sm text-[color:var(--odos-muted)]">{note.text}</div>)}
              {history.administrations.map((row, index) => <div key={`${row.recordedAt}-${row.agent}-${index}`} className="px-4 py-3 text-sm text-[color:var(--odos-muted)]">{row.agent}: {row.drops} {row.drops === 1 ? "drop" : "drops"} {row.eyes} · administered by {row.administeredBy}</div>)}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function emptyAgent(): AgentRow {
  return { agent: "", drops: "1", eyes: "OU", time: new Date().toTimeString().slice(0, 5) };
}

function timeIso(time: string): string {
  if (!/^\d{2}:\d{2}$/.test(time)) return "";
  const date = new Date();
  const [hours, minutes] = time.split(":").map(Number);
  date.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  return date.toISOString();
}
