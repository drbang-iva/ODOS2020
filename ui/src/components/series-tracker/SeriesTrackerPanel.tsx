import { useEffect, useState } from "react";
import {
  fetchPatientSeries,
  fetchSeriesProtocols,
  formatSeriesDueWindow,
  prescribeSeriesProtocol,
  type SeriesProtocolDefinition,
  type SeriesTrackerView,
} from "../../lib/series-tracker";
import { OdosSelect } from "../inputs/OdosSelect";

export interface SeriesTrackerPanelApi {
  fetchSeries(patientReference: string): Promise<SeriesTrackerView[]>;
  fetchProtocols(): Promise<SeriesProtocolDefinition[]>;
  prescribe(patientReference: string, protocolId: string): Promise<SeriesTrackerView>;
}

const defaultApi: SeriesTrackerPanelApi = {
  fetchSeries: fetchPatientSeries,
  fetchProtocols: () => fetchSeriesProtocols(false),
  prescribe: prescribeSeriesProtocol,
};

export function SeriesTrackerPanel({
  patientReference,
  api = defaultApi,
  initialSeries,
  initialProtocols,
  compact = false,
}: {
  patientReference: string;
  api?: SeriesTrackerPanelApi;
  initialSeries?: SeriesTrackerView[];
  initialProtocols?: SeriesProtocolDefinition[];
  compact?: boolean;
}) {
  const [series, setSeries] = useState(initialSeries ?? []);
  const [protocols, setProtocols] = useState(initialProtocols ?? []);
  const [selectedProtocolId, setSelectedProtocolId] = useState(initialProtocols?.find((protocol) => protocol.active)?.id ?? "");
  const [loading, setLoading] = useState(initialSeries === undefined || initialProtocols === undefined);
  const [prescribing, setPrescribing] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (initialSeries !== undefined && initialProtocols !== undefined) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      initialSeries ?? api.fetchSeries(patientReference),
      initialProtocols ?? api.fetchProtocols(),
    ])
      .then(([loadedSeries, loadedProtocols]) => {
        if (cancelled) return;
        setSeries(loadedSeries);
        setProtocols(loadedProtocols);
        setSelectedProtocolId((current) => current || loadedProtocols.find((protocol) => protocol.active)?.id || "");
      })
      .catch((cause) => !cancelled && setError(messageOf(cause)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [api, initialProtocols, initialSeries, patientReference]);

  async function prescribe() {
    if (!selectedProtocolId) return;
    setPrescribing(true);
    setError(undefined);
    try {
      const created = await api.prescribe(patientReference, selectedProtocolId);
      setSeries((current) => [created, ...current]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPrescribing(false);
    }
  }

  return (
    <section className={`w-full rounded border border-violet-300/20 bg-violet-950/15 ${compact ? "p-3" : "p-4"}`} aria-label="Treatment series tracker">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-200/55">Series tracker</div>
          <h2 className="mt-1 text-sm font-semibold text-white">Longitudinal treatment protocols</h2>
        </div>
        {protocols.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <OdosSelect
              value={selectedProtocolId}
              options={protocols.filter((protocol) => protocol.active).map((protocol) => ({
                value: protocol.id,
                label: protocol.name,
              }))}
              onChange={setSelectedProtocolId}
              ariaLabel="Treatment protocol"
            />
            <button
              type="button"
              className="h-9 rounded border border-violet-300/40 bg-violet-300/10 px-3 text-xs font-semibold text-violet-100"
              disabled={prescribing || !selectedProtocolId}
              onClick={() => void prescribe()}
            >
              {prescribing ? "Prescribing…" : "Prescribe protocol"}
            </button>
          </div>
        )}
      </div>

      {loading && <p className={`${compact ? "mt-2" : "mt-3"} text-xs text-white/45`}>Loading treatment series…</p>}
      {error && <p className={`${compact ? "mt-2" : "mt-3"} text-xs text-red-200`}>Series tracker unavailable: {error}</p>}
      {!loading && series.length === 0 && <p className={`${compact ? "mt-2" : "mt-3"} text-xs text-white/45`}>No treatment series prescribed.</p>}
      <div className={`${compact ? "mt-2 gap-2" : "mt-3 gap-3"} grid`}>
        {series.map((item) => <SeriesTimeline key={item.carePlanReference} series={item} />)}
      </div>
    </section>
  );
}

export function SeriesTimeline({ series }: { series: SeriesTrackerView }) {
  return (
    <article className="rounded border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm text-white">{series.title}</strong>
        <span className="text-[11px] uppercase tracking-wide text-white/40">{series.status}</span>
      </div>
      <ol className="mt-3 flex min-w-0 items-start gap-2" aria-label={`${series.title} sessions`}>
        {series.sessions.map((session) => (
          <li key={session.number} className={`min-w-0 flex-1 ${session.status === "future" ? "opacity-35" : ""}`}>
            <div className={`h-1 rounded ${session.status === "completed" ? "bg-emerald-300" : session.status === "next" ? "bg-violet-300" : "bg-white/20"}`} />
            <div className="mt-2 text-xs font-semibold text-white/80">Session {session.number}</div>
            {session.actualDate && <div className="mt-1 text-[11px] text-emerald-200">Completed {shortDate(session.actualDate)}</div>}
            {session.dueWindow && <div className="mt-1 text-[11px] font-medium text-violet-100">{formatSeriesDueWindow(session.dueWindow)}</div>}
            {session.status === "next" && !session.dueWindow && <div className="mt-1 text-[11px] text-violet-100">Ready to schedule</div>}
            {session.status === "future" && <div className="mt-1 text-[11px] text-white/45">Future</div>}
          </li>
        ))}
      </ol>
      {series.maintenanceAfter && <p className="mt-3 text-[11px] text-white/45">Maintenance follows the initial series.</p>}
    </article>
  );
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date)
    : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
