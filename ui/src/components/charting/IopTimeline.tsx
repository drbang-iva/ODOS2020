import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";

type Eye = "OD" | "OS";
type ViewMode = "timeline" | "diurnal" | "table";
type RangePreset = "6m" | "1y" | "2y" | "all";
type SeriesMode = "combined" | "method";
type EyeFilter = "both" | Eye;
type GlyphName = "circle" | "square" | "triangle" | "diamond" | "cross" | "open-circle";

interface Props {
  patientReference: string;
  refreshSignal?: unknown;
}

interface DefinitionOption {
  code: string;
  display: string;
  active?: boolean;
}

interface DefinitionField {
  options?: DefinitionOption[];
}

interface IopDefinitionResponse {
  definitions: {
    intraocularPressure: {
      fields: Record<string, DefinitionField>;
    };
  };
}

interface IopReading {
  eye: Eye;
  value: number;
  unit: "mmHg";
  method: { code: string; display: string } | null;
  recordedAt: string;
  recordedBy: string | null;
  observationReference: string;
}

interface CornealHysteresisReading {
  eye: Eye;
  value: number;
  recordedAt: string;
  observationReference: string;
}

interface IopTarget {
  percent: number | null;
  value: number;
  overridden: boolean;
}

interface EyeSummary {
  average: number | null;
  tMax: number | null;
  count: number;
  target: IopTarget | null;
}

interface IopHistoryResponse {
  readings: IopReading[];
  cornealHysteresis: CornealHysteresisReading[];
  perEye: Record<Eye, EyeSummary>;
  threshold: number;
}

interface TimelinePoint extends IopReading {
  xValue: number;
}

interface TimelineSeries {
  key: string;
  eye: Eye;
  label: string;
  methodCode: string | null;
  points: TimelinePoint[];
}

interface DiurnalGroup {
  key: string;
  eye: Eye;
  date: string;
  methodCode: string | null;
  label: string;
  recencyRank: number;
  recencyTotal: number;
  points: Array<IopReading & { minuteOfDay: number }>;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

interface TargetDraft {
  eye: Eye;
  mode: "percent" | "direct";
  percent: string;
  directValue: string;
}

const EYES: Eye[] = ["OD", "OS"];
const EYE_COLORS: Record<Eye, string> = {
  OD: "#3b82f6",
  OS: "#ec4899",
};
const OHTN_COLOR = "#fbbf24";
const GLYPHS: GlyphName[] = ["circle", "square", "triangle", "diamond", "cross", "open-circle"];
const WIDTH = 960;
const MAIN_HEIGHT = 300;
const CH_HEIGHT = 126;
const GAP = 18;
const MARGIN = { top: 24, right: 118, bottom: 34, left: 54 };
const PLOT_LEFT = MARGIN.left;
const PLOT_RIGHT = WIDTH - MARGIN.right;
const MAIN_BOTTOM = MAIN_HEIGHT - MARGIN.bottom;
const MAIN_TOP = MARGIN.top;
const CH_TOP = MAIN_HEIGHT + GAP + 16;
const CH_BOTTOM = CH_TOP + CH_HEIGHT - MARGIN.bottom;
const CH_AXIS_TOP = CH_TOP + 8;

export function IopTimeline({ patientReference, refreshSignal }: Props) {
  const [history, setHistory] = useState<IopHistoryResponse | null>(null);
  const [methodOptions, setMethodOptions] = useState<DefinitionOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("timeline");
  const [range, setRange] = useState<RangePreset>("all");
  const [seriesMode, setSeriesMode] = useState<SeriesMode>("combined");
  const [eyeFilter, setEyeFilter] = useState<EyeFilter>("both");
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [targetDraft, setTargetDraft] = useState<TargetDraft | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`${clinicalGraphApiBase()}/clinical-graph/iop/history?${new URLSearchParams({ patient: patientReference })}`, {
        headers: authHeaders(),
        signal: controller.signal,
      }).then(async (response) => {
        const body = (await response.json()) as IopHistoryResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `IOP history request failed: ${response.status}`);
        return body;
      }),
      fetch(`${clinicalGraphApiBase()}/clinical-graph/iop/definition`, {
        headers: authHeaders(),
        signal: controller.signal,
      }).then(async (response) => {
        const body = (await response.json()) as IopDefinitionResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `IOP definition request failed: ${response.status}`);
        return body;
      }),
    ])
      .then(([historyBody, definitionBody]) => {
        setHistory(historyBody);
        setMethodOptions(activeOptions(definitionBody.definitions.intraocularPressure.fields.method));
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [patientReference, refreshSignal, refreshNonce]);

  const readings = history?.readings ?? [];
  const chReadings = history?.cornealHysteresis ?? [];
  const visibleReadings = useMemo(
    () => applyEyeFilter(applyRange(readings, range), eyeFilter),
    [readings, range, eyeFilter],
  );
  const visibleChReadings = useMemo(
    () => applyEyeFilter(applyRange(chReadings, range), eyeFilter),
    [chReadings, range, eyeFilter],
  );
  const glyphs = useMemo(() => assignMethodGlyphs(methodOptions, readings), [methodOptions, readings]);
  const timelineSeries = useMemo(
    () => splitTimelineSeries(visibleReadings, seriesMode),
    [visibleReadings, seriesMode],
  );
  const diurnalGroups = useMemo(
    () => groupDiurnalReadings(visibleReadings, seriesMode),
    [visibleReadings, seriesMode],
  );
  const hasCh = visibleChReadings.length > 0;
  const svgHeight = hasCh ? CH_BOTTOM + 18 : MAIN_HEIGHT;
  const xDomain = useMemo(
    () => view === "diurnal"
      ? { min: 0, max: 1440 }
      : timeDomain([...visibleReadings, ...visibleChReadings]),
    [view, visibleReadings, visibleChReadings],
  );
  const xScale = useMemo(() => createLinearScale(xDomain.min, xDomain.max, PLOT_LEFT, PLOT_RIGHT), [xDomain]);
  const timelineDateLabel = useMemo(
    () => singleDateLabel([...visibleReadings, ...visibleChReadings]),
    [visibleReadings, visibleChReadings],
  );
  const yDomain = useMemo(
    () => iopYDomain(visibleReadings, history, eyeFilter),
    [visibleReadings, history, eyeFilter],
  );
  const yScale = useMemo(() => createLinearScale(yDomain.min, yDomain.max, MAIN_BOTTOM, MAIN_TOP), [yDomain]);
  const chYScale = useMemo(() => createLinearScale(0, 15, CH_BOTTOM, CH_AXIS_TOP), []);
  const tableRows = useMemo(() => tableReadings(readings, chReadings), [readings, chReadings]);

  function openTargetEditor(eye: Eye) {
    const target = history?.perEye[eye].target;
    const average = history?.perEye[eye].average;
    const percent = target?.percent ?? 20;
    const directValue = target?.value ?? (average === null || average === undefined ? 18 : targetValueFromAverage(average, percent));
    setTargetDraft({
      eye,
      mode: target?.overridden ? "direct" : "percent",
      percent: String(percent),
      directValue: String(roundTenth(directValue)),
    });
  }

  async function saveTarget() {
    if (!targetDraft) return;
    const average = history?.perEye[targetDraft.eye].average;
    const percent = Number(targetDraft.percent);
    const direct = Number(targetDraft.directValue);
    const value = targetDraft.mode === "direct"
      ? direct
      : average === null || average === undefined
        ? NaN
        : targetValueFromAverage(average, percent);
    if (!Number.isFinite(value) || value < 3 || value > 80) {
      setError("Target must be a finite IOP value from 3 to 80 mmHg.");
      return;
    }
    if (targetDraft.mode === "percent" && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
      setError("Target percent must be from 0 to 100.");
      return;
    }

    setSavingTarget(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/iop/target`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          patientReference,
          eye: targetDraft.eye,
          ...(targetDraft.mode === "percent" ? { percent } : {}),
          value: roundTenth(value),
          overridden: targetDraft.mode === "direct",
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `IOP target save failed: ${response.status}`);
      setTargetDraft(null);
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTarget(false);
    }
  }

  function onLegendClick(eye: EyeFilter) {
    if (eye === "both") {
      setEyeFilter("both");
      return;
    }
    if (eyeFilter === eye) {
      openTargetEditor(eye);
    } else {
      setEyeFilter(eye);
    }
  }

  function handlePointerMove(event: React.PointerEvent<SVGRectElement>) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * svgHeight;
    const hover = nearestTooltip({
      x,
      y,
      view,
      xScale,
      readings: visibleReadings,
      chReadings: visibleChReadings,
    });
    setTooltip(hover);
  }

  const empty = !loading && !error && readings.length === 0 && chReadings.length === 0;

  return (
    <div className="mt-6 rounded border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">IOP Timeline</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/50">
            <span className="font-mono">OHTN {history ? `>=${history.threshold}` : ""}</span>
            {EYES.map((eye) => (
              <span key={eye} className="font-mono">
                {eye} avg {formatMetric(history?.perEye[eye].average)} · T-max {formatMetric(history?.perEye[eye].tMax)}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Segmented
            options={[
              ["timeline", "Timeline"],
              ["diurnal", "Diurnal"],
              ["table", "Table"],
            ]}
            value={view}
            onChange={(next) => setView(next as ViewMode)}
          />
          {view === "timeline" && (
            <Segmented
              options={[
                ["6m", "6m"],
                ["1y", "1y"],
                ["2y", "2y"],
                ["all", "All"],
              ]}
              value={range}
              onChange={(next) => setRange(next as RangePreset)}
            />
          )}
          {view !== "table" && (
            <Segmented
              options={[
                ["combined", "Combined"],
                ["method", "By method"],
              ]}
              value={seriesMode}
              onChange={(next) => setSeriesMode(next as SeriesMode)}
            />
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <LegendChip label="Both" active={eyeFilter === "both"} onClick={() => onLegendClick("both")} />
        {EYES.map((eye) => (
          <LegendChip
            key={eye}
            label={eye}
            active={eyeFilter === eye}
            color={EYE_COLORS[eye]}
            target={history?.perEye[eye].target?.value}
            onClick={() => onLegendClick(eye)}
          />
        ))}
        <div className="ml-auto flex flex-wrap gap-2 text-xs text-white/45">
          {methodOptions.map((option) => (
            <span key={option.code} className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1">
              <MiniGlyph glyph={glyphs[option.code] ?? "open-circle"} />
              {option.display}
            </span>
          ))}
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          {error}
        </div>
      )}

      {targetDraft && (
        <div className="mt-4 rounded border border-white/10 bg-bg-deep p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-white">{targetDraft.eye} target</div>
            <button
              type="button"
              onClick={() => setTargetDraft(null)}
              className="h-8 w-8 rounded border border-white/10 text-white/60 hover:bg-white/10"
              aria-label="Close target editor"
            >
              x
            </button>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-2">
              <div className="text-xs uppercase tracking-widest text-white/35">Server Average</div>
              <div className="mt-1 font-mono text-lg text-white">
                {formatMetric(history?.perEye[targetDraft.eye].average)}
              </div>
            </div>
            <div>
              <Segmented
                options={[
                  ["percent", "Percent"],
                  ["direct", "Direct"],
                ]}
                value={targetDraft.mode}
                onChange={(next) => setTargetDraft({ ...targetDraft, mode: next as TargetDraft["mode"] })}
              />
              {targetDraft.mode === "percent" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {[20, 25, 30].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setTargetDraft({ ...targetDraft, percent: String(preset) })}
                      className={[
                        "rounded border px-2 py-1 text-xs",
                        targetDraft.percent === String(preset)
                          ? "border-white/40 bg-white/15 text-white"
                          : "border-white/10 text-white/60 hover:bg-white/10",
                      ].join(" ")}
                    >
                      {preset}%
                    </button>
                  ))}
                  <input
                    value={targetDraft.percent}
                    onChange={(event) => setTargetDraft({ ...targetDraft, percent: event.target.value })}
                    type="number"
                    min={0}
                    max={100}
                    className="h-8 w-20 rounded border border-white/15 bg-bg-deep px-2 font-mono text-sm text-white outline-none focus:border-brand"
                    aria-label="Target percent"
                  />
                  <span className="font-mono text-sm text-white/70">
                    target {formatMetric(computedDraftTarget(targetDraft, history))}
                  </span>
                </div>
              ) : (
                <input
                  value={targetDraft.directValue}
                  onChange={(event) => setTargetDraft({ ...targetDraft, directValue: event.target.value })}
                  type="number"
                  min={3}
                  max={80}
                  step={0.1}
                  className="mt-3 h-9 w-32 rounded border border-white/15 bg-bg-deep px-2 font-mono text-sm text-white outline-none focus:border-brand"
                  aria-label="Direct target mmHg"
                />
              )}
            </div>
            <button
              type="button"
              onClick={saveTarget}
              disabled={savingTarget}
              className="self-end rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {savingTarget ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

      {loading && <div className="mt-6 rounded border border-white/10 bg-bg-deep px-3 py-8 text-center text-sm text-white/55">Loading IOP history...</div>}
      {empty && <div className="mt-6 rounded border border-white/10 bg-bg-deep px-3 py-8 text-center text-sm text-white/55">No IOP history yet — readings chart here as they're captured</div>}

      {!loading && !empty && !error && view === "table" && (
        <IopHistoryTable rows={tableRows} />
      )}

      {!loading && !empty && !error && view !== "table" && history && (
        <div className="relative mt-4">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${svgHeight}`}
            className="block w-full overflow-visible font-mono"
            role="img"
            aria-label="IOP history graph"
            onPointerLeave={() => setTooltip(null)}
          >
            <Grid yScale={yScale} yDomain={yDomain} />
            <AxisLabels yDomain={yDomain} />
            <XAxis view={view} xScale={xScale} xDomain={xDomain} timelineDateLabel={timelineDateLabel} />
            <ReferenceLayer
              history={history}
              eyeFilter={eyeFilter}
              yScale={yScale}
              onTargetClick={openTargetEditor}
            />
            {view === "timeline" ? (
              <TimelineLines series={timelineSeries} xScale={xScale} yScale={yScale} glyphs={glyphs} />
            ) : (
              <DiurnalLines groups={diurnalGroups} xScale={xScale} yScale={yScale} glyphs={glyphs} />
            )}
            {hasCh && (
              <CornealHysteresisPanel
                readings={visibleChReadings}
                view={view}
                xScale={xScale}
                yScale={chYScale}
              />
            )}
            {tooltip && (
              <line
                x1={tooltip.x}
                x2={tooltip.x}
                y1={MAIN_TOP}
                y2={hasCh ? CH_BOTTOM : MAIN_BOTTOM}
                stroke="rgba(255,255,255,0.22)"
                strokeDasharray="4 4"
              />
            )}
            <rect
              x={PLOT_LEFT}
              y={MAIN_TOP}
              width={PLOT_RIGHT - PLOT_LEFT}
              height={(hasCh ? CH_BOTTOM : MAIN_BOTTOM) - MAIN_TOP}
              fill="transparent"
              onPointerMove={handlePointerMove}
            />
          </svg>
          {tooltip && (
            <div
              className="pointer-events-none absolute z-10 max-w-sm rounded border border-white/15 bg-bg-deep px-3 py-2 text-xs text-white shadow-xl"
              style={{
                left: `${Math.min(82, Math.max(4, (tooltip.x / WIDTH) * 100))}%`,
                top: `${Math.min(76, Math.max(6, (tooltip.y / svgHeight) * 100))}%`,
              }}
            >
              <div className="font-semibold">{tooltip.title}</div>
              <div className="mt-1 space-y-1 text-white/70">
                {tooltip.lines.map((line) => <div key={line}>{line}</div>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function createLinearScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) {
  const span = domainMax - domainMin || 1;
  return (value: number) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

export function assignMethodGlyphs(
  methodOptions: readonly DefinitionOption[],
  readings: readonly IopReading[],
): Record<string, GlyphName> {
  const ordered = [
    ...methodOptions.filter((option) => option.active !== false).map((option) => option.code),
    ...readings.flatMap((reading) => reading.method?.code ? [reading.method.code] : []),
  ];
  const unique = [...new Set(ordered)];
  return Object.fromEntries(unique.map((code, index) => [code, GLYPHS[index % GLYPHS.length]]));
}

export function splitTimelineSeries(
  readings: readonly IopReading[],
  mode: SeriesMode,
): TimelineSeries[] {
  const groups = new Map<string, TimelineSeries>();
  for (const reading of [...readings].sort(compareReadingsAsc)) {
    const methodCode = mode === "method" ? reading.method?.code ?? "unknown" : null;
    const key = mode === "method" ? `${reading.eye}:${methodCode}` : reading.eye;
    const label = mode === "method"
      ? `${reading.eye} · ${reading.method?.display ?? "Unknown"}`
      : reading.eye;
    const group = groups.get(key) ?? {
      key,
      eye: reading.eye,
      label,
      methodCode,
      points: [],
    };
    group.points.push({ ...reading, xValue: new Date(reading.recordedAt).getTime() });
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function groupDiurnalReadings(
  readings: readonly IopReading[],
  mode: SeriesMode,
): DiurnalGroup[] {
  const groups = new Map<string, DiurnalGroup>();
  const dates = [...new Set(readings.map((reading) => dateKey(reading.recordedAt)))].sort();
  const recency = new Map(dates.map((date, index) => [date, dates.length - index - 1]));
  for (const reading of [...readings].sort(compareReadingsAsc)) {
    const date = dateKey(reading.recordedAt);
    const methodCode = mode === "method" ? reading.method?.code ?? "unknown" : null;
    const key = [reading.eye, date, methodCode ?? "combined"].join(":");
    const label = mode === "method"
      ? `${reading.eye} · ${reading.method?.display ?? "Unknown"}`
      : reading.eye;
    const group = groups.get(key) ?? {
      key,
      eye: reading.eye,
      date,
      methodCode,
      label,
      recencyRank: recency.get(date) ?? 0,
      recencyTotal: Math.max(dates.length, 1),
      points: [],
    };
    group.points.push({ ...reading, minuteOfDay: minuteOfDay(reading.recordedAt) });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function TimelineLines({
  series,
  xScale,
  yScale,
  glyphs,
}: {
  series: TimelineSeries[];
  xScale: (value: number) => number;
  yScale: (value: number) => number;
  glyphs: Record<string, GlyphName>;
}) {
  return (
    <>
      {series.map((item) => {
        const color = EYE_COLORS[item.eye];
        const points = item.points.map((point) => [xScale(point.xValue), yScale(point.value)] as const);
        const end = points[points.length - 1];
        return (
          <g key={item.key}>
            {points.length > 1 && <polyline points={points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={color} strokeWidth={2} />}
            {points.map(([x, y], index) => (
              <DataMarker
                key={item.points[index].observationReference}
                x={x}
                y={y}
                color={color}
                glyph={glyphs[item.points[index].method?.code ?? ""] ?? "open-circle"}
              />
            ))}
            {end && <text x={Math.min(PLOT_RIGHT + 8, end[0] + 8)} y={end[1] + 4} fill="rgba(255,255,255,0.72)" fontSize={11}>{item.label}</text>}
            {points.length === 1 && end && (
              <text x={end[0] + 10} y={end[1] - 10} fill="rgba(255,255,255,0.72)" fontSize={11}>
                {item.points[0].value}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

function DiurnalLines({
  groups,
  xScale,
  yScale,
  glyphs,
}: {
  groups: DiurnalGroup[];
  xScale: (value: number) => number;
  yScale: (value: number) => number;
  glyphs: Record<string, GlyphName>;
}) {
  return (
    <>
      {groups.map((group) => {
        const color = EYE_COLORS[group.eye];
        const opacity = recencyOpacity(group.recencyRank, group.recencyTotal);
        const points = group.points.map((point) => [xScale(point.minuteOfDay), yScale(point.value)] as const);
        const end = points[points.length - 1];
        return (
          <g key={group.key} opacity={opacity}>
            {points.length > 1 && <polyline points={points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={color} strokeWidth={1.5} />}
            {points.map(([x, y], index) => (
              <DataMarker
                key={group.points[index].observationReference}
                x={x}
                y={y}
                color={color}
                glyph={glyphs[group.points[index].method?.code ?? ""] ?? "open-circle"}
              />
            ))}
            {end && <text x={Math.min(PLOT_RIGHT + 8, end[0] + 8)} y={end[1] + 4} fill="rgba(255,255,255,0.72)" fontSize={11}>{group.label}</text>}
          </g>
        );
      })}
    </>
  );
}

function ReferenceLayer({
  history,
  eyeFilter,
  yScale,
  onTargetClick,
}: {
  history: IopHistoryResponse;
  eyeFilter: EyeFilter;
  yScale: (value: number) => number;
  onTargetClick: (eye: Eye) => void;
}) {
  const isolatedEye = eyeFilter === "OD" || eyeFilter === "OS" ? eyeFilter : null;
  return (
    <>
      <ReferenceLine
        y={yScale(history.threshold)}
        stroke="rgba(251,191,36,0.65)"
        label={`OHTN ≥${history.threshold}`}
        labelColor={OHTN_COLOR}
      />
      {EYES.map((eye) => {
        if (eyeFilter !== "both" && eyeFilter !== eye) return null;
        const summary = history.perEye[eye];
        return (
          <g key={eye}>
            {summary.target && (
              <ReferenceLine
                y={yScale(summary.target.value)}
                stroke={EYE_COLORS[eye]}
                dash="3 5"
                label={`target ${summary.target.value}`}
                onClick={() => onTargetClick(eye)}
              />
            )}
            {summary.average !== null && (
              <MetricTick
                y={yScale(summary.average)}
                color={EYE_COLORS[eye]}
                label={`avg ${summary.average}`}
                full={isolatedEye === eye}
              />
            )}
            {summary.tMax !== null && (
              <MetricTick
                y={yScale(summary.tMax)}
                color={EYE_COLORS[eye]}
                label={`T-max ${summary.tMax}`}
                full={isolatedEye === eye}
              />
            )}
          </g>
        );
      })}
    </>
  );
}

function ReferenceLine({
  y,
  stroke,
  label,
  labelColor,
  dash,
  onClick,
}: {
  y: number;
  stroke: string;
  label: string;
  labelColor?: string;
  dash?: string;
  onClick?: () => void;
}) {
  return (
    <g onClick={onClick} className={onClick ? "cursor-pointer" : undefined}>
      <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={y} y2={y} stroke={stroke} strokeWidth={1} strokeDasharray={dash} />
      <text x={PLOT_RIGHT + 8} y={y + 4} fill={labelColor ?? "rgba(255,255,255,0.72)"} fontSize={11}>{label}</text>
    </g>
  );
}

function MetricTick({ y, color, label, full }: { y: number; color: string; label: string; full: boolean }) {
  return (
    <g>
      {full && <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={y} y2={y} stroke={color} strokeWidth={1} strokeDasharray="2 5" opacity={0.5} />}
      <line x1={PLOT_RIGHT - 8} x2={PLOT_RIGHT} y1={y} y2={y} stroke={color} strokeWidth={2} />
      <text x={PLOT_RIGHT + 8} y={y + 4} fill="rgba(255,255,255,0.72)" fontSize={11}>{label}</text>
    </g>
  );
}

function CornealHysteresisPanel({
  readings,
  view,
  xScale,
  yScale,
}: {
  readings: CornealHysteresisReading[];
  view: ViewMode;
  xScale: (value: number) => number;
  yScale: (value: number) => number;
}) {
  const groups = EYES.map((eye) => ({
    eye,
    points: readings
      .filter((reading) => reading.eye === eye)
      .sort(compareReadingsAsc)
      .map((reading) => ({
        reading,
        x: xScale(view === "diurnal" ? minuteOfDay(reading.recordedAt) : new Date(reading.recordedAt).getTime()),
        y: yScale(reading.value),
      })),
  }));
  return (
    <g>
      <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={CH_AXIS_TOP} y2={CH_AXIS_TOP} stroke="rgba(255,255,255,0.08)" />
      <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={CH_BOTTOM} y2={CH_BOTTOM} stroke="rgba(255,255,255,0.08)" />
      <rect
        x={PLOT_LEFT}
        y={yScale(12)}
        width={PLOT_RIGHT - PLOT_LEFT}
        height={Math.max(1, yScale(6) - yScale(12))}
        fill="rgba(255,255,255,0.05)"
      />
      <text x={PLOT_LEFT} y={CH_TOP - 2} fill="rgba(255,255,255,0.52)" fontSize={11}>CH</text>
      {[0, 6, 12, 15].map((tick) => (
        <g key={tick}>
          <line x1={PLOT_LEFT - 4} x2={PLOT_LEFT} y1={yScale(tick)} y2={yScale(tick)} stroke="rgba(255,255,255,0.18)" />
          <text x={PLOT_LEFT - 10} y={yScale(tick) + 4} textAnchor="end" fill="rgba(255,255,255,0.42)" fontSize={10}>{tick}</text>
        </g>
      ))}
      {groups.map((group) => (
        <g key={group.eye}>
          {group.points.length > 1 && (
            <polyline points={group.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={EYE_COLORS[group.eye]} strokeWidth={2} />
          )}
          {group.points.map((point) => (
            <circle
              key={point.reading.observationReference}
              cx={point.x}
              cy={point.y}
              r={4}
              fill={EYE_COLORS[group.eye]}
              stroke="rgba(10,11,20,0.95)"
              strokeWidth={2}
            />
          ))}
        </g>
      ))}
    </g>
  );
}

function DataMarker({ x, y, color, glyph }: { x: number; y: number; color: string; glyph: GlyphName }) {
  return (
    <g className="group">
      <circle cx={x} cy={y} r={12} fill="transparent" />
      <circle
        cx={x}
        cy={y}
        r={11}
        fill="none"
        stroke="rgba(10,11,20,0.95)"
        strokeWidth={2}
        className="opacity-0 transition-opacity group-hover:opacity-100"
      />
      <MarkerGlyph x={x} y={y} color={color} glyph={glyph} size={9} />
    </g>
  );
}

function MarkerGlyph({ x, y, color, glyph, size }: { x: number; y: number; color: string; glyph: GlyphName; size: number }) {
  const half = size / 2;
  if (glyph === "square") {
    return <rect x={x - half} y={y - half} width={size} height={size} fill={color} stroke="rgba(10,11,20,0.95)" strokeWidth={2} />;
  }
  if (glyph === "triangle") {
    return <path d={`M ${x} ${y - half - 1} L ${x + half + 1} ${y + half} L ${x - half - 1} ${y + half} Z`} fill={color} stroke="rgba(10,11,20,0.95)" strokeWidth={2} />;
  }
  if (glyph === "diamond") {
    return <path d={`M ${x} ${y - half - 1} L ${x + half + 1} ${y} L ${x} ${y + half + 1} L ${x - half - 1} ${y} Z`} fill={color} stroke="rgba(10,11,20,0.95)" strokeWidth={2} />;
  }
  if (glyph === "cross") {
    return (
      <g stroke={color} strokeWidth={3} strokeLinecap="round">
        <line x1={x - half} x2={x + half} y1={y - half} y2={y + half} />
        <line x1={x - half} x2={x + half} y1={y + half} y2={y - half} />
      </g>
    );
  }
  if (glyph === "open-circle") {
    return <circle cx={x} cy={y} r={half} fill="rgba(10,11,20,0.95)" stroke={color} strokeWidth={2.5} />;
  }
  return <circle cx={x} cy={y} r={half} fill={color} stroke="rgba(10,11,20,0.95)" strokeWidth={2} />;
}

function MiniGlyph({ glyph }: { glyph: GlyphName }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
      <MarkerGlyph x={8} y={8} color="rgba(255,255,255,0.72)" glyph={glyph} size={7} />
    </svg>
  );
}

function Grid({ yScale, yDomain }: { yScale: (value: number) => number; yDomain: { min: number; max: number } }) {
  const ticks = yTicks(yDomain.min, yDomain.max);
  return (
    <g>
      <rect x={PLOT_LEFT} y={MAIN_TOP} width={PLOT_RIGHT - PLOT_LEFT} height={MAIN_BOTTOM - MAIN_TOP} fill="rgba(255,255,255,0.01)" />
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={yScale(tick)} y2={yScale(tick)} stroke="rgba(255,255,255,0.08)" />
          <text x={PLOT_LEFT - 10} y={yScale(tick) + 4} textAnchor="end" fill="rgba(255,255,255,0.42)" fontSize={10}>{tick}</text>
        </g>
      ))}
      <line x1={PLOT_LEFT} x2={PLOT_LEFT} y1={MAIN_TOP} y2={MAIN_BOTTOM} stroke="rgba(255,255,255,0.12)" />
      <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={MAIN_BOTTOM} y2={MAIN_BOTTOM} stroke="rgba(255,255,255,0.12)" />
    </g>
  );
}

function AxisLabels({ yDomain }: { yDomain: { min: number; max: number } }) {
  return (
    <g>
      <text x={PLOT_LEFT} y={MAIN_TOP - 8} fill="rgba(255,255,255,0.45)" fontSize={11}>mmHg</text>
      <text x={PLOT_RIGHT} y={MAIN_BOTTOM + 24} textAnchor="end" fill="rgba(255,255,255,0.38)" fontSize={10}>
        {yDomain.min}-{yDomain.max}
      </text>
    </g>
  );
}

function XAxis({
  view,
  xScale,
  xDomain,
  timelineDateLabel,
}: {
  view: ViewMode;
  xScale: (value: number) => number;
  xDomain: { min: number; max: number };
  timelineDateLabel: string | null;
}) {
  const ticks = view === "diurnal"
    ? [
      { value: 0, label: "12a" },
      { value: 360, label: "6a" },
      { value: 720, label: "12p" },
      { value: 1080, label: "6p" },
      { value: 1440, label: "12a" },
    ]
    : timelineDateLabel || xDomain.min === xDomain.max
      ? [{ value: (xDomain.min + xDomain.max) / 2, label: timelineDateLabel ?? formatDate(new Date(xDomain.min).toISOString()) }]
      : Array.from({ length: 5 }, (_, index) => {
        const value = xDomain.min + ((xDomain.max - xDomain.min) * index) / 4;
        return { value, label: formatDate(new Date(value).toISOString()) };
      });
  return (
    <g>
      {ticks.map((tick, index) => {
        const x = ticks.length === 1 ? (PLOT_LEFT + PLOT_RIGHT) / 2 : xScale(tick.value);
        const textAnchor = ticks.length === 1 ? "middle" : index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle";
        return (
          <g key={tick.value}>
            <line x1={x} x2={x} y1={MAIN_BOTTOM} y2={MAIN_BOTTOM + 4} stroke="rgba(255,255,255,0.18)" />
            <text x={x} y={MAIN_BOTTOM + 14} textAnchor={textAnchor} fill="rgba(255,255,255,0.42)" fontSize={10}>{tick.label}</text>
          </g>
        );
      })}
    </g>
  );
}

function IopHistoryTable({ rows }: { rows: Array<IopReading & { chValue: number | null }> }) {
  return (
    <div className="mt-4 overflow-x-auto rounded border border-white/10">
      <table className="w-full min-w-[760px] table-fixed border-collapse text-left text-xs">
        <thead className="bg-white/[0.04] text-white/45">
          <tr>
            {["Date", "Time", "Eye", "mmHg", "Method", "CH", "Recorded-by"].map((heading) => (
              <th key={heading} className="border-b border-white/10 px-3 py-2 font-medium">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody className="text-white/75">
          {rows.map((row) => (
            <tr key={row.observationReference} className="border-b border-white/5 last:border-b-0">
              <td className="px-3 py-2">{formatDate(row.recordedAt)}</td>
              <td className="px-3 py-2 font-mono">{formatTime(row.recordedAt)}</td>
              <td className="px-3 py-2 font-semibold">{row.eye}</td>
              <td className="px-3 py-2 font-mono">{row.value}</td>
              <td className="px-3 py-2">{row.method?.display ?? "Unknown"}</td>
              <td className="px-3 py-2 font-mono">{row.chValue ?? ""}</td>
              <td className="px-3 py-2">{row.recordedBy ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<[string, string]>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex rounded border border-white/10 bg-bg-deep p-0.5">
      {options.map(([optionValue, label]) => (
        <button
          key={optionValue}
          type="button"
          onClick={() => onChange(optionValue)}
          className={[
            "h-8 px-3 text-xs font-medium transition",
            optionValue === value
              ? "bg-white/15 text-white"
              : "text-white/55 hover:bg-white/10 hover:text-white",
          ].join(" ")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function LegendChip({
  label,
  active,
  color,
  target,
  onClick,
}: {
  label: string;
  active: boolean;
  color?: string;
  target?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex h-8 items-center gap-2 rounded border px-3 text-xs font-medium transition",
        active
          ? "border-white/35 bg-white/15 text-white"
          : "border-white/10 text-white/60 hover:bg-white/10 hover:text-white",
      ].join(" ")}
      title={color ? "Click once to isolate; click again to set target" : undefined}
    >
      {color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />}
      {label}
      {target !== undefined && <span className="font-mono text-white/45">target {target}</span>}
    </button>
  );
}

function nearestTooltip(input: {
  x: number;
  y: number;
  view: ViewMode;
  xScale: (value: number) => number;
  readings: readonly IopReading[];
  chReadings: readonly CornealHysteresisReading[];
}): TooltipState | null {
  const candidates = [
    ...input.readings.map((reading) => ({
      key: reading.recordedAt,
      x: input.xScale(input.view === "diurnal" ? minuteOfDay(reading.recordedAt) : new Date(reading.recordedAt).getTime()),
    })),
    ...input.chReadings.map((reading) => ({
      key: reading.recordedAt,
      x: input.xScale(input.view === "diurnal" ? minuteOfDay(reading.recordedAt) : new Date(reading.recordedAt).getTime()),
    })),
  ];
  const nearest = candidates
    .map((candidate) => ({ ...candidate, distance: Math.abs(candidate.x - input.x) }))
    .sort((a, b) => a.distance - b.distance)[0];
  if (!nearest || nearest.distance > 36) return null;
  const sameMoment = (recordedAt: string) => input.view === "diurnal"
    ? dateKey(recordedAt) === dateKey(nearest.key) && minuteOfDay(recordedAt) === minuteOfDay(nearest.key)
    : recordedAt === nearest.key;
  const readings = input.readings.filter((reading) => sameMoment(reading.recordedAt));
  const chReadings = input.chReadings.filter((reading) => sameMoment(reading.recordedAt));
  return {
    x: nearest.x,
    y: input.y,
    title: `${formatDate(nearest.key)} · ${formatTime(nearest.key)}`,
    lines: [
      ...readings.map((reading) =>
        `${reading.eye} ${reading.value} ${reading.method?.display ?? ""}${reading.recordedBy ? ` · ${reading.recordedBy}` : ""}`,
      ),
      ...chReadings.map((reading) => `CH ${reading.eye} ${reading.value}`),
    ],
  };
}

function iopYDomain(
  readings: readonly IopReading[],
  history: IopHistoryResponse | null,
  eyeFilter: EyeFilter,
): { min: number; max: number } {
  const values = [
    8,
    26,
    ...(history ? [history.threshold] : []),
    ...readings.map((reading) => reading.value),
    ...EYES.flatMap((eye) => {
      if (eyeFilter !== "both" && eyeFilter !== eye) return [];
      const summary = history?.perEye[eye];
      return [
        summary?.average,
        summary?.tMax,
        summary?.target?.value,
      ].filter((value): value is number => typeof value === "number");
    }),
  ];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max(2, (max - min) * 0.12);
  return {
    min: Math.max(0, Math.floor(min - padding)),
    max: Math.ceil(max + padding),
  };
}

function timeDomain(items: ReadonlyArray<{ recordedAt: string }>): { min: number; max: number } {
  const times = items.map((item) => new Date(item.recordedAt).getTime()).filter(Number.isFinite);
  if (times.length === 0) {
    const now = Date.now();
    return { min: now - 86_400_000, max: now + 86_400_000 };
  }
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (min === max) return { min: min - 86_400_000, max: max + 86_400_000 };
  const padding = Math.max(3_600_000, (max - min) * 0.04);
  return { min: min - padding, max: max + padding };
}

function applyRange<T extends { recordedAt: string }>(items: readonly T[], range: RangePreset): T[] {
  if (range === "all" || items.length === 0) return [...items];
  const newest = Math.max(...items.map((item) => new Date(item.recordedAt).getTime()).filter(Number.isFinite));
  const months = range === "6m" ? 6 : range === "1y" ? 12 : 24;
  const start = new Date(newest);
  start.setMonth(start.getMonth() - months);
  return items.filter((item) => new Date(item.recordedAt).getTime() >= start.getTime());
}

function applyEyeFilter<T extends { eye: Eye }>(items: readonly T[], eyeFilter: EyeFilter): T[] {
  return eyeFilter === "both" ? [...items] : items.filter((item) => item.eye === eyeFilter);
}

function tableReadings(
  readings: readonly IopReading[],
  chReadings: readonly CornealHysteresisReading[],
): Array<IopReading & { chValue: number | null }> {
  const chByEyeMoment = new Map(chReadings.map((reading) => [`${reading.eye}:${reading.recordedAt}`, reading.value]));
  return [...readings]
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .map((reading) => ({
      ...reading,
      chValue: chByEyeMoment.get(`${reading.eye}:${reading.recordedAt}`) ?? null,
    }));
}

function yTicks(min: number, max: number): number[] {
  const step = Math.max(2, Math.ceil((max - min) / 5));
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= max; value += step) ticks.push(value);
  return ticks;
}

function activeOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return (field?.options ?? []).filter((option) => option.active !== false);
}

function compareReadingsAsc(a: { recordedAt: string; observationReference: string }, b: { recordedAt: string; observationReference: string }): number {
  return a.recordedAt.localeCompare(b.recordedAt) || a.observationReference.localeCompare(b.observationReference);
}

function minuteOfDay(recordedAt: string): number {
  const date = new Date(recordedAt);
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function dateKey(recordedAt: string): string {
  const date = new Date(recordedAt);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function singleDateLabel(items: ReadonlyArray<{ recordedAt: string }>): string | null {
  if (items.length === 0) return null;
  const dates = new Set(items.map((item) => dateKey(item.recordedAt)));
  return dates.size === 1 ? formatDate(items[0].recordedAt) : null;
}

function recencyOpacity(rank: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - (rank / (total - 1)) * 0.65;
}

function formatDate(recordedAt: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(recordedAt));
}

function formatTime(recordedAt: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(recordedAt));
}

function formatMetric(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "--";
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function targetValueFromAverage(average: number, percent: number): number {
  return roundTenth(average * (1 - percent / 100));
}

function computedDraftTarget(draft: TargetDraft, history: IopHistoryResponse | null): number | null {
  if (draft.mode === "direct") {
    const value = Number(draft.directValue);
    return Number.isFinite(value) ? value : null;
  }
  const average = history?.perEye[draft.eye].average;
  const percent = Number(draft.percent);
  return average === null || average === undefined || !Number.isFinite(percent)
    ? null
    : targetValueFromAverage(average, percent);
}
