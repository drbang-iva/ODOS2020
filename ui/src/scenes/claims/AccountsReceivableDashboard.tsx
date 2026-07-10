import { useEffect, useState } from "react";
import { fhir } from "../../lib/fhir";
import type { ClaimsApiOptions, WorklistCode } from "../../lib/claims-worklist";
import {
  fetchAccountsReceivableDashboard,
  type AccountsReceivableDashboardData,
  type AgingBucket,
} from "../../lib/reporting";

const WORKLIST_LABELS: Record<WorklistCode, string> = {
  "era-denial": "Denials",
  "era-underpayment": "Underpayments",
  "era-unmatched": "Unmatched ERAs",
  "claim-rejected": "Rejected claims",
};

export function AccountsReceivableDashboard() {
  const [data, setData] = useState<AccountsReceivableDashboardData>();
  const [error, setError] = useState<string>();
  const api = claimsApiOptions();

  useEffect(() => {
    let cancelled = false;
    fetchAccountsReceivableDashboard(api)
      .then((next) => { if (!cancelled) setData(next); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [api.authorization, api.baseUrl]);

  return (
    <AccountsReceivableDashboardContent
      data={data}
      error={error}
      onOpenClaims={(params) => window.location.assign(claimSearchPath(params))}
      onOpenWorklist={() => window.location.assign("/billing/claims/worklist?status=open")}
    />
  );
}

export function AccountsReceivableDashboardContent({
  data,
  error,
  onOpenClaims,
  onOpenWorklist,
}: {
  data?: AccountsReceivableDashboardData;
  error?: string;
  onOpenClaims: (params: { minDays?: number; maxDays?: number }) => void;
  onOpenWorklist: () => void;
}) {
  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Claims management</p>
        <h1 className="text-2xl font-semibold">Accounts receivable</h1>
        <p className="mt-1 text-sm text-white/50">Open-claim age and worklist pressure, with every metric linked to its source table.</p>
      </header>

      {error && <div role="alert" className="mb-4 rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{error}</div>}
      {!data && !error && <div className="grid min-h-52 place-items-center text-sm text-white/50">Loading accounts receivable…</div>}
      {data && (
        <div className="space-y-4">
          <section aria-label="Accounts receivable summary" className="grid gap-4 md:grid-cols-3">
            <MetricButton
              label="Total outstanding"
              value="Unavailable"
              detail="Balance linkage not shipped"
              tone="gap"
              onClick={() => onOpenClaims({})}
            />
            <MetricButton
              label="Average days outstanding"
              value={data.averageDaysOutstanding === null ? "—" : String(data.averageDaysOutstanding)}
              detail={`${data.outstandingClaimCount} open ${data.outstandingClaimCount === 1 ? "claim" : "claims"}`}
              onClick={() => onOpenClaims({})}
            />
            <MetricButton
              label="Open worklist"
              value={String(data.openWorklistTotal)}
              detail={Object.entries(data.openWorklistCounts)
                .map(([code, count]) => `${WORKLIST_LABELS[code as WorklistCode]} ${count}`)
                .join(" · ")}
              onClick={onOpenWorklist}
            />
          </section>

          <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-4">
            <div className="mb-3">
              <h2 className="font-semibold">Aging buckets</h2>
              <p className="text-xs text-white/45">Open claim counts by days since submission.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {data.agingBuckets.map((bucket) => (
                <AgingBucketButton key={bucket.code} bucket={bucket} onClick={() => onOpenClaims(bucket)} />
              ))}
            </div>
          </section>

          <div className="rounded border border-amber-300/20 bg-amber-950/20 px-4 py-3 text-sm text-amber-100/80">
            <strong>Total outstanding is intentionally not calculated.</strong> {data.totalOutstanding.reason}
          </div>
        </div>
      )}
    </main>
  );
}

function MetricButton({
  label,
  value,
  detail,
  tone = "default",
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "gap";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-36 rounded-lg border p-4 text-left transition hover:bg-white/10 ${tone === "gap" ? "border-amber-300/25 bg-amber-950/20" : "border-white/10 bg-bg-panel/80"}`}
    >
      <span className="text-xs font-bold uppercase tracking-wide text-white/45">{label}</span>
      <span className={`mt-2 block text-3xl font-semibold ${tone === "gap" ? "text-amber-200" : "text-white"}`}>{value}</span>
      <span className="mt-2 block text-xs leading-relaxed text-white/45">{detail}</span>
      <span className="mt-3 block text-xs font-bold text-blue-300">Open source table →</span>
    </button>
  );
}

function AgingBucketButton({ bucket, onClick }: { bucket: AgingBucket; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded border border-white/10 bg-black/20 p-4 text-left hover:bg-white/10">
      <span className="text-xs font-bold uppercase tracking-wide text-white/45">{bucket.label}</span>
      <span className="mt-1 block text-2xl font-semibold">{bucket.claimCount}</span>
      <span className="mt-1 block text-xs text-blue-300">View claims →</span>
    </button>
  );
}

function claimSearchPath(params: { minDays?: number; maxDays?: number }): string {
  const query = new URLSearchParams({ outstanding: "true" });
  if (params.minDays !== undefined) query.set("minDays", String(params.minDays));
  if (params.maxDays !== undefined) query.set("maxDays", String(params.maxDays));
  return `/billing/claims/search?${query.toString()}`;
}

function claimsApiOptions(): ClaimsApiOptions {
  const meta = import.meta as ImportMeta & { env?: { VITE_OSOD_MCP_BASE_URL?: string } };
  return {
    authorization: fhir.authHeader(),
    baseUrl: meta.env?.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "",
  };
}
