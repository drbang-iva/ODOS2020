import { useCallback, useEffect, useState } from "react";
import { fhir } from "../../lib/fhir";
import {
  ERA_BATCH_LANES,
  fetchClaimsWorklist,
  fetchEraBatches,
  worklistItemsForEra,
  type ClaimsApiOptions,
  type ClaimsWorklistItem,
  type EraBatchItem,
  type EraBatchLane,
} from "../../lib/claims-worklist";
import { EraWorklistBoard } from "./ClaimsWorklist";
import { downloadCsvExport, queryPath } from "../../lib/reporting";

export function RemittanceQueue() {
  const [batches, setBatches] = useState<EraBatchItem[]>([]);
  const [worklistItems, setWorklistItems] = useState<ClaimsWorklistItem[]>([]);
  const [lane, setLane] = useState<EraBatchLane>("new");
  const [selectedEraId, setSelectedEraId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const api = claimsApiOptions();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextBatches, nextWorklistItems] = await Promise.all([
        fetchEraBatches(api),
        fetchClaimsWorklist(undefined, api),
      ]);
      setBatches(nextBatches);
      setWorklistItems(nextWorklistItems);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api.authorization, api.baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportRows = async () => {
    setExporting(true);
    setError(undefined);
    try {
      await downloadCsvExport(
        queryPath("/claims/era/export", { lane }),
        "remittance-queue.csv",
        api,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };

  const selected = batches.find((batch) => batch.eraId === selectedEraId);
  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Claims management</p>
          <h1 className="text-2xl font-semibold">Remittance queue</h1>
          <p className="mt-1 text-sm text-white/50">Clearinghouse ERA batches, composed with import and worklist state.</p>
        </div>
        <button type="button" disabled={exporting || loading} onClick={() => void exportRows()} className="rounded border border-blue-400/30 bg-blue-950/30 px-3 py-2 text-xs font-bold text-blue-200 disabled:opacity-50">
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </header>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {loading ? (
        <div className="grid min-h-52 place-items-center text-sm text-white/50">Loading remittances…</div>
      ) : (
        <RemittanceQueueBoard
          batches={batches}
          activeLane={lane}
          onLaneChange={setLane}
          onSelect={(batch) => setSelectedEraId(batch.eraId)}
        />
      )}

      {selected && (
        <RemittanceQueuePanel
          batch={selected}
          worklistItems={worklistItems}
          onClose={() => setSelectedEraId(undefined)}
        />
      )}
    </main>
  );
}

export function RemittanceQueueBoard({
  batches,
  activeLane,
  onLaneChange,
  onSelect,
}: {
  batches: readonly EraBatchItem[];
  activeLane: EraBatchLane;
  onLaneChange: (lane: EraBatchLane) => void;
  onSelect: (batch: EraBatchItem) => void;
}) {
  const visible = batches.filter((batch) => batch.lane === activeLane);
  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-bg-panel/80">
      <nav aria-label="Remittance lanes" className="flex gap-1 border-b border-white/10 p-2">
        {ERA_BATCH_LANES.map((lane) => {
          const count = batches.filter((batch) => batch.lane === lane.code).length;
          return (
            <button
              key={lane.code}
              type="button"
              aria-pressed={activeLane === lane.code}
              onClick={() => onLaneChange(lane.code)}
              className={activeLane === lane.code
                ? "rounded bg-white/15 px-3 py-2 text-sm font-bold text-white"
                : "rounded px-3 py-2 text-sm font-bold text-white/45 hover:text-white"}
            >
              {lane.label} <span className="ml-1 text-xs">{count}</span>
            </button>
          );
        })}
      </nav>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-black/20 text-xs uppercase tracking-wide text-white/40">
            <tr>
              <th className="px-4 py-3">ERA id</th>
              <th className="px-4 py-3">Payer</th>
              <th className="px-4 py-3">Paid date</th>
              <th className="px-4 py-3 text-right">Claims</th>
              <th className="px-4 py-3 text-right">Paid total</th>
              <th className="px-4 py-3 text-right">Posted / flagged</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {visible.map((batch) => (
              <tr key={batch.eraId} className="text-white/70 hover:bg-white/5">
                <td className="px-4 py-3">
                  <button type="button" onClick={() => onSelect(batch)} className="font-semibold text-blue-300 hover:text-blue-200">
                    {batch.eraId}
                  </button>
                </td>
                <td className="px-4 py-3">{batch.payerName ?? "—"}</td>
                <td className="px-4 py-3">{batch.paidDate ?? "—"}</td>
                <td className="px-4 py-3 text-right">{batch.claimCount ?? "—"}</td>
                <td className="px-4 py-3 text-right">{money(batch.paidTotalCents)}</td>
                <td className="px-4 py-3 text-right text-xs">
                  {batch.posted} posted · {batch.denied} denied · {batch.underpaid} underpaid · {batch.flagged} unmatched
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-white/35">No ERA batches in this lane</div>
        )}
      </div>
    </section>
  );
}

export function RemittanceQueuePanel({
  batch,
  worklistItems,
  onClose,
}: {
  batch: EraBatchItem;
  worklistItems: readonly ClaimsWorklistItem[];
  onClose: () => void;
}) {
  const items = worklistItemsForEra(worklistItems, batch.eraId);
  return (
    <aside
      role="dialog"
      aria-label={`ERA ${batch.eraId}`}
      className="fixed inset-y-0 right-12 z-40 flex w-[min(900px,calc(100vw-3rem))] flex-col border-l border-white/15 bg-[#0c0c18] shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-white/40">{batch.lane.replace("-", " ")}</p>
          <h2 className="font-bold text-white">ERA {batch.eraId}</h2>
        </div>
        <button type="button" aria-label="Close panel" onClick={onClose} className="text-white/60 hover:text-white">✕</button>
      </header>
      <div className="grid grid-cols-2 gap-3 border-b border-white/10 px-4 py-3 text-xs text-white/60 md:grid-cols-4">
        <Detail label="Payer" value={batch.payerName ?? "—"} />
        <Detail label="Paid date" value={batch.paidDate ?? "—"} />
        <Detail label="Paid total" value={money(batch.paidTotalCents)} />
        <Detail label="Open tasks" value={String(batch.openTaskCount)} />
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <EraWorklistBoard
          items={items}
          onSelect={() => window.location.assign("/billing/claims/worklist")}
        />
      </div>
    </aside>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><div className="text-white/35">{label}</div><div className="mt-1 break-all font-semibold text-white/75">{value}</div></div>;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function claimsApiOptions(): ClaimsApiOptions {
  const meta = import.meta as ImportMeta & { env?: { VITE_ODOS_MCP_BASE_URL?: string } };
  return {
    authorization: fhir.authHeader(),
    baseUrl: meta.env?.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "",
  };
}
