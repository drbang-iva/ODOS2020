import { useMemo, useState } from "react";
import {
  AUDIT_EVENT_TYPES,
  canReviewAuditLog,
  defaultAuditDateRange,
  exportAuditRowsAsCsv,
  exportAuditRowsAsJson,
  filterAuditLogRows,
  sampleAuditRows,
  type AuditEventType,
  type AuditOutcome,
  type AuditReviewRole,
} from "../lib/audit-log";

export function AuditLog() {
  const role = auditRoleFromLocation();
  const dateRange = useMemo(() => defaultAuditDateRange(), []);
  const [patientId, setPatientId] = useState("patient-x");
  const [actorId, setActorId] = useState("");
  const [from, setFrom] = useState(dateRange.from);
  const [to, setTo] = useState(dateRange.to);
  const [outcome, setOutcome] = useState<AuditOutcome | "">("");
  const [eventTypes, setEventTypes] = useState<AuditEventType[]>([]);
  const [breakGlassOnly, setBreakGlassOnly] = useState(false);
  const rows = useMemo(() => sampleAuditRows(), []);
  const filteredRows = filterAuditLogRows(rows, {
    patientId: patientId || undefined,
    actorId: actorId || undefined,
    from: `${from}T00:00:00.000Z`,
    to: `${to}T23:59:59.999Z`,
    eventTypes,
    outcome: outcome || undefined,
    breakGlassOnly,
  });

  if (!canReviewAuditLog(role)) {
    return (
      <div className="min-h-screen bg-bg-deep p-8 text-white">
        <div className="mx-auto max-w-3xl border border-red-500/40 bg-red-950/20 p-6">
          <h1 className="text-lg font-semibold text-red-200">Audit log unavailable</h1>
          <p className="mt-2 text-sm text-red-100/80">Current role: {role}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-deep text-white">
      <header className="border-b border-white/10 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Audit Log</h1>
            <p className="text-sm text-white/55">Role: {role}</p>
          </div>
          <div className="flex gap-2">
            <button className="rounded border border-white/20 px-3 py-2 text-sm" onClick={() => download("audit-log.csv", exportAuditRowsAsCsv(filteredRows), "text/csv")}>
              CSV
            </button>
            <button className="rounded border border-white/20 px-3 py-2 text-sm" onClick={() => download("audit-log.json", exportAuditRowsAsJson(filteredRows), "application/json")}>
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
          <label className="block text-sm text-white/70">
            Event Type
            <select multiple className="mt-1 h-40 w-full rounded border border-white/15 bg-bg-panel px-3 py-2 text-white" value={eventTypes} onChange={(event) => setEventTypes(Array.from(event.target.selectedOptions, (option) => option.value as AuditEventType))}>
              {AUDIT_EVENT_TYPES.map((eventType) => (
                <option key={eventType} value={eventType}>
                  {eventType}
                </option>
              ))}
            </select>
          </label>
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
              {filteredRows.map((row) => (
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

function auditRoleFromLocation(): AuditReviewRole {
  const raw = new URLSearchParams(window.location.search).get("role") ?? "auditor";
  if (
    raw === "auditor" ||
    raw === "practice-admin" ||
    raw === "clinician" ||
    raw === "front-desk" ||
    raw === "aesthetics-provider" ||
    raw === "system"
  ) {
    return raw;
  }
  return "unknown";
}

function download(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
