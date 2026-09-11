import { useEffect, useRef, useState } from "react";
import { COMMS_PURPOSES, CommunicationsResponseError, downloadEvidenceGapsCsv, listEvidenceGaps, type EvidenceGapFilters, type EvidenceGapReport } from "../lib/communications-client";
import { COMMUNICATION_PURPOSE_LABELS, COMMUNICATION_CHANNEL_LABELS } from "../components/patient/CommunicationPreferencesControl";

export function canViewConsentEvidence(roles: readonly string[]): boolean {
  return roles.some(role => role === "staff" || role === "provider" || role === "admin");
}
const ACCESS_MESSAGE = "You don't have permission to view consent evidence. Ask a practice administrator.";
const tierLabels = { "1": "Marketing texts", "2": "Other texts", "3": "Email" } as const;

export function ConsentEvidence({ canView }: { canView: boolean }) {
  const [filters, setFilters] = useState<EvidenceGapFilters>({});
  const [report, setReport] = useState<EvidenceGapReport>();
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [exportNotice, setExportNotice] = useState<string>();
  const [denied, setDenied] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const operation = ++generation.current;
    setReport(undefined); setError(undefined); setExportNotice(undefined); setDenied(false);
    if (!canView) { setLoading(false); return; }
    setLoading(true);
    listEvidenceGaps(filters).then(value => { if (generation.current === operation) setReport(value); })
      .catch(cause => {
        if (generation.current !== operation) return;
        setDenied(cause instanceof CommunicationsResponseError && cause.status === 403);
        setError(reportError(cause));
      }).finally(() => { if (generation.current === operation) setLoading(false); });
    return () => { if (generation.current === operation) generation.current++; };
  }, [canView, filters]);

  async function loadMore() {
    if (!report?.cursor || loading || !canView || denied) return;
    const operation = generation.current;
    setLoading(true); setError(undefined);
    try {
      const next = await listEvidenceGaps({ ...filters, cursor: report.cursor });
      if (generation.current !== operation) return;
      setReport({ ...next, rows: [...report.rows, ...next.rows], suppressed: [...report.suppressed, ...next.suppressed], counts: {
        "1": report.counts["1"] + next.counts["1"], "2": report.counts["2"] + next.counts["2"], "3": report.counts["3"] + next.counts["3"],
      } });
    } catch (cause) {
      if (generation.current !== operation) return;
      if (cause instanceof CommunicationsResponseError && cause.status === 403) { setDenied(true); setReport(undefined); }
      setError(reportError(cause));
    } finally { if (generation.current === operation) setLoading(false); }
  }
  async function exportCsv() {
    if (!canView || denied || exporting || loading) return;
    const operation = generation.current;
    setExporting(true); setError(undefined); setExportNotice(undefined);
    try {
      const csv = await downloadEvidenceGapsCsv(filters);
      if (generation.current !== operation) return;
      const url = URL.createObjectURL(new Blob([csv.text], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = "consent-evidence.csv"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      if (csv.truncated === "true") setExportNotice("The CSV contains a partial report. Use Load more to review remaining results.");
    } catch (cause) {
      if (generation.current !== operation) return;
      if (cause instanceof CommunicationsResponseError && cause.status === 403) { setDenied(true); setReport(undefined); }
      setError(reportError(cause));
    } finally { setExporting(false); }
  }
  if (!canView || denied) return <main className="mx-auto max-w-6xl p-6"><h1 className="text-2xl font-semibold">Consent evidence</h1><p role="alert" className="mt-4">{ACCESS_MESSAGE}</p></main>;
  return <main className="mx-auto grid max-w-6xl gap-5 p-6" aria-labelledby="consent-evidence-title">
    <header className="flex flex-wrap justify-between gap-4"><div><h1 id="consent-evidence-title" className="text-2xl font-semibold">Consent evidence</h1><p className="mt-2 text-sm text-[var(--odos-muted)]">Communication preference gaps by tier. Suppressed channels are listed separately from gaps.</p></div>
      <button type="button" className="odos-pill" disabled={loading || exporting || !report} onClick={() => void exportCsv()}>{exporting ? "Exporting…" : "Export CSV"}</button></header>
    <section className="grid grid-cols-3 gap-3" aria-label="Evidence gaps by tier">{(["1", "2", "3"] as const).map(tier => <div key={tier} className="rounded border border-[var(--odos-line)] p-4"><h2 className="text-sm">Tier {tier} · {tierLabels[tier]}</h2><p className="mt-2 text-2xl font-semibold" aria-label={`Tier ${tier} gap count`}>{report?.counts[tier] ?? "—"}</p></div>)}</section>
    <section className="flex flex-wrap gap-4" aria-label="Evidence filters">
      <label>Tier<select aria-label="Tier" className="ml-2 rounded border p-2" value={filters.tier ?? ""} disabled={loading || exporting} onChange={event => setFilters(current => ({ ...current, tier: event.target.value as EvidenceGapFilters["tier"] || undefined }))}><option value="">All tiers</option>{(["1", "2", "3"] as const).map(tier => <option key={tier} value={tier}>{tier} · {tierLabels[tier]}</option>)}</select></label>
      <label>Purpose<select aria-label="Purpose" className="ml-2 rounded border p-2" value={filters.purpose ?? ""} disabled={loading || exporting} onChange={event => setFilters(current => ({ ...current, purpose: event.target.value as EvidenceGapFilters["purpose"] || undefined }))}><option value="">All purposes</option>{COMMS_PURPOSES.map(purpose => <option key={purpose} value={purpose}>{COMMUNICATION_PURPOSE_LABELS[purpose]}</option>)}</select></label>
      <label>Channel<select aria-label="Channel" className="ml-2 rounded border p-2" value={filters.channel ?? ""} disabled={loading || exporting} onChange={event => setFilters(current => ({ ...current, channel: event.target.value as EvidenceGapFilters["channel"] || undefined }))}><option value="">All channels</option><option value="sms">Text</option><option value="email">Email</option></select></label>
    </section>
    {error && <p role="alert">{error}</p>}{exportNotice && <p role="status">{exportNotice}</p>}
    {loading && <p role="status">Loading consent evidence…</p>}
    {report?.truncated && <section role="status" className="flex items-center justify-between gap-4 rounded border border-[var(--odos-amber)] p-4"><p>This report is truncated. More patients remain; counts cover the loaded results.</p><button type="button" className="odos-pill" disabled={loading} onClick={() => void loadMore()}>Load more</button></section>}
    {report && <div className="overflow-x-auto"><table className="w-full text-left" aria-label="Consent evidence gaps"><thead><tr>{["Patient", "Purpose", "Channel", "Tier", "Status"].map(label => <th key={label} className="border-b p-3">{label}</th>)}</tr></thead><tbody>{([
      ...report.rows.map(row => ({ ...row, status: "gap" })), ...report.suppressed.map(row => ({ ...row, status: "suppressed" })),
    ]).map(row => <tr key={`${row.patientReference}/${row.purpose}/${row.channel}/${row.status}`}><td className="border-b p-3"><a className="underline" href={`/clinic?patientId=${encodeURIComponent(row.patientReference.slice("Patient/".length))}`}>{row.patientReference}</a></td><td className="border-b p-3">{COMMUNICATION_PURPOSE_LABELS[row.purpose]}</td><td className="border-b p-3">{COMMUNICATION_CHANNEL_LABELS[row.channel]}</td><td className="border-b p-3">{row.tier}</td><td className="border-b p-3">{row.status}</td></tr>)}</tbody></table>{!report.rows.length && !report.suppressed.length && <p className="p-4">No preference gaps or suppressed channels match these filters.</p>}</div>}
  </main>;
}
function reportError(cause: unknown): string {
  return cause instanceof CommunicationsResponseError && cause.status === 403 ? ACCESS_MESSAGE : "Consent evidence could not be read. Please try again.";
}
