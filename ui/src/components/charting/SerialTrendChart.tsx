export interface SerialTrendPoint { id: string; x: number; value: number; title: string }
export interface SerialTrendSeries { id: string; label: string; color: string; points: SerialTrendPoint[] }
type Bound = number | ((x: number) => number);
export type SerialTrendOverlay =
  | { kind: "line"; id: string; label: string; value: Bound; color: string }
  | { kind: "band"; id: string; label: string; lower: Bound; upper: Bound; color: string; opacity?: number };

interface Props {
  ariaLabel: string;
  series: SerialTrendSeries[];
  overlays?: SerialTrendOverlay[];
  xDomain?: [number, number];
  yDomain?: [number, number];
  xSamples?: number[];
  xFormat: (value: number) => string;
  yFormat: (value: number) => string;
  emptyText?: string;
}

const WIDTH = 760;
const HEIGHT = 260;
const PAD = 36;

export function SerialTrendChart({ ariaLabel, series, overlays = [], xDomain, yDomain, xSamples, xFormat, yFormat, emptyText = "No readings recorded" }: Props) {
  const points = series.flatMap((row) => row.points);
  if (points.length === 0) return <div role="img" aria-label={ariaLabel} className="rounded border border-white/10 p-6 text-sm text-white/55">{emptyText}</div>;
  const xs = points.map((point) => point.x);
  const sampleXs = [...new Set([...(xSamples ?? []), ...xs])].sort((a, b) => a - b);
  const overlayValues = overlays.flatMap((overlay) => overlay.kind === "line"
    ? sampleXs.map((x) => at(overlay.value, x))
    : sampleXs.flatMap((x) => [at(overlay.lower, x), at(overlay.upper, x)]));
  const [xMin, xMax] = xDomain ?? paddedDomain(xs);
  const [yMin, yMax] = yDomain ?? paddedDomain([...points.map((point) => point.value), ...overlayValues]);
  const xAt = (x: number) => PAD + (x - xMin) / safeSpan(xMin, xMax) * (WIDTH - PAD * 2);
  const yAt = (y: number) => HEIGHT - PAD - (y - yMin) / safeSpan(yMin, yMax) * (HEIGHT - PAD * 2);
  const linePath = (bound: Bound) => sampleXs.map((x, index) => `${index ? "L" : "M"}${xAt(x)},${yAt(at(bound, x))}`).join(" ");
  const bandPath = (lower: Bound, upper: Bound) => [
    ...sampleXs.map((x, index) => `${index ? "L" : "M"}${xAt(x)},${yAt(at(upper, x))}`),
    ...[...sampleXs].reverse().map((x) => `L${xAt(x)},${yAt(at(lower, x))}`),
    "Z",
  ].join(" ");
  return (
    <figure role="img" aria-label={ariaLabel} className="rounded border border-white/10 bg-white/[0.02] p-3">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" aria-hidden="true">
        <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} stroke="#64748b" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={HEIGHT - PAD} stroke="#64748b" />
        {overlays.map((overlay) => overlay.kind === "band"
          ? <path key={overlay.id} d={bandPath(overlay.lower, overlay.upper)} fill={overlay.color} opacity={overlay.opacity ?? 0.16}><title>{overlay.label}</title></path>
          : <path key={overlay.id} d={linePath(overlay.value)} fill="none" stroke={overlay.color} strokeDasharray="6 4"><title>{overlay.label}</title></path>)}
        {series.map((row) => <g key={row.id}>{row.points.map((point) => <circle key={point.id} cx={xAt(point.x)} cy={yAt(point.value)} r="5" fill={row.color}><title>{point.title}</title></circle>)}</g>)}
        <text x={PAD} y={HEIGHT - 8} fill="#94a3b8" fontSize="11">{xFormat(xMin)}</text>
        <text x={WIDTH - PAD} y={HEIGHT - 8} fill="#94a3b8" fontSize="11" textAnchor="end">{xFormat(xMax)}</text>
        <text x={4} y={PAD} fill="#94a3b8" fontSize="11">{yFormat(yMax)}</text>
        <text x={4} y={HEIGHT - PAD} fill="#94a3b8" fontSize="11">{yFormat(yMin)}</text>
      </svg>
      <figcaption className="flex flex-wrap gap-3 text-xs text-white/70">
        {series.map((row) => <span key={row.id}><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: row.color }} />{row.label}</span>)}
        {overlays.map((overlay) => <span key={overlay.id}><i className="mr-1 inline-block h-2 w-4" style={{ background: overlay.color }} />{overlay.label}</span>)}
      </figcaption>
    </figure>
  );
}

function at(bound: Bound, x: number): number { return typeof bound === "function" ? bound(x) : bound; }
function safeSpan(min: number, max: number): number { return max === min ? 1 : max - min; }
function paddedDomain(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.08, 1);
  return [min - pad, max + pad];
}
