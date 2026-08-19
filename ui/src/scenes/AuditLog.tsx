import { useEffect, useMemo, useState } from "react";
import { OdosChips } from "../components/inputs/OdosChips";
import {
  AUDIT_EVENT_TYPES,
  AuditLogRequestError,
  defaultAuditDateRange,
  exportAuditRowsAsCsv,
  exportAuditRowsAsJson,
  fetchAuditLogRows,
  type AuditEventType,
  type AuditLogRow,
  type AuditOutcome,
  type AuditReviewRole,
} from "../lib/audit-log";

export function AuditLog() {
  const dateRange = useMemo(() => defaultAuditDateRange(), []);
  const [role, setRole] = useState<AuditReviewRole>("unknown");
  const [patientId, setPatientId] = useState("");
  const [actorId, setActorId] = useState("");
  const [from, setFrom] = useState(dateRange.from);
  const [to, setTo] = useState(dateRange.to);
  const [outcome, setOutcome] = useState<AuditOutcome | "">("");
  const [eventTypes, setEventTypes] = useState<AuditEventType[]>([]);
  const [breakGlassOnly, setBreakGlassOnly] = useState(false);
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | undefined>();
  const filters = useMemo(() => ({
    patientId: patientId || undefined,
    actorId: actorId || undefined,
    from: `${from}T00:00:00.000Z`,
    to: `${to}T23:59:59.999Z`,
    eventTypes,
    outcome: outcome || undefined,
    breakGlassOnly,
  }), [actorId, breakGlassOnly, eventTypes, from, outcome, patientId, to]);

  useEffect(() => {
    let cancelled = false;
    fetchAuditLogRows(filters)
      .then((response) => {
        if (!cancelled) {
          setRole(response.actorRole);
          setRows(response.rows);
          setError(undefined);
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          if (nextError instanceof AuditLogRequestError) setRole(nextError.actorRole);
          setRows([]);
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  return (
    <div className="min-h-screen bg-bg-deep text-white">
      <header className="border-b border-white/10 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Audit Log</h1>
            <p className="text-sm text-white/55">Role: {role}</p>
          </div>
          <div className="flex gap-2">
            <button className="rounded border border-white/20 px-3 py-2 text-sm" onClick={() => download("audit-log.csv", exportAuditRowsAsCsv(rows), "text/csv")}>
              CSV
            </button>
            <button className="rounded border border-white/20 px-3 py-2 text-sm" onClick={() => download("audit-log.json", exportAuditRowsAsJson(rows), "application/json")}>
              JSON
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-5 px-6 py-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-4 border border-white/10 bg-black/20 p-4">
          <label className="block text-sm text-white/70">
            Patient
            <input className="mt-1 w-full rounded border border-white/15 bg-bg-panel px-3 py-2 text-white" value={patientId} onChange={(event) => setPatientId(event.target.value)} />
          </label>
          <label className="block text-sm text-white/70">
            Actor
            <input className="mt-1 w-full rounded border border-white/15 bg-bg-panel px-3 py-2 text-white" value={actorId} onChange={(event) => setActorId(event.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm text-white/70">
              From
              <input className="mt-1 w-full rounded border border-white/15 bg-bg-panel px-3 py-2 text-white" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label className="block text-sm text-white/70">
              To
              <input className="mt-1 w-full rounded border border-white/15 bg-bg-panel px-3 py-2 text-white" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </div>
          <div className="block text-sm text-white/70">
            <div className="mb-1">Event Type</div>
            <OdosChips
              options={AUDIT_EVENT_TYPES.map((eventType) => ({ value: eventType, label: eventType }))}
              selected={eventTypes}
              onChange={setEventTypes}
              ariaLabel="Audit event types"
            />
          </div>
          <label className="block text-sm text-white/70">
            Outcome
            <select className="mt-1 w-full rounded border border-white/15 bg-bg-panel px-3 py-2 text-white" value={outcome} onChange={(event) => setOutcome(event.target.value as AuditOutcome | "")}>
              <option value="">All</option>
              <option value="granted">Granted</option>
              <option value="denied">Denied</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-white/70">
            <input type="checkbox" checked={breakGlassOnly} onChange={(event) => setBreakGlassOnly(event.target.checked)} />
            Break-glass only
          </label>
        </aside>

        <section className="overflow-hidden border border-white/10 bg-black/20">
          {error ? <div className="border-b border-red-500/30 bg-red-950/20 px-4 py-3 text-sm text-red-100">{error}</div> : null}
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead className="bg-white/5 text-xs uppercase text-white/45">
              <tr>
                <th className="px-3 py-3">Time</th>
                <th className="px-3 py-3">Event</th>
                <th className="px-3 py-3">Actor</th>
                <th className="px-3 py-3">Role</th>
                <th className="px-3 py-3">Patient</th>
                <th className="px-3 py-3">Resource</th>
                <th className="px-3 py-3">Outcome</th>
                <th className="px-3 py-3">IB Exception</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-white/10">
                  <td className="px-3 py-3 text-white/75">{row.eventTime}</td>
                  <td className="px-3 py-3">{row.eventType}</td>
                  <td className="px-3 py-3">{row.actorId}</td>
                  <td className="px-3 py-3">{row.actorRole}</td>
                  <td className="px-3 py-3">{row.patientId}</td>
                  <td className="px-3 py-3">{[row.resourceType, row.resourceId].filter(Boolean).join("/")}</td>
                  <td className="px-3 py-3">{row.actionOutcome}</td>
                  <td className="px-3 py-3">{row.ibException ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}

function download(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
