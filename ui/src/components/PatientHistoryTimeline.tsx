import { useEffect, useState } from "react";
import {
  fetchPatientHistory,
  type AuditLogResponse,
  type AuditLogRow,
} from "../lib/audit-log";

export function PatientHistoryTimeline({
  patientId,
  loadHistory = fetchPatientHistory,
}: {
  patientId: string;
  loadHistory?: typeof fetchPatientHistory;
}) {
  const [history, setHistory] = useState<AuditLogResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    setError(undefined);
    void loadHistory(patientId, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setHistory(response);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [loadHistory, patientId]);

  return (
    <section className="odos-patient-history" data-testid="patient-history-timeline" aria-label="Patient change history">
      <header>
        <div>
          <span>Chart History</span>
          <h2>Changes to this patient chart</h2>
        </div>
        <p>Creates, updates, payments, claims, and document activity. Chart access and break-glass events remain in the administrator audit log.</p>
      </header>
      {!history && !error && <p className="odos-overview-loading">Loading chart History…</p>}
      {error && <p className="odos-overview-error" role="alert">{error}</p>}
      {history?.rows.length === 0 && <p className="odos-patient-history-empty">No chart changes recorded for this patient.</p>}
      {history?.rows.map((row) => <PatientHistoryRow key={row.id} row={row} />)}
    </section>
  );
}

function PatientHistoryRow({ row }: { row: AuditLogRow }) {
  const resourceReference = [row.resourceType, row.resourceId].filter(Boolean).join("/");
  return (
    <article
      className="odos-patient-history-row"
      data-audit-event-id={row.id}
      data-resource-reference={resourceReference || undefined}
    >
      <time dateTime={row.eventTime}>{formatHistoryTime(row.eventTime)}</time>
      <span className="odos-patient-history-event">{historyEventLabel(row)}</span>
      <span className="odos-patient-history-actor">{row.actorId || "Actor not recorded"}</span>
      <span className={`odos-patient-history-outcome is-${row.actionOutcome}`}>{capitalize(row.actionOutcome)}</span>
    </article>
  );
}

function historyEventLabel(row: AuditLogRow): string {
  const event = capitalize(row.eventType.replaceAll(/[.-]/g, " "));
  const resource = [row.resourceType, row.resourceId].filter(Boolean).join("/");
  return resource ? `${event} · ${resource}` : event;
}

function formatHistoryTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Time not recorded"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
