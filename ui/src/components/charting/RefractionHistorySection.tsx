import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { fhir } from "../../lib/fhir";
import { formatPowerOption } from "./power-options";

type Eye = "OD" | "OS";
type Tab = "glasses" | "softCl" | "specialtyCl";
type SortKey = "date" | "type" | "eye";

interface Props {
  patientReference: string;
}

interface HistoryExtra {
  code: string;
  label: string;
  value: number | string;
  unit?: string;
}

interface GlassesRow {
  type: string;
  date: string;
  eye: Eye;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  distVA?: string;
  nearVA?: string;
  purpose?: string;
  extras?: HistoryExtra[];
}

interface SoftContactLensRow {
  date: string;
  eye: Eye;
  manufacturer?: string;
  product?: string;
  baseCurve?: number;
  diameter?: number;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  colorMfPower?: string;
  distVA?: string;
  nearVA?: string;
  status?: string;
  extras?: HistoryExtra[];
}

interface SpecialtyContactLensRow {
  date: string;
  eye: Eye;
  product?: string;
  lensType?: string;
  material?: string;
  baseCurve?: number;
  diameter?: number;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  distVA?: string;
  nearVA?: string;
  extras?: HistoryExtra[];
}

interface RefractionHistoryResponse {
  glasses: GlassesRow[];
  softCl: SoftContactLensRow[];
  specialtyCl: SpecialtyContactLensRow[];
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "glasses", label: "Glasses" },
  { id: "softCl", label: "Soft CL" },
  { id: "specialtyCl", label: "Specialty Contact Lenses" },
];

export function RefractionHistorySection({ patientReference }: Props) {
  const [history, setHistory] = useState<RefractionHistoryResponse | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("glasses");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "date", direction: "desc" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/refraction/history?${new URLSearchParams({ patient: patientReference })}`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as RefractionHistoryResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `Refraction history request failed: ${response.status}`);
        return body;
      })
      .then(setHistory)
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [patientReference]);

  const rows = useMemo(() => {
    if (!history) return [];
    if (activeTab === "glasses") return sortRows(history.glasses, sort.key, sort.direction);
    if (activeTab === "softCl") return sortRows(history.softCl, sort.key, sort.direction);
    return sortRows(history.specialtyCl, sort.key, sort.direction);
  }, [activeTab, history, sort]);

  function selectTab(tab: Tab) {
    setActiveTab(tab);
    if (tab !== "glasses" && sort.key === "type") {
      setSort({ key: "date", direction: "desc" });
    }
  }

  function changeSort(key: SortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
      : { key, direction: key === "date" ? "desc" : "asc" });
  }

  return (
    <section className="min-h-full p-5 md:p-7">
      <div className="mx-auto max-w-[1500px]">
        <div className="border-b border-white/10 pb-4">
          <h1 className="text-2xl font-semibold text-white">Refraction History</h1>
          <p className="mt-1 text-sm text-white/45">Longitudinal spectacle and contact lens prescriptions</p>
        </div>

        <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Refraction history categories">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => selectTab(tab.id)}
              className={[
                "rounded border px-4 py-2 text-sm font-semibold transition",
                activeTab === tab.id
                  ? "border-brand/70 bg-brand/15 text-white"
                  : "border-white/10 bg-bg-mid/70 text-white/55 hover:border-white/25 hover:text-white",
              ].join(" ")}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mt-4 overflow-hidden rounded border border-white/10 bg-bg-panel/55">
          {loading && <div className="p-8 text-center text-sm text-white/45">Loading refraction history…</div>}
          {!loading && error && <div className="p-8 text-center text-sm text-rose-300">{error}</div>}
          {!loading && !error && rows.length === 0 && (
            <div className="p-8 text-center text-sm text-white/45">{emptyMessage(activeTab)}</div>
          )}
          {!loading && !error && rows.length > 0 && (
            <div className="overflow-x-auto">
              {activeTab === "glasses" && (
                <GlassesTable rows={rows as GlassesRow[]} sort={sort} onSort={changeSort} />
              )}
              {activeTab === "softCl" && (
                <SoftContactLensTable rows={rows as SoftContactLensRow[]} sort={sort} onSort={changeSort} />
              )}
              {activeTab === "specialtyCl" && (
                <SpecialtyContactLensTable rows={rows as SpecialtyContactLensRow[]} sort={sort} onSort={changeSort} />
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function GlassesTable({ rows, sort, onSort }: TableProps<GlassesRow>) {
  const extras = extraColumns(rows);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Table>
      <thead><tr>
        <SortableHeader label="Type" sortKey="type" sort={sort} onSort={onSort} />
        <SortableHeader label="Date" sortKey="date" sort={sort} onSort={onSort} />
        <SortableHeader label="Eye" sortKey="eye" sort={sort} onSort={onSort} />
        {plainHeaders(["Sphere", "Cyl", "Axis", "Add", "DVA", "NVA", "Purpose"])}
        <ExtraHeaders extras={extras} />
      </tr></thead>
      <tbody>{rows.map((row, index) => {
        const key = `${row.date}-${row.type}-${row.eye}-${index}`;
        return <Fragment key={key}><tr>
          <Cell>{humanize(row.type)}</Cell><Cell>{formatDate(row.date)}</Cell><Cell>{row.eye}</Cell>
          <Cell>{power(row.sphere)}</Cell><Cell>{power(row.cylinder)}</Cell><Cell>{value(row.axis)}</Cell>
          <Cell>{power(row.add)}</Cell><Cell>{row.distVA}</Cell><Cell>{row.nearVA}</Cell><Cell>{row.purpose}</Cell>
          <ExtraCells row={row} extras={extras} expanded={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)} />
        </tr><ExtraDetailRow row={row} extras={extras} expanded={expanded === key} colSpan={10} /></Fragment>;
      })}</tbody>
    </Table>
  );
}

function SoftContactLensTable({ rows, sort, onSort }: TableProps<SoftContactLensRow>) {
  const extras = extraColumns(rows);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Table>
      <thead><tr>
        <SortableHeader label="Date" sortKey="date" sort={sort} onSort={onSort} />
        <SortableHeader label="Eye" sortKey="eye" sort={sort} onSort={onSort} />
        {plainHeaders(["Manufacturer", "Product", "BC", "Dia", "Sphere", "Cyl", "Axis", "Add", "Color/MF-PWR", "DVA", "NVA", "Status"])}
        <ExtraHeaders extras={extras} />
      </tr></thead>
      <tbody>{rows.map((row, index) => {
        const key = `${row.date}-${row.eye}-${index}`;
        return <Fragment key={key}><tr>
          <Cell>{formatDate(row.date)}</Cell><Cell>{row.eye}</Cell><Cell>{humanize(row.manufacturer)}</Cell>
          <Cell>{humanize(row.product)}</Cell><Cell>{value(row.baseCurve)}</Cell><Cell>{value(row.diameter)}</Cell>
          <Cell>{power(row.sphere)}</Cell><Cell>{power(row.cylinder)}</Cell><Cell>{value(row.axis)}</Cell>
          <Cell>{power(row.add)}</Cell><Cell>{humanize(row.colorMfPower)}</Cell><Cell>{row.distVA}</Cell>
          <Cell>{row.nearVA}</Cell><Cell>{humanize(row.status)}</Cell>
          <ExtraCells row={row} extras={extras} expanded={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)} />
        </tr><ExtraDetailRow row={row} extras={extras} expanded={expanded === key} colSpan={14} /></Fragment>;
      })}</tbody>
    </Table>
  );
}

function SpecialtyContactLensTable({ rows, sort, onSort }: TableProps<SpecialtyContactLensRow>) {
  const extras = extraColumns(rows);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Table>
      <thead><tr>
        <SortableHeader label="Date" sortKey="date" sort={sort} onSort={onSort} />
        <SortableHeader label="Eye" sortKey="eye" sort={sort} onSort={onSort} />
        {plainHeaders(["Product", "Lens Type", "Material", "BC", "Dia", "Sphere", "Cyl", "Axis", "Add", "DVA", "NVA"])}
        <ExtraHeaders extras={extras} />
      </tr></thead>
      <tbody>{rows.map((row, index) => {
        const key = `${row.date}-${row.eye}-${index}`;
        return <Fragment key={key}><tr>
          <Cell>{formatDate(row.date)}</Cell><Cell>{row.eye}</Cell><Cell>{humanize(row.product)}</Cell>
          <Cell>{humanize(row.lensType)}</Cell><Cell>{humanize(row.material)}</Cell><Cell>{value(row.baseCurve)}</Cell>
          <Cell>{value(row.diameter)}</Cell><Cell>{power(row.sphere)}</Cell><Cell>{power(row.cylinder)}</Cell>
          <Cell>{value(row.axis)}</Cell><Cell>{power(row.add)}</Cell><Cell>{row.distVA}</Cell><Cell>{row.nearVA}</Cell>
          <ExtraCells row={row} extras={extras} expanded={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)} />
        </tr><ExtraDetailRow row={row} extras={extras} expanded={expanded === key} colSpan={13} /></Fragment>;
      })}</tbody>
    </Table>
  );
}

interface TableProps<T> {
  rows: T[];
  sort: { key: SortKey; direction: "asc" | "desc" };
  onSort(key: SortKey): void;
}

function Table({ children }: { children: ReactNode }) {
  return <table className="min-w-full border-collapse text-left text-sm">{children}</table>;
}

function Cell({ children }: { children?: ReactNode }) {
  return <td className="whitespace-nowrap border-t border-white/10 px-3 py-3 text-white/72">{children ?? ""}</td>;
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; direction: "asc" | "desc" };
  onSort(key: SortKey): void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className="whitespace-nowrap bg-bg-mid/80 px-3 py-3 text-xs font-semibold uppercase tracking-wide text-white/45">
      <button onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 hover:text-white">
        {label}<span aria-hidden="true">{active ? (sort.direction === "desc" ? "↓" : "↑") : "↕"}</span>
      </button>
    </th>
  );
}

function plainHeaders(labels: string[]) {
  return labels.map((label) => (
    <th key={label} className="whitespace-nowrap bg-bg-mid/80 px-3 py-3 text-xs font-semibold uppercase tracking-wide text-white/45">{label}</th>
  ));
}

function ExtraHeaders({ extras }: { extras: Array<{ code: string; label: string }> }) {
  if (extras.length === 0) return null;
  return extras.length <= 4
    ? <>{plainHeaders(extras.map((extra) => extra.label))}</>
    : <>{plainHeaders(["Additional fields"])}</>;
}

function ExtraCells({ row, extras, expanded, onToggle }: {
  row: { extras?: HistoryExtra[] };
  extras: Array<{ code: string; label: string }>;
  expanded: boolean;
  onToggle(): void;
}) {
  if (extras.length === 0) return null;
  if (extras.length > 4) {
    return <Cell><button type="button" onClick={onToggle} className="rounded border border-white/15 px-2 py-1 text-xs text-brand-light hover:bg-brand/10">{expanded ? "Hide" : "Show"}</button></Cell>;
  }
  const values = new Map((row.extras ?? []).map((extra) => [extra.code, extra]));
  return <>{extras.map((extra) => {
    const item = values.get(extra.code);
    return <Cell key={extra.code}>{formatExtra(item)}</Cell>;
  })}</>;
}

function ExtraDetailRow({ row, extras, expanded, colSpan }: {
  row: { extras?: HistoryExtra[] };
  extras: Array<{ code: string; label: string }>;
  expanded: boolean;
  colSpan: number;
}) {
  if (extras.length <= 4 || !expanded) return null;
  return (
    <tr>
      <td colSpan={colSpan + 1} className="border-t border-white/10 bg-bg-deep/55 px-4 py-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(row.extras ?? []).map((extra) => (
            <div key={extra.code}><div className="text-xs uppercase tracking-wide text-white/35">{extra.label}</div><div className="mt-1 text-sm text-white/75">{formatExtra(extra)}</div></div>
          ))}
        </div>
      </td>
    </tr>
  );
}

function extraColumns(rows: Array<{ extras?: HistoryExtra[] }>): Array<{ code: string; label: string }> {
  const columns = new Map<string, string>();
  for (const row of rows) {
    for (const extra of row.extras ?? []) {
      if (!columns.has(extra.code)) columns.set(extra.code, extra.label);
    }
  }
  return [...columns].map(([code, label]) => ({ code, label }));
}

function formatExtra(extra: HistoryExtra | undefined): string {
  if (!extra) return "";
  return `${extra.value}${extra.unit ? ` ${extra.unit}` : ""}`;
}

function sortRows<T extends { date: string; eye: Eye }>(rows: T[], key: SortKey, direction: "asc" | "desc"): T[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = sortableValue(left, key);
    const rightValue = sortableValue(right, key);
    return (leftValue.localeCompare(rightValue) || left.date.localeCompare(right.date) || left.eye.localeCompare(right.eye)) * multiplier;
  });
}

function sortableValue(row: object, key: SortKey): string {
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function power(item: number | undefined): string {
  return item === undefined ? "" : formatPowerOption(item);
}

function value(item: number | undefined): string {
  return item === undefined ? "" : String(item);
}

function humanize(item: string | undefined): string {
  if (!item) return "";
  return item.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function emptyMessage(tab: Tab): string {
  if (tab === "glasses") return "No glasses history yet";
  if (tab === "softCl") return "No soft contact lens history yet";
  return "No specialty contact lens history yet";
}

function authHeaders(): HeadersInit {
  const authorization = fhir.authHeader();
  return authorization ? { Authorization: authorization } : {};
}

function clinicalGraphApiBase(): string {
  const meta = import.meta as ImportMeta & { env?: { VITE_OSOD_MCP_BASE_URL?: string } };
  return meta.env?.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}
