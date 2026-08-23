import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { OdosWheel } from "../inputs/OdosWheel";
import { OdosChips } from "../inputs/OdosChips";
import { formatStepValue } from "./power-options";
import { SerialTrendChart, type SerialTrendSeries } from "./SerialTrendChart";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";

export type FindingQualifierDefinition =
  | { kind: "graded"; key: string; display: string; options: string[]; scheme?: string }
  | { kind: "enum"; key: string; display: string; options: Array<{ code: string; display: string }> }
  | { kind: "numeric"; key: string; display: string; min: number; max: number; step: number; unit?: string }
  | { kind: "extent"; key: string; display: string };

export interface ClockHourExtentValue {
  from: number;
  to: number;
  clockwise: boolean;
}

export type FindingQualifierValue = number | string | ClockHourExtentValue;
export type FindingDetails = Record<string, Record<string, FindingQualifierValue>>;

export interface CustomFindingField {
  localCode: string;
  display: string;
  valueType: "number" | "select" | "multi-select" | "string";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  inputControl?: "date" | "toggle";
  defaultValue?: number | string;
  options?: Array<{
    code: string;
    display: string;
    active: boolean;
    parentCode?: string;
    priority?: boolean;
    qualifiers?: FindingQualifierDefinition[];
  }>;
  order: number;
  active: boolean;
}

export interface CustomFindingDefinition {
  resourceKind?: "finding" | "procedure";
  discipline?: "eyecare" | "aesthetics";
  stableKey: string;
  sectionKey?: string;
  display: string;
  active: boolean;
  perEye: boolean;
  customFields: CustomFindingField[];
  fields?: Record<string, {
    display?: string;
    type?: string;
    minimum?: number;
    maximum?: number;
    precision?: number;
    defaultValue?: number;
    options?: Array<{ code: string; display: string; active?: boolean }>;
  }>;
  normalTemplate?: string;
  allowDeferred?: boolean;
  sourceStatus?: "verified-seed" | "unseeded-needs-operator-input" | "local-practice";
  setupMessage?: string;
}

interface Props {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
  apiBase?: string;
}

interface HistoryRow {
  recordedAt: string;
  eye?: Eye;
  values: Array<{ code: string; label: string; value: number | string; unit?: string }>;
  remarks?: string;
}

interface NumericHistoryTrendConfig {
  title: string;
  ariaLabel: string;
  valueCode: string;
  axisUnit: string;
  emptyText: string;
}

const EYES: Eye[] = ["OD", "OS"];
const NUMERIC_HISTORY_TRENDS = new Map<string, NumericHistoryTrendConfig>([
  ["dry-eye:markers", {
    title: "Tear osmolarity trend",
    ariaLabel: "Tear osmolarity trend",
    valueCode: "CUSTOM_OSMOLARITY_MOSM_L",
    axisUnit: "mOsm/L",
    emptyText: "No tear osmolarity recorded",
  }],
]);

export function CustomFindingSection({ definition, patientReference, encounterReference, onSaved, apiBase }: Props) {
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [remarks, setRemarks] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const resourceKind = definition.resourceKind ?? "finding";
  const fields = definition.customFields.filter((field) => field.active).sort((left, right) => left.order - right.order);
  const trendConfig = NUMERIC_HISTORY_TRENDS.get(definition.stableKey);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true);
    setHistoryError(null);
    fetch(historyUrl(definition.stableKey, patientReference, resourceKind, apiBase), { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { rows?: HistoryRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `Custom section history failed: ${response.status}`);
        return body.rows ?? [];
      })
      .then(setHistory)
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setHistoryError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [definition.stableKey, patientReference, resourceKind, historyVersion, apiBase]);

  function update(key: string, value: string | string[]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = resourceKind === "procedure"
        ? {
            patientReference,
            encounterReference,
            performedDateTime: new Date().toISOString(),
            ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
          }
        : definition.perEye
          ? {
              patientReference,
              encounterReference,
              eyes: Object.fromEntries(EYES.flatMap((eye) => {
                const customFields = fieldValues(fields, values, eye);
                return customFields.length ? [[eye, { customFields }]] : [];
              })),
              ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
            }
          : {
              patientReference,
              encounterReference,
              customFields: fieldValues(fields, values),
              ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
            };
      const response = await fetch(captureUrl(definition.stableKey, resourceKind, apiBase), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Custom section save failed: ${response.status}`);
      const status = {
        completed: true,
        summary: resourceKind === "procedure"
          ? "Procedure recorded"
          : definition.perEye ? "OD/OS saved" : "Saved",
        savedAt: new Date().toISOString(),
        operator: "ODOS UI custom section",
      };
      setSaved(status);
      onSaved(status);
      setHistoryVersion((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <div className="border-b border-white/10 pb-4">
          <h2 className="text-lg font-semibold text-white">{definition.display}</h2>
          <p className="mt-1 text-sm text-white/45">
            {resourceKind === "procedure"
              ? "Data-defined clinical procedure"
              : definition.stableKey.startsWith("dry-eye:")
                ? "Compiled dry-eye workup section"
                : "Practice-created chart section"}
          </p>
        </div>
        {fields.length > 0 ? (
          <div className={definition.perEye ? "mt-5 grid gap-4 xl:grid-cols-2" : "mt-5 max-w-2xl"}>
            {(definition.perEye ? EYES : [undefined]).map((eye) => (
              <div key={eye ?? "record"} className="rounded border border-white/10 bg-white/[0.02] p-4">
                {eye && <div className="mb-4 text-sm font-semibold text-white">{eye}</div>}
                <div className="grid gap-4 md:grid-cols-2">
                  {fields.map((field) => (
                    <CustomFieldControl
                      key={field.localCode}
                      field={field}
                      value={values[valueKey(field.localCode, eye)] ??
                        (field.valueType === "multi-select" ? [] : String(field.defaultValue ?? ""))}
                      onChange={(value) => update(valueKey(field.localCode, eye), value)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-5 max-w-2xl rounded border border-white/10 bg-white/[0.02] p-4 text-sm text-white/55">
            This definition has no additional capture fields.
          </div>
        )}
        <label className="mt-4 block max-w-4xl">
          <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Other / notes</span>
          <textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} rows={3} className="w-full rounded border border-white/15 bg-bg-deep p-3 text-white outline-none focus:border-brand" />
        </label>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="min-h-10">
            {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
            {saved && !error && <div className="text-sm text-white/70">{saved.summary}<span className="ml-3 text-xs text-white/45">{saved.savedAt}</span></div>}
          </div>
          <button type="button" onClick={save} disabled={saving} className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:opacity-50">{saving ? "Saving…" : resourceKind === "procedure" ? `Record ${definition.display}` : `Save ${definition.display}`}</button>
        </div>
        {!historyLoading && !historyError && trendConfig && (
          <NumericHistoryTrend config={trendConfig} rows={history} />
        )}
        <div className="mt-8 overflow-hidden rounded border border-white/10 bg-bg-panel/55">
          <div className="border-b border-white/10 px-4 py-3 text-sm font-semibold text-white">History</div>
          {historyLoading && <div className="p-6 text-sm text-white/45">Loading history…</div>}
          {!historyLoading && historyError && <div className="p-6 text-sm text-rose-300">{historyError}</div>}
          {!historyLoading && !historyError && history.length === 0 && <div className="p-6 text-sm text-white/45">No prior entries</div>}
          {!historyLoading && !historyError && history.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-white/35"><tr><th className="px-4 py-3">Date</th>{definition.perEye && <th className="px-4 py-3">Eye</th>}<th className="px-4 py-3">Values</th><th className="px-4 py-3">Other / notes</th></tr></thead>
                <tbody>{history.map((row, index) => <tr key={`${row.recordedAt}-${row.eye ?? "record"}-${index}`} className="border-t border-white/10"><td className="px-4 py-3 text-white/65">{formatDate(row.recordedAt)}</td>{definition.perEye && <td className="px-4 py-3 text-white/75">{row.eye}</td>}<td className="px-4 py-3 text-white/75">{row.values.map((value) => `${value.label}: ${value.value}${value.unit ? ` ${value.unit}` : ""}`).join(" · ") || "—"}</td><td className="px-4 py-3 text-white/55">{row.remarks ?? "—"}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function NumericHistoryTrend({ config, rows }: { config: NumericHistoryTrendConfig; rows: HistoryRow[] }) {
  const points: Record<Eye, SerialTrendSeries["points"]> = { OD: [], OS: [] };
  rows.forEach((row, index) => {
    if (row.eye !== "OD" && row.eye !== "OS") return;
    const reading = row.values.find((value) => value.code === config.valueCode);
    if (typeof reading?.value !== "number" || !Number.isFinite(reading.value)) return;
    const recordedAt = Date.parse(row.recordedAt);
    if (!Number.isFinite(recordedAt)) return;
    points[row.eye].push({
      id: `${row.recordedAt}-${row.eye}-${index}`,
      x: recordedAt,
      value: reading.value,
      title: `${row.eye} · ${reading.value} ${config.axisUnit} · ${formatTrendDate(row.recordedAt)}`,
    });
  });
  const coincidentPoints = new Map<string, SerialTrendSeries["points"]>();
  for (const point of [...points.OD, ...points.OS]) {
    const key = `${point.x}:${point.value}`;
    const group = coincidentPoints.get(key) ?? [];
    group.push(point);
    coincidentPoints.set(key, group);
  }
  for (const group of coincidentPoints.values()) {
    if (group.length < 2) continue;
    group.forEach((point, index) => {
      point.xOffset = (index - (group.length - 1) / 2) * 10;
    });
  }
  const series: SerialTrendSeries[] = [
    { id: `${config.valueCode}-od`, label: "OD", color: "var(--odos-sapphire)", points: points.OD },
    { id: `${config.valueCode}-os`, label: "OS", color: "var(--odos-amber)", points: points.OS },
  ];
  return (
    <div className="mt-8 rounded border border-[color:var(--odos-line)] bg-bg-panel/55 p-4">
      <div className="mb-3">
        <h3 className="font-semibold text-[color:var(--odos-text)]">{config.title}</h3>
        <p className="mt-1 text-xs text-[color:var(--odos-muted)]">{config.axisUnit} · higher readings plot higher</p>
      </div>
      <SerialTrendChart
        ariaLabel={config.ariaLabel}
        series={series}
        xFormat={(value) => formatTrendDate(new Date(value).toISOString())}
        yFormat={(value) => `${Math.round(value)} ${config.axisUnit}`}
        emptyText={config.emptyText}
      />
    </div>
  );
}

function CustomFieldControl({ field, value, onChange }: {
  field: CustomFindingField;
  value: string | string[];
  onChange(value: string | string[]): void;
}) {
  const hint = [
    field.min !== undefined ? `min ${field.min}` : "",
    field.max !== undefined ? `max ${field.max}` : "",
    field.step !== undefined ? `step ${field.step}` : "",
  ].filter(Boolean).join(" · ");
  const toggleValue = field.options?.[0]?.code ?? "true";
  const numericValue = typeof value === "string" ? value : "";
  const hasWheelBounds = field.min !== undefined && field.max !== undefined && field.step !== undefined;
  if (!field.inputControl && field.valueType === "multi-select") {
    return (
      <div className="block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{field.display}</span>
        <HierarchicalChips
          options={(field.options ?? []).filter((option) => option.active)}
          selected={Array.isArray(value) ? value : []}
          ariaLabel={field.display}
          onChange={onChange}
        />
        {hint && <span className="mt-1 block text-xs text-white/30">{hint}</span>}
      </div>
    );
  }
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{field.display}</span>
      {field.inputControl === "toggle" ? (
        <label className="flex h-11 items-center gap-3 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm text-[color:var(--odos-muted)]">
          <input
            type="checkbox"
            checked={value === toggleValue}
            onChange={(event) => onChange(event.target.checked ? toggleValue : "")}
            className="accent-brand"
          />
          {value === toggleValue ? "Yes" : "No"}
        </label>
      ) : field.inputControl === "date" ? (
        <input
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-[color:var(--odos-text)] outline-none focus:border-brand"
        />
      ) : field.valueType === "number" ? (
        hasWheelBounds ? (
          <OdosWheel
            value={numericValue === "" ? 0 : Number(numericValue)}
            centerOn={0}
            min={field.min!}
            max={field.max!}
            step={field.step!}
            format={(next) => formatStepValue(next, field.step!)}
            onChange={(next) => onChange(String(next))}
            ariaLabel={field.display}
            unit={field.unit}
            states={[{ value: "", label: "Not recorded" }]}
            selectedState={numericValue === "" ? "" : undefined}
            onStateChange={onChange}
          />
        ) : (
          <div className="flex overflow-hidden rounded border border-white/15 bg-bg-deep focus-within:border-brand">
            <input type="number" value={numericValue} min={field.min} max={field.max} step={field.step ?? "any"} onChange={(event) => onChange(event.target.value)} className="h-11 min-w-0 flex-1 bg-transparent px-3 text-white outline-none" />
            {field.unit && <span className="flex items-center border-l border-white/10 px-3 text-sm text-white/45">{field.unit}</span>}
          </div>
        )
      ) : field.valueType === "select" ? (
        <select value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand">
          <option value="">Select</option>
          {(field.options ?? []).filter((option) => option.active).map((option) => <option key={option.code} value={option.code}>{option.display}</option>)}
        </select>
      ) : field.valueType === "string" ? (
        <input type="text" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} className="h-11 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-[color:var(--odos-text)] outline-none focus:border-brand" />
      ) : null}
      {hint && <span className="mt-1 block text-xs text-white/30">{hint}</span>}
    </label>
  );
}

function HierarchicalChips({
  options,
  selected,
  ariaLabel,
  onChange,
}: {
  options: NonNullable<CustomFindingField["options"]>;
  selected: string[];
  ariaLabel: string;
  onChange(value: string[]): void;
}) {
  const parents = options.filter((option) => !option.parentCode);
  const parentCodes = parents.map((option) => option.code);
  return (
    <div className="space-y-3 rounded border border-white/10 p-3">
      <OdosChips
        options={parents.map((option) => ({ value: option.code, label: option.display }))}
        selected={selected.filter((code) => parentCodes.includes(code))}
        onChange={(nextParents) => {
          const removedParents = parentCodes.filter((code) => selected.includes(code) && !nextParents.includes(code));
          const removedChildren = new Set(options
            .filter((option) => option.parentCode && removedParents.includes(option.parentCode))
            .map((option) => option.code));
          onChange(replaceSelectedGroup(selected, parentCodes, nextParents)
            .filter((code) => !removedChildren.has(code)));
        }}
        ariaLabel={ariaLabel}
      />
      {parents.filter((parent) => selected.includes(parent.code)).map((parent) => {
        const children = options.filter((option) => option.parentCode === parent.code);
        if (children.length === 0) return null;
        const childCodes = children.map((child) => child.code);
        return (
          <div key={parent.code} className="ml-3 border-l border-white/10 pl-3">
            <div className="mb-2 text-xs text-[color:var(--odos-muted)]">{parent.display} details</div>
            <OdosChips
              options={children.map((child) => ({ value: child.code, label: child.display }))}
              selected={selected.filter((code) => childCodes.includes(code))}
              onChange={(nextChildren) => onChange(replaceSelectedGroup(selected, childCodes, nextChildren))}
              ariaLabel={`${parent.display} details`}
            />
          </div>
        );
      })}
    </div>
  );
}

function replaceSelectedGroup(selected: string[], group: string[], nextGroup: string[]): string[] {
  const groupSet = new Set(group);
  const nextSet = new Set(nextGroup);
  return [
    ...selected.filter((value) => !groupSet.has(value) || nextSet.has(value)),
    ...nextGroup.filter((value) => !selected.includes(value)),
  ];
}

function fieldValues(fields: CustomFindingField[], values: Record<string, string | string[]>, eye?: Eye) {
  const result: Array<{ code: string; value: number | string | string[] }> = [];
  for (const field of fields) {
    const raw = values[valueKey(field.localCode, eye)];
    if (Array.isArray(raw)) {
      if (raw.length) result.push({ code: field.localCode, value: raw });
      continue;
    }
    const trimmed = raw?.trim();
    if (trimmed) result.push({ code: field.localCode, value: field.valueType === "number" ? Number(trimmed) : trimmed });
  }
  return result;
}

function valueKey(code: string, eye?: Eye): string {
  return `${eye ?? "record"}:${code}`;
}

function captureUrl(
  stableKey: string,
  resourceKind: "finding" | "procedure",
  apiBase?: string,
): string {
  const path = resourceKind === "procedure"
    ? `/clinical-graph/procedure-definitions/${encodeURIComponent(stableKey)}/capture`
    : `/clinical-graph/custom/${encodeURIComponent(stableKey)}`;
  return `${apiBase ?? clinicalGraphApiBase()}${path}`;
}

function historyUrl(
  stableKey: string,
  patientReference: string,
  resourceKind: "finding" | "procedure",
  apiBase?: string,
): string {
  const path = resourceKind === "procedure"
    ? `/clinical-graph/procedure-definitions/${encodeURIComponent(stableKey)}/history`
    : `/clinical-graph/custom/${encodeURIComponent(stableKey)}/history`;
  return `${apiBase ?? clinicalGraphApiBase()}${path}?${new URLSearchParams({ patient: patientReference })}`;
}


function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatTrendDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
