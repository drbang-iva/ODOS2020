import { useMemo } from "react";

export type MyopiaReferencePopulation = "ASIAN" | "CAUCASIAN" | "NOT_REPRESENTED";
export type MyopiaEye = "OD" | "OS";

export interface AxialGrowthReading {
  eye: MyopiaEye;
  axialLengthMm: number;
  cornealRadiusMm: number | null;
  ageInYears: number;
  measuredAt: string;
  biometryMethod: "OPTICAL_BIOMETRY" | "ULTRASOUND_A_SCAN";
  instrument: string | null;
  observationReference: string;
}

export interface AxialGrowthRate {
  eye: MyopiaEye;
  status: "AVAILABLE" | "INTERVAL_TOO_SHORT" | "BIOMETRY_METHOD_CHANGED";
  earlierMeasuredAt: string;
  laterMeasuredAt: string;
  intervalYears: number;
  biometryMethod: AxialGrowthReading["biometryMethod"] | null;
  mmPerYear: number | null;
  classification: "NORMAL" | "WATCH" | "FLAG" | null;
}

export interface AxialGrowthReferenceDataset {
  datasetId: string;
  version: string;
  citation: string;
  populationNote: string;
  medianRepresentsHealthy: boolean;
  ageRangeMin: number;
  ageRangeMax: number;
  percentiles: number[];
  zoneThresholds: {
    neutralUpper: number;
    typicalUpper: number;
    borderlineUpper: number;
  };
  rows: Array<{ age: number; values: number[] }>;
}

interface Props {
  readings: AxialGrowthReading[];
  growthRates?: AxialGrowthRate[];
  referenceDataset: AxialGrowthReferenceDataset | null;
  noReferenceMessage: string | null;
}

const WIDTH = 840;
const HEIGHT = 370;
const MARGIN = { top: 24, right: 32, bottom: 48, left: 58 };
const EYE_STYLE = {
  OD: { stroke: "#60a5fa", fill: "#1d4ed8" },
  OS: { stroke: "#f472b6", fill: "#be185d" },
} as const;
const RATE_STYLE = {
  NORMAL: { color: "#22c55e", label: "NORMAL GROWTH" },
  WATCH: { color: "#eab308", label: "WATCH GROWTH" },
  FLAG: { color: "#ef4444", label: "ACCELERATED GROWTH" },
} as const;

export function AxialGrowthChart({
  readings,
  growthRates = [],
  referenceDataset,
  noReferenceMessage,
}: Props) {
  const plot = useMemo(
    () => chartModel(readings, referenceDataset),
    [readings, referenceDataset],
  );

  return (
    <div>
      <div className="overflow-x-auto rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-3">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="min-w-[700px] text-[color:var(--odos-text)]"
          role="img"
          aria-label="Axial length growth chart"
          data-reference-band-count={referenceDataset?.percentiles.length ?? 0}
        >
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={plot.plotWidth}
            height={plot.plotHeight}
            fill="currentColor"
            fillOpacity="0.025"
          />
          {plot.zones.map((zone) => (
            <polygon
              key={zone.id}
              points={zone.points}
              fill={zone.color}
              fillOpacity={zone.opacity}
              data-centile-zone={zone.id}
            >
              <title>{zone.label}</title>
            </polygon>
          ))}
          {plot.yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line
                x1={MARGIN.left}
                x2={WIDTH - MARGIN.right}
                y1={plot.y(tick)}
                y2={plot.y(tick)}
                stroke="currentColor"
                strokeOpacity="0.1"
              />
              <text x={MARGIN.left - 9} y={plot.y(tick) + 4} textAnchor="end" fill="currentColor" opacity="0.7" fontSize="12">
                {tick.toFixed(1)}
              </text>
            </g>
          ))}
          {plot.xTicks.map((tick) => (
            <g key={`x-${tick}`}>
              <line
                x1={plot.x(tick)}
                x2={plot.x(tick)}
                y1={MARGIN.top}
                y2={HEIGHT - MARGIN.bottom}
                stroke="currentColor"
                strokeOpacity="0.06"
              />
              <text x={plot.x(tick)} y={HEIGHT - MARGIN.bottom + 22} textAnchor="middle" fill="currentColor" opacity="0.7" fontSize="12">
                {tick}
              </text>
            </g>
          ))}
          {plot.referenceLines.map((line) => (
            <polyline
              key={`p-${line.percentile}`}
              points={line.points}
              fill="none"
              stroke="currentColor"
              strokeOpacity={line.percentile === 50 ? 0.48 : 0.22}
              strokeWidth={line.percentile === 50 ? 2 : 1}
              data-percentile={line.percentile}
            >
              <title>{`P${line.percentile}`}</title>
            </polyline>
          ))}
          {(["OD", "OS"] as const).map((eye) => {
            const points = plot.patientPoints.filter((point) => point.eye === eye);
            return (
              <g key={eye} data-patient-series={eye}>
                {points.length > 1 && (
                  <polyline
                    points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                    fill="none"
                    stroke={EYE_STYLE[eye].stroke}
                    strokeWidth="2.5"
                    data-patient-trend={eye}
                  />
                )}
                {points.map((point) => (
                  <circle
                    key={point.observationReference}
                    cx={point.x}
                    cy={point.y}
                    r="4.5"
                    fill={EYE_STYLE[eye].fill}
                    stroke={EYE_STYLE[eye].stroke}
                    strokeWidth="2"
                    data-patient-point={eye}
                  >
                    <title>{`${eye} · age ${point.ageInYears.toFixed(2)} · ${point.axialLengthMm.toFixed(2)} mm · ${methodLabel(point.biometryMethod)}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
          <text x={WIDTH / 2} y={HEIGHT - 8} textAnchor="middle" fill="currentColor" opacity="0.75" fontSize="13">
            Age (years)
          </text>
          <text
            x="16"
            y={HEIGHT / 2}
            textAnchor="middle"
            fill="currentColor"
            opacity="0.75"
            fontSize="13"
            transform={`rotate(-90 16 ${HEIGHT / 2})`}
          >
            Axial length (mm)
          </text>
        </svg>
        <div className="mt-2 flex gap-4 text-xs text-[color:var(--odos-muted)]">
          <span><span className="mr-1 inline-block h-2 w-4 rounded bg-blue-400" />OD</span>
          <span><span className="mr-1 inline-block h-2 w-4 rounded bg-pink-400" />OS</span>
          {referenceDataset && (
            <span data-percentile-labels={referenceDataset.percentiles.join(",")}>
              Reference percentiles P{referenceDataset.percentiles.join(" · P")}
            </span>
          )}
        </div>
      </div>

      {referenceDataset && (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--odos-muted)]">
            Eye length vs age-matched peers
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold text-[color:var(--odos-text)]">
            {plot.zones.map((zone) => (
              <span
                key={zone.id}
                className="inline-flex items-center gap-1.5 rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] px-2 py-1"
                data-zone-label={zone.id}
              >
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: zone.color }} />
                {zone.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {growthRates.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--odos-muted)]">
            Latest axial growth rate
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {growthRates.map((rate) => (
              <GrowthRateCard key={rate.eye} rate={rate} />
            ))}
          </div>
        </div>
      )}

      {referenceDataset ? (
        <div className="mt-3 rounded border border-[color:var(--odos-accent-border)] bg-[var(--odos-accent-tint-lo)] p-3 text-xs leading-5 text-[color:var(--odos-muted)]">
          <div>{referenceDataset.citation}</div>
          <div className="mt-1 font-medium text-[color:var(--odos-text)]">{referenceDataset.populationNote}</div>
        </div>
      ) : (
        <div className="mt-3 rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-3 text-sm text-[color:var(--odos-muted)]">
          {noReferenceMessage ?? "Patient measurements are shown without reference bands."}
        </div>
      )}
    </div>
  );
}

function GrowthRateCard({ rate }: { rate: AxialGrowthRate }) {
  if (
    rate.status === "AVAILABLE" &&
    rate.mmPerYear !== null &&
    rate.classification !== null &&
    rate.biometryMethod !== null
  ) {
    const style = RATE_STYLE[rate.classification];
    return (
      <div
        className="rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-3"
        data-growth-rate-eye={rate.eye}
        data-growth-rate-status={rate.classification}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-[color:var(--odos-text)]">{rate.eye}</span>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: style.color }}>
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: style.color }} />
            {style.label}
          </span>
        </div>
        <div className="mt-1 text-xl font-semibold" style={{ color: style.color }}>
          {formatGrowthRate(rate.mmPerYear)} mm/year
        </div>
        <div className="mt-1 text-xs text-[color:var(--odos-muted)]">
          {dateLabel(rate.earlierMeasuredAt)} to {dateLabel(rate.laterMeasuredAt)} · {methodLabel(rate.biometryMethod)}
        </div>
      </div>
    );
  }
  const message = rate.status === "INTERVAL_TOO_SHORT"
    ? `Rate needs at least 6 months between consecutive ${rate.eye} measurements.`
    : `Rate is not calculated because consecutive ${rate.eye} measurements use different biometry methods.`;
  return (
    <div
      className="rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-3 text-sm text-[color:var(--odos-muted)]"
      data-growth-rate-eye={rate.eye}
      data-growth-rate-status={rate.status}
    >
      <span className="font-semibold text-[color:var(--odos-text)]">{rate.eye}</span>
      <span className="ml-2">{message}</span>
    </div>
  );
}

function formatGrowthRate(value: number): string {
  if (value > 0) return `+${value.toFixed(2)}`;
  if (value < 0) return `−${Math.abs(value).toFixed(2)}`;
  return "0.00";
}

function dateLabel(value: string): string {
  return value.slice(0, 10);
}

function chartModel(
  readings: AxialGrowthReading[],
  referenceDataset: AxialGrowthReferenceDataset | null,
) {
  const referenceRows = [...(referenceDataset?.rows ?? [])]
    .sort((left, right) => left.age - right.age);
  const referenceValues = referenceRows.flatMap((row) => row.values);
  const referenceAges = referenceRows.map((row) => row.age);
  const patientValues = readings.map((reading) => reading.axialLengthMm);
  const patientAges = readings.map((reading) => reading.ageInYears);
  const allAges = [...referenceAges, ...patientAges];
  const allValues = [...referenceValues, ...patientValues];
  const minAge = allAges.length ? Math.min(...allAges) : 4;
  const maxAge = allAges.length ? Math.max(...allAges) : 18;
  const rawMin = allValues.length ? Math.min(...allValues) : 20;
  const rawMax = allValues.length ? Math.max(...allValues) : 28;
  const minValue = Math.floor((rawMin - 0.5) * 2) / 2;
  const maxValue = Math.ceil((rawMax + 0.5) * 2) / 2;
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (age: number) => MARGIN.left + ((age - minAge) / Math.max(1, maxAge - minAge)) * plotWidth;
  const y = (value: number) => MARGIN.top + ((maxValue - value) / Math.max(0.5, maxValue - minValue)) * plotHeight;
  const referenceLines = (referenceDataset?.percentiles ?? []).map((percentile, index) => ({
    percentile,
    points: referenceRows
      .map((row) => `${x(row.age)},${y(row.values[index]!)}`)
      .join(" "),
  }));
  const zones = referenceDataset
    ? centileZones(referenceDataset, x, y, minValue, maxValue)
    : [];
  const patientPoints = readings
    .map((reading) => ({ ...reading, x: x(reading.ageInYears), y: y(reading.axialLengthMm) }))
    .sort((left, right) => left.ageInYears - right.ageInYears);
  const xTicks = integerTicks(Math.ceil(minAge), Math.floor(maxAge), 2);
  const yTicks = decimalTicks(minValue, maxValue, 1);
  return { plotWidth, plotHeight, x, y, xTicks, yTicks, referenceLines, zones, patientPoints };
}

function centileZones(
  dataset: AxialGrowthReferenceDataset,
  x: (age: number) => number,
  y: (value: number) => number,
  minValue: number,
  maxValue: number,
) {
  const rows = [...dataset.rows].sort((left, right) => left.age - right.age);
  const firstAge = rows[0]?.age;
  const lastAge = rows.at(-1)?.age;
  if (firstAge === undefined || lastAge === undefined) return [];
  const indexFor = (percentile: number) => dataset.percentiles.indexOf(percentile);
  const p25 = indexFor(dataset.zoneThresholds.neutralUpper);
  const p50 = indexFor(dataset.zoneThresholds.typicalUpper);
  const p75 = indexFor(dataset.zoneThresholds.borderlineUpper);
  if ([p25, p50, p75].some((index) => index < 0)) return [];
  const curve = (index: number) => rows.map((row) => `${x(row.age)},${y(row.values[index]!)}`);
  const band = (lowerIndex: number, upperIndex: number) =>
    [...curve(lowerIndex), ...curve(upperIndex).reverse()].join(" ");
  return [
    {
      id: "neutral",
      label: "SHORTER THAN TYPICAL",
      color: "#64748b",
      opacity: 0.14,
      points: [`${x(firstAge)},${y(minValue)}`, ...curve(p25), `${x(lastAge)},${y(minValue)}`].join(" "),
    },
    {
      id: "typical",
      label: dataset.medianRepresentsHealthy ? "TYPICAL LENGTH" : "TYPICAL FOR COHORT",
      color: dataset.medianRepresentsHealthy ? "#22c55e" : "#eab308",
      opacity: 0.48,
      points: band(p25, p50),
    },
    {
      id: "borderline",
      label: "BORDERLINE LENGTH",
      color: "#eab308",
      opacity: 0.48,
      points: band(p50, p75),
    },
    {
      id: "excessive",
      label: "EXCESSIVE LENGTH",
      color: "#ef4444",
      opacity: 0.48,
      points: [...curve(p75), `${x(lastAge)},${y(maxValue)}`, `${x(firstAge)},${y(maxValue)}`].join(" "),
    },
  ];
}

function integerTicks(min: number, max: number, step: number): number[] {
  const values = [];
  for (let value = min; value <= max; value += step) values.push(value);
  return values;
}

function decimalTicks(min: number, max: number, step: number): number[] {
  const values = [];
  for (let value = min; value <= max + 1e-9; value += step) values.push(value);
  return values;
}

function methodLabel(method: AxialGrowthReading["biometryMethod"]): string {
  return method === "OPTICAL_BIOMETRY" ? "Optical biometry" : "Ultrasound A-scan";
}
