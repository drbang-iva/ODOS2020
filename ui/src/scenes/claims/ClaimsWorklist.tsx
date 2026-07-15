import clsx from "clsx";
import { useCallback, useEffect, useState } from "react";
import { fhir } from "../../lib/fhir";
import { downloadCsvExport, queryPath } from "../../lib/reporting";
import {
  WORKLIST_LANES,
  claimWorklistItem,
  dispositionsForLane,
  fetchClaimsWorklist,
  groupWorklistItems,
  resolveWorklistItem,
  type ClaimsApiOptions,
  type ClaimsWorklistItem,
  type ResolveWorklistInput,
  type WorklistFilterStatus,
  type WorklistDisposition,
} from "../../lib/claims-worklist";

const LANE_COLOR = {
  "era-denial": "#f87171",
  "era-line-linkage": "#60a5fa",
  "era-underpayment": "#fbbf24",
  "era-unmatched": "#c084fc",
  "claim-rejected": "#fb7185",
} as const;

export function ClaimsWorklist() {
  const [items, setItems] = useState<ClaimsWorklistItem[]>([]);
  const [status, setStatus] = useState<WorklistFilterStatus | undefined>(() => worklistStatusFromQuery(window.location.search));
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const api = claimsApiOptions();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setItems(await fetchClaimsWorklist(status, api));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [status, api.authorization, api.baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = items.find((item) => item.id === selectedId);
  const runAction = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportRows = async () => {
    setExporting(true);
    setError(undefined);
    try {
      await downloadCsvExport(
        queryPath("/claims/worklist/export", { status }),
        "claims-worklist.csv",
        api,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Claims management</p>
          <h1 className="text-2xl font-semibold">Claims worklist</h1>
          <p className="mt-1 text-sm text-white/50">Oldest and most urgent items appear first.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1 text-xs">
            <FilterButton active={status === undefined} label="All" onClick={() => setStatus(undefined)} />
            <FilterButton active={status === "open"} label="Open" onClick={() => setStatus("open")} />
            <FilterButton active={status === "new"} label="New" onClick={() => setStatus("new")} />
            <FilterButton active={status === "in-review"} label="In review" onClick={() => setStatus("in-review")} />
            <FilterButton active={status === "resolved"} label="Resolved" onClick={() => setStatus("resolved")} />
          </div>
          <button type="button" disabled={exporting || loading} onClick={() => void exportRows()} className="rounded border border-blue-400/30 bg-blue-950/30 px-3 py-2 text-xs font-bold text-blue-200 disabled:opacity-50">
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {loading ? (
        <div className="grid min-h-52 place-items-center text-sm text-white/50">Loading claims worklist…</div>
      ) : (
        <ClaimsWorklistBoard items={items} onSelect={(item) => setSelectedId(item.id)} />
      )}

      {selected && (
        <ClaimsWorklistPanel
          key={selected.id}
          item={selected}
          onClose={() => setSelectedId(undefined)}
          onClaim={() => runAction(() => claimWorklistItem(selected.id, api))}
          onResolve={(input) => runAction(() => resolveWorklistItem(selected.id, input, api))}
        />
      )}
    </main>
  );
}

export function ClaimsWorklistBoard({
  items,
  onSelect,
}: {
  items: readonly ClaimsWorklistItem[];
  onSelect: (item: ClaimsWorklistItem) => void;
}) {
  const grouped = groupWorklistItems(items);
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {WORKLIST_LANES.map((lane) => (
        <section key={lane.code} aria-label={lane.label} className="min-h-56 rounded-lg border border-white/10 bg-bg-panel/80 p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-white/80">{lane.label}</h2>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-bold text-white/60">{grouped[lane.code].length}</span>
          </div>
          <div className="space-y-2">
            {grouped[lane.code].map((item) => (
              <WorklistCard key={item.id} item={item} onClick={() => onSelect(item)} />
            ))}
            {grouped[lane.code].length === 0 && (
              <div className="rounded-md border border-dashed border-white/10 px-3 py-8 text-center text-xs text-white/35">
                No items in this lane
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function WorklistCard({ item, onClick }: { item: ClaimsWorklistItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md border-l-4 border-white/10 bg-white/5 px-3 py-2 text-left text-xs hover:bg-white/10"
      style={{ borderLeftColor: LANE_COLOR[item.code] }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold text-white">{item.title}</span>
        <span className={clsx(
          "shrink-0 rounded-full bg-black/30 px-2 py-0.5 font-bold",
          item.severity === "high" ? "text-red-300" : "text-amber-300",
        )}>
          {ageLabel(item.ageTimer.elapsedMinutes)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-white/40">
        <span className="rounded-sm bg-white/10 px-1 py-0.5 text-[9px] font-bold uppercase text-white/75">{item.status}</span>
        <span className="truncate">{item.patientReference ?? "Patient not matched"}</span>
        {item.owner && <span className="ml-auto shrink-0">{item.owner}</span>}
      </div>
    </button>
  );
}

export function ClaimsWorklistPanel({
  item,
  onClose,
  onClaim,
  onResolve,
}: {
  item: ClaimsWorklistItem;
  onClose: () => void;
  onClaim: () => Promise<void>;
  onResolve: (input: ResolveWorklistInput) => Promise<void>;
}) {
  const [disposition, setDisposition] = useState<WorklistDisposition>(dispositionsForLane(item.code)[0]);
  const [claimReference, setClaimReference] = useState(item.focusReference?.startsWith("Claim/") ? item.focusReference : "");
  const [patientReference, setPatientReference] = useState(item.patientReference ?? "");
  const [insurerReference, setInsurerReference] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const resolve = () => act(() => onResolve({
    disposition,
    ...((disposition === "rebilled" || disposition === "matched") && claimReference ? { claimReference } : {}),
    ...(disposition === "matched" && patientReference ? { patientReference } : {}),
    ...(disposition === "matched" && insurerReference ? { insurerReference } : {}),
  }));

  return (
    <aside
      role="dialog"
      aria-label={item.title}
      className="fixed inset-y-0 right-12 z-40 flex w-[320px] flex-col border-l border-white/15 bg-[#0c0c18] shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm font-bold text-white">{item.title}</span>
        <button type="button" aria-label="Close panel" onClick={onClose} className="text-white/60 hover:text-white">✕</button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-sm text-white/65">
        <DetailRow label="Task" value={item.taskReference} />
        <DetailRow label="Patient" value={item.patientReference ?? "Not matched"} />
        <DetailRow label="Status" value={item.status} />
        <DetailRow label="Owner" value={item.owner ?? "Unclaimed"} />
        <Evidence item={item} />

        {item.action === "claim" && (
          <button type="button" disabled={busy} onClick={() => void act(onClaim)} className="w-full rounded bg-blue-600 px-3 py-2 font-bold text-white disabled:opacity-50">
            Claim item
          </button>
        )}

        {item.action === "resolve" && (
          <div className="space-y-3 border-t border-white/10 pt-4">
            <label className="block text-xs font-bold text-white/70">
              Resolution
              <select value={disposition} onChange={(event) => setDisposition(event.target.value as WorklistDisposition)} className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-2 text-sm text-white">
                {dispositionsForLane(item.code).map((value) => <option key={value} value={value}>{dispositionLabel(value)}</option>)}
              </select>
            </label>
            {(disposition === "rebilled" || disposition === "matched") && (
              <ReferenceInput label="Claim reference" value={claimReference} onChange={setClaimReference} placeholder="Claim/123" />
            )}
            {disposition === "rebilled" && (
              <p className="text-xs leading-relaxed text-white/45">Submit the corrected claim first, then paste its reference.</p>
            )}
            {disposition === "matched" && (
              <>
                <ReferenceInput label="Patient reference" value={patientReference} onChange={setPatientReference} placeholder="Patient/123" />
                <ReferenceInput label="Insurer reference" value={insurerReference} onChange={setInsurerReference} placeholder="Organization/123" />
              </>
            )}
            <button type="button" disabled={busy} onClick={() => void resolve()} className="w-full rounded bg-emerald-700 px-3 py-2 font-bold text-white disabled:opacity-50">
              Resolve item
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function Evidence({ item }: { item: ClaimsWorklistItem }) {
  if (item.evidence.kind === "claim-rejected") {
    return (
      <section>
        <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-white/45">Clearinghouse message</h3>
        <pre className="whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-white/75">{item.evidence.claimMdMessage || "No message supplied"}</pre>
      </section>
    );
  }
  const evidence = item.evidence;
  return (
    <section className="space-y-1 border-t border-white/10 pt-3">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/45">ERA evidence</h3>
      <DetailRow label="ERA" value={evidence.eraId} />
      <DetailRow label="PCN" value={evidence.pcn} />
      <DetailRow label="Payer ICN" value={evidence.payerIcn ?? "—"} />
      <DetailRow label="Charged" value={money(evidence.chargedCents)} />
      <DetailRow label="Allowed" value={money(evidence.allowedCents)} />
      <DetailRow label="Paid" value={money(evidence.paidCents)} />
      <DetailRow label="Patient responsibility" value={money(evidence.patientResponsibilityCents)} />
      <DetailRow label="Shortfall" value={money(evidence.shortfallCents)} />
      <div className="pt-1 text-xs text-white/50">
        Adjustments: {evidence.adjustments.length === 0 ? "None" : evidence.adjustments.map((value) => `${value.group ?? "?"}-${value.code ?? "?"}`).join(", ")}
      </div>
    </section>
  );
}

function FilterButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={clsx("rounded px-2.5 py-1.5", active ? "bg-white/15 text-white" : "text-white/45 hover:text-white")}>{label}</button>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 text-xs"><span className="text-white/40">{label}</span><span className="break-all text-right text-white/75">{value}</span></div>;
}

function ReferenceInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="block text-xs font-bold text-white/70">
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-2 text-sm text-white" />
    </label>
  );
}

function dispositionLabel(value: WorklistDisposition): string {
  return value.replace("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function claimsApiOptions(): ClaimsApiOptions {
  const meta = import.meta as ImportMeta & { env?: { VITE_OSOD_MCP_BASE_URL?: string } };
  return {
    authorization: fhir.authHeader(),
    baseUrl: meta.env?.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "",
  };
}

function worklistStatusFromQuery(search: string): WorklistFilterStatus | undefined {
  const status = new URLSearchParams(search).get("status");
  return status === "open" || status === "new" || status === "in-review" || status === "resolved"
    ? status
    : undefined;
}
