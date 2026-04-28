import type {
  Bundle,
  DiagnosticReport,
  EpisodeOfCare,
  Observation,
  Quantity,
  Reference,
  Resource,
} from "@medplum/fhirtypes";

export interface ObservationHistoryFilters {
  code: string;
  eye?: string;
  dateRange?: DateRangeInput;
  focusReference?: string;
}

export interface DateRangeInput {
  start?: string;
  end?: string;
}

export interface ProgressionSummary {
  count: number;
  code: string;
  eye?: string;
  first?: MeasurementPoint;
  last?: MeasurementPoint;
  slopePerYear?: number;
  rSquared?: number;
  notableChangeEvents: NotableChangeEvent[];
}

export interface MeasurementPoint {
  observationId?: string;
  effectiveDateTime: string;
  value: number;
  unit?: string;
}

export interface NotableChangeEvent {
  fromObservationId?: string;
  toObservationId?: string;
  fromEffectiveDateTime: string;
  toEffectiveDateTime: string;
  delta: number;
  absoluteDelta: number;
  unit?: string;
}

export interface GroupedDiagnosticReport {
  diagnosticReport: DiagnosticReport;
  observations: Observation[];
  linkedResources: Array<Reference<Resource>>;
}

export interface TreatmentEpisodeSummary {
  episode: EpisodeOfCare;
  observationCount: number;
  firstObservationDate?: string;
  lastObservationDate?: string;
  observationCodes: string[];
}

export function buildObservationSearchParams(input: {
  patientReference: string;
  filters: ObservationHistoryFilters;
  count?: number;
}): Record<string, string> {
  const params: Record<string, string> = {
    subject: input.patientReference,
    code: input.filters.code,
    _sort: "date",
    _count: String(input.count ?? 200),
  };

  if (input.filters.dateRange?.start) {
    params.date = `ge${input.filters.dateRange.start}`;
  }
  if (input.filters.dateRange?.end) {
    params.date = params.date
      ? `${params.date},le${input.filters.dateRange.end}`
      : `le${input.filters.dateRange.end}`;
  }
  if (input.filters.focusReference) {
    params.focus = input.filters.focusReference;
  }

  return params;
}

export function observationHistoryFromBundle(
  bundle: Bundle<Observation>,
  filters: ObservationHistoryFilters,
): Observation[] {
  return sortObservationsByEffective(
    (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((resource): resource is Observation => resource?.resourceType === "Observation")
      .filter((observation) => observationMatchesCode(observation, filters.code))
      .filter((observation) => observationMatchesEye(observation, filters.eye))
      .filter((observation) => observationMatchesDateRange(observation, filters.dateRange))
      .filter((observation) => observationMatchesFocus(observation, filters.focusReference)),
  );
}

export function sortObservationsByEffective(observations: Observation[]): Observation[] {
  return [...observations].sort(
    (left, right) => effectiveMillis(left) - effectiveMillis(right),
  );
}

export function summarizeProgression(
  observations: Observation[],
  code: string,
  eye?: string,
): ProgressionSummary {
  const points = observations
    .map((observation) => measurementPointFromObservation(observation))
    .filter((point): point is MeasurementPoint => point !== undefined)
    .sort((left, right) =>
      Date.parse(left.effectiveDateTime) - Date.parse(right.effectiveDateTime),
    );

  const slope = linearSlopePerYear(points);
  return {
    count: points.length,
    code,
    ...(eye ? { eye } : {}),
    ...(points[0] ? { first: points[0] } : {}),
    ...(points[points.length - 1] ? { last: points[points.length - 1] } : {}),
    ...(slope ? { slopePerYear: slope.slopePerYear, rSquared: slope.rSquared } : {}),
    notableChangeEvents: notableChangeEvents(points),
  };
}

export function groupedDiagnosticReport(
  report: DiagnosticReport,
  observations: Observation[],
): GroupedDiagnosticReport {
  const linkedResources = [
    ...(report.result ?? []),
    ...(report.media ?? []).flatMap((media) => (media.link ? [media.link] : [])),
    ...(report.presentedForm ?? []).flatMap((attachment) =>
      attachment.url ? [{ reference: attachment.url }] : [],
    ),
  ] as Array<Reference<Resource>>;

  return { diagnosticReport: report, observations, linkedResources };
}

export function compareTreatmentEpisodes(
  episodes: EpisodeOfCare[],
  observations: Observation[],
): TreatmentEpisodeSummary[] {
  return episodes.map((episode) => {
    const observationCodes = new Set<string>();
    const episodeObservations = observations.filter((observation) => {
      for (const coding of observation.code.coding ?? []) {
        if (coding.code) {
          observationCodes.add(coding.system ? `${coding.system}|${coding.code}` : coding.code);
        }
      }
      return observationBasedOnEpisode(observation, episode);
    });
    const sorted = sortObservationsByEffective(episodeObservations);

    return {
      episode,
      observationCount: episodeObservations.length,
      ...(sorted[0]?.effectiveDateTime
        ? { firstObservationDate: sorted[0].effectiveDateTime }
        : {}),
      ...(sorted[sorted.length - 1]?.effectiveDateTime
        ? { lastObservationDate: sorted[sorted.length - 1].effectiveDateTime }
        : {}),
      observationCodes: [...observationCodes].sort(),
    };
  });
}

export function observationMatchesCode(observation: Observation, code: string): boolean {
  if (!code) {
    return true;
  }

  const [system, tokenCode] = splitToken(code);
  const matches = (coding: { system?: string; code?: string } | undefined): boolean => {
    if (!coding?.code) {
      return false;
    }
    if (system) {
      return coding.system === system && coding.code === tokenCode;
    }
    return coding.code === tokenCode || `${coding.system}|${coding.code}` === code;
  };

  return (
    (observation.code.coding ?? []).some(matches) ||
    (observation.component ?? []).some((component) =>
      (component.code.coding ?? []).some(matches),
    )
  );
}

export function observationMatchesEye(observation: Observation, eye?: string): boolean {
  if (!eye) {
    return true;
  }

  const normalized = eye.trim().toUpperCase();
  const serialized = JSON.stringify(observation.bodySite ?? {}).toUpperCase();
  return serialized.includes(normalized);
}

export function observationMatchesDateRange(
  observation: Observation,
  dateRange?: DateRangeInput,
): boolean {
  if (!dateRange?.start && !dateRange?.end) {
    return true;
  }

  const millis = effectiveMillis(observation);
  if (!Number.isFinite(millis)) {
    return false;
  }
  if (dateRange.start && millis < Date.parse(dateRange.start)) {
    return false;
  }
  if (dateRange.end && millis > Date.parse(dateRange.end)) {
    return false;
  }
  return true;
}

export function observationMatchesFocus(
  observation: Observation,
  focusReference?: string,
): boolean {
  if (!focusReference) {
    return true;
  }
  return (observation.focus ?? []).some((focus) => focus.reference === focusReference);
}

function measurementPointFromObservation(observation: Observation): MeasurementPoint | undefined {
  const quantity = firstQuantity(observation);
  const effectiveDateTime = observation.effectiveDateTime ?? observation.effectivePeriod?.start;
  if (!quantity || quantity.value === undefined || !effectiveDateTime) {
    return undefined;
  }

  return {
    observationId: observation.id,
    effectiveDateTime,
    value: quantity.value,
    unit: quantity.code ?? quantity.unit,
  };
}

function firstQuantity(observation: Observation): Quantity | undefined {
  if (observation.valueQuantity) {
    return observation.valueQuantity;
  }
  return observation.component?.find((component) => component.valueQuantity)?.valueQuantity;
}

function linearSlopePerYear(
  points: MeasurementPoint[],
): { slopePerYear: number; rSquared: number } | undefined {
  if (points.length < 2) {
    return undefined;
  }

  const firstMillis = Date.parse(points[0].effectiveDateTime);
  const xs = points.map((point) => (Date.parse(point.effectiveDateTime) - firstMillis) / 31_557_600_000);
  const ys = points.map((point) => point.value);
  const xMean = mean(xs);
  const yMean = mean(ys);
  const numerator = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0);
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  if (denominator === 0) {
    return undefined;
  }

  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;
  const ssTot = ys.reduce((sum, y) => sum + (y - yMean) ** 2, 0);
  const ssRes = ys.reduce((sum, y, index) => {
    const predicted = slope * xs[index] + intercept;
    return sum + (y - predicted) ** 2;
  }, 0);

  return {
    slopePerYear: round(slope, 6),
    rSquared: ssTot === 0 ? 1 : round(1 - ssRes / ssTot, 6),
  };
}

function notableChangeEvents(points: MeasurementPoint[]): NotableChangeEvent[] {
  return points
    .slice(1)
    .map((point, index) => {
      const previous = points[index];
      const delta = point.value - previous.value;
      return {
        fromObservationId: previous.observationId,
        toObservationId: point.observationId,
        fromEffectiveDateTime: previous.effectiveDateTime,
        toEffectiveDateTime: point.effectiveDateTime,
        delta: round(delta, 6),
        absoluteDelta: round(Math.abs(delta), 6),
        unit: point.unit ?? previous.unit,
      };
    })
    .sort((left, right) => right.absoluteDelta - left.absoluteDelta)
    .slice(0, 3);
}

function observationBasedOnEpisode(observation: Observation, episode: EpisodeOfCare): boolean {
  const start = episode.period?.start ? Date.parse(episode.period.start) : Number.NEGATIVE_INFINITY;
  const end = episode.period?.end ? Date.parse(episode.period.end) : Number.POSITIVE_INFINITY;
  const effective = effectiveMillis(observation);
  return effective >= start && effective <= end;
}

function effectiveMillis(observation: Observation): number {
  return Date.parse(
    observation.effectiveDateTime ??
      observation.effectivePeriod?.start ??
      observation.issued ??
      "1970-01-01T00:00:00.000Z",
  );
}

function splitToken(token: string): [string | undefined, string] {
  const [system, code] = token.split("|", 2);
  return code ? [system, code] : [undefined, token];
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
