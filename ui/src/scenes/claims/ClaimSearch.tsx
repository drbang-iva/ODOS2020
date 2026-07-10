import { useEffect, useState, type FormEvent } from "react";
import {
  CLAIM_SEARCH_STATUSES,
  failedClaimsCount,
  fetchClaimSearch,
  type ClaimSearchFilters,
  type ClaimSearchRow,
  type ClaimSearchStatus,
} from "../../lib/claim-search";
import { fetchClaimsWorklist, type ClaimsApiOptions } from "../../lib/claims-worklist";
import { fhir } from "../../lib/fhir";

const EMPTY_FILTERS: ClaimSearchFilters = {};

export function ClaimSearch() {
  const [filters, setFilters] = useState<ClaimSearchFilters>(EMPTY_FILTERS);
  const [items, setItems] = useState<ClaimSearchRow[]>([]);
  const [failedCount, setFailedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const api = claimsApiOptions();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(undefined);
      try {
        const [nextItems, worklistItems] = await Promise.all([
          fetchClaimSearch(EMPTY_FILTERS, api),
          fetchClaimsWorklist(undefined, api),
        ]);
        if (!cancelled) {
          setItems(nextItems);
          setFailedCount(failedClaimsCount(worklistItems));
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [api.authorization, api.baseUrl]);

  const search = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setItems(await fetchClaimSearch(filters, api));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ClaimSearchContent
      filters={filters}
      items={items}
      failedCount={failedCount}
      loading={loading}
      error={error}
      onFiltersChange={setFilters}
      onSearch={search}
      onOpenWorklist={() => window.location.assign("/billing/claims/worklist")}
    />
  );
}

export function ClaimSearchContent({
  filters,
  items,
  failedCount,
  loading,
  error,
  onFiltersChange,
  onSearch,
  onOpenWorklist,
}: {
  filters: ClaimSearchFilters;
  items: readonly ClaimSearchRow[];
  failedCount: number;
  loading: boolean;
  error?: string;
  onFiltersChange: (filters: ClaimSearchFilters) => void;
  onSearch: () => Promise<void> | void;
  onOpenWorklist: () => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSearch();
  };
  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Claims management</p>
          <h1 className="text-2xl font-semibold">Claim search</h1>
          <p className="mt-1 text-sm text-white/50">Search submitted claims and their latest response state.</p>
        </div>
        <button
          type="button"
          onClick={onOpenWorklist}
          className="rounded-full border border-red-400/30 bg-red-950/40 px-3 py-1.5 text-sm font-bold text-red-200 hover:bg-red-950/70"
        >
          {failedCount} failed claims
        </button>
      </header>

      <ClaimSearchForm filters={filters} onChange={onFiltersChange} onSubmit={submit} />

      {error && (
        <div role="alert" className="my-4 rounded-md border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {loading ? (
        <div className="grid min-h-52 place-items-center text-sm text-white/50">Searching claims…</div>
      ) : (
        <ClaimSearchResults items={items} />
      )}
    </main>
  );
}

export function ClaimSearchForm({
  filters,
  onChange,
  onSubmit,
}: {
  filters: ClaimSearchFilters;
  onChange: (filters: ClaimSearchFilters) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const set = (key: keyof ClaimSearchFilters, value: string | undefined) => onChange({ ...filters, [key]: value || undefined });
  return (
    <form onSubmit={onSubmit} className="mb-5 rounded-lg border border-white/10 bg-bg-panel/80 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <SearchField label="Patient" value={filters.patient ?? ""} placeholder="Name or Patient/id" onChange={(value) => set("patient", value)} />
        <SearchField label="Claim #" value={filters.claim ?? ""} placeholder="Claim id or PCN" onChange={(value) => set("claim", value)} />
        <label className="text-xs font-bold text-white/55">
          Status
          <select
            value={filters.status ?? ""}
            onChange={(event) => set("status", event.target.value as ClaimSearchStatus)}
            className="mt-1.5 h-10 w-full rounded border border-white/15 bg-black/30 px-3 text-sm text-white"
          >
            <option value="">Any status</option>
            {CLAIM_SEARCH_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </select>
        </label>
        <SearchField label="Carrier" value={filters.carrier ?? ""} placeholder="Name or Organization/id" onChange={(value) => set("carrier", value)} />
        <SearchField label="Office / location" value={filters.office ?? ""} placeholder="Name or Location/id" onChange={(value) => set("office", value)} />
      </div>
      <details className="mt-4 border-t border-white/10 pt-3">
        <summary className="cursor-pointer text-sm font-bold text-blue-300">Additional Search Criteria</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <SearchField label="CPT code" value={filters.cpt ?? ""} placeholder="Procedure code" onChange={(value) => set("cpt", value)} />
          <SearchField label="Minimum charged" value={filters.minAmount ?? ""} placeholder="0.00" type="number" onChange={(value) => set("minAmount", value)} />
          <SearchField label="Maximum charged" value={filters.maxAmount ?? ""} placeholder="500.00" type="number" onChange={(value) => set("maxAmount", value)} />
        </div>
      </details>
      <div className="mt-4 flex justify-end">
        <button type="submit" className="rounded bg-blue-600 px-5 py-2 text-sm font-bold text-white hover:bg-blue-500">Search claims</button>
      </div>
    </form>
  );
}

export function ClaimSearchResults({ items }: { items: readonly ClaimSearchRow[] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-bg-panel/80">
      <div className="border-b border-white/10 px-4 py-3 text-sm text-white/50">
        {items.length === 1 ? "1 claim" : `${items.length} claims`}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1280px] text-left text-sm">
          <thead className="bg-black/20 text-xs uppercase tracking-wide text-white/40">
            <tr>
              <th className="px-4 py-3">Claim #</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">CPT</th>
              <th className="px-4 py-3 text-right">Charged</th>
              <th className="px-4 py-3 text-right">Insurance paid</th>
              <th className="px-4 py-3 text-right">Patient responsibility</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Payer</th>
              <th className="px-4 py-3 text-right">Days since submission</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {items.map((item) => (
              <tr key={item.claimReference} className="text-white/70 hover:bg-white/5">
                <td className="px-4 py-3 font-semibold text-blue-300">{item.claimNumber}</td>
                <td className="px-4 py-3">{item.patient}</td>
                <td className="px-4 py-3">{item.provider}</td>
                <td className="px-4 py-3">{item.cptCodes.join(", ") || "—"}</td>
                <td className="px-4 py-3 text-right">{money(item.totalChargedCents)}</td>
                <td className="px-4 py-3 text-right">{money(item.insurancePaidCents)}</td>
                <td className="px-4 py-3 text-right">{money(item.patientResponsibilityCents)}</td>
                <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                <td className="px-4 py-3">{item.payer}</td>
                <td className="px-4 py-3 text-right">{item.daysSinceSubmission}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-white/35">No claims match these criteria.</div>
        )}
      </div>
    </section>
  );
}

function SearchField({
  label,
  value,
  placeholder,
  type = "text",
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  type?: "text" | "number";
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-bold text-white/55">
      {label}
      <input
        type={type}
        min={type === "number" ? "0" : undefined}
        step={type === "number" ? "0.01" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-10 w-full rounded border border-white/15 bg-black/30 px-3 text-sm text-white placeholder:text-white/25"
      />
    </label>
  );
}

function StatusBadge({ status }: { status: ClaimSearchStatus }) {
  const color = status === "rejected" || status === "denied"
    ? "bg-red-950/70 text-red-200"
    : status === "underpaid"
      ? "bg-amber-950/70 text-amber-200"
      : status === "paid"
        ? "bg-emerald-950/70 text-emerald-200"
        : "bg-blue-950/70 text-blue-200";
  return <span className={`rounded-full px-2 py-1 text-xs font-bold ${color}`}>{statusLabel(status)}</span>;
}

function statusLabel(status: ClaimSearchStatus): string {
  return status[0].toUpperCase() + status.slice(1);
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
