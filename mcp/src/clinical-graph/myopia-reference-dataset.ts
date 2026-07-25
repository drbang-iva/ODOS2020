import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REFERENCE_POPULATIONS = ["ASIAN", "CAUCASIAN", "NOT_REPRESENTED"] as const;
export type ReferencePopulation = (typeof REFERENCE_POPULATIONS)[number];
export const REFERENCE_MEASURES = ["AXIAL_LENGTH", "SPHERICAL_EQUIVALENT", "AL_CR_RATIO"] as const;
export type ReferenceMeasure = (typeof REFERENCE_MEASURES)[number];
export const REFERENCE_MODEL_TYPES = ["PERCENTILE_BANDS", "PROJECTION_REGRESSION"] as const;
export type ReferenceModelType = (typeof REFERENCE_MODEL_TYPES)[number];
export type ReferenceSex = "MALE" | "FEMALE";

export interface PercentileTableRow {
  age: number;
  values: number[];
}

export interface TabulatedBandsPayload {
  type: "TABULATED_BANDS";
  percentiles: number[];
  tables: Record<ReferenceSex, PercentileTableRow[]>;
}

export interface LmsParameterRow {
  age: number;
  L: number;
  M: number;
  S: number;
}

/** Reserved representation; its future evaluator uses M * (1 + L * S * Z)^(1/L). */
export interface LmsParametersPayload {
  type: "LMS_PARAMETERS";
  percentiles: number[];
  tables: Record<ReferenceSex, LmsParameterRow[]>;
}

export type PercentileBandsPayload = TabulatedBandsPayload | LmsParametersPayload;

export interface PercentileBandsDataset {
  datasetId: string;
  version: string;
  citation: string;
  populationNote: string;
  populationsCovered: ReferencePopulation[];
  sexStratified: boolean;
  ageRangeMin: number;
  ageRangeMax: number;
  measure: ReferenceMeasure;
  modelType: "PERCENTILE_BANDS";
  payload: PercentileBandsPayload;
}

export interface ProjectionRegressionDataset {
  datasetId: string;
  version: string;
  citation: string;
  populationNote: string;
  populationsCovered: ReferencePopulation[];
  sexStratified: boolean;
  ageRangeMin: number;
  ageRangeMax: number;
  measure: ReferenceMeasure;
  modelType: "PROJECTION_REGRESSION";
  payload: Record<string, unknown>;
}

export type ReferenceDataset = PercentileBandsDataset | ProjectionRegressionDataset;

export interface ReferenceBand {
  percentile: number;
  value: number;
}

export interface ReferenceBandResult {
  datasetId: string;
  version: string;
  citation: string;
  populationNote: string;
  bands: ReferenceBand[];
}

export interface ReferenceBandProvider {
  getBands(input: {
    measure: ReferenceMeasure;
    population: ReferencePopulation;
    sex: ReferenceSex;
    ageInYears: number;
  }): ReferenceBandResult | null;
}

export interface TranscriptionInvariantResult {
  invariant: "V1" | "V2" | "V3" | "V4" | "V5";
  checks: number;
  violations: string[];
}

const SEED_PATH = fileURLToPath(
  new URL("../../../data/myopia-reference-datasets/he-2023-axial-length.json", import.meta.url),
);

export class ReferenceDatasetRegistry {
  private readonly datasets: readonly ReferenceDataset[];

  constructor(datasets: readonly ReferenceDataset[]) {
    const keys = new Set<string>();
    for (const dataset of datasets) {
      assertDataset(dataset);
      const key = `${dataset.datasetId}@${dataset.version}`;
      if (keys.has(key)) throw new Error(`Duplicate reference dataset version ${key}.`);
      keys.add(key);
    }
    this.datasets = [...datasets];
  }

  list(): readonly ReferenceDataset[] {
    return this.datasets;
  }

  latest(input: {
    measure: ReferenceMeasure;
    population: ReferencePopulation;
  }): ReferenceDataset | undefined {
    return this.datasets
      .filter((dataset) =>
        dataset.measure === input.measure &&
        dataset.populationsCovered.includes(input.population))
      .sort((left, right) =>
        right.version.localeCompare(left.version, undefined, { numeric: true }) ||
        right.datasetId.localeCompare(left.datasetId))[0];
  }
}

export class PercentileBandProvider implements ReferenceBandProvider {
  constructor(private readonly registry: ReferenceDatasetRegistry) {}

  getBands(input: {
    measure: ReferenceMeasure;
    population: ReferencePopulation;
    sex: ReferenceSex;
    ageInYears: number;
  }): ReferenceBandResult | null {
    if (input.population === "NOT_REPRESENTED") return null;
    const dataset = this.registry.latest(input);
    if (
      !dataset ||
      dataset.modelType !== "PERCENTILE_BANDS" ||
      dataset.payload.type !== "TABULATED_BANDS" ||
      input.ageInYears < dataset.ageRangeMin ||
      input.ageInYears > dataset.ageRangeMax
    ) {
      return null;
    }
    const rows = dataset.payload.tables[input.sex];
    if (!rows) return null;
    const exact = rows.find((row) => row.age === input.ageInYears);
    const values = exact?.values ?? interpolateRows(rows, input.ageInYears);
    if (!values) return null;
    return {
      datasetId: dataset.datasetId,
      version: dataset.version,
      citation: dataset.citation,
      populationNote: dataset.populationNote,
      bands: dataset.payload.percentiles.map((percentile, index) => ({
        percentile,
        value: values[index]!,
      })),
    };
  }
}

export function loadReferenceDatasetSeeds(): ReferenceDataset[] {
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("Myopia reference dataset seed must be an object.");
  const dataset = raw as unknown as ReferenceDataset;
  assertDataset(dataset);
  const failures = evaluateTranscriptionInvariants(dataset)
    .filter((result) => result.violations.length > 0);
  if (failures.length) {
    throw new Error(failures.flatMap((result) => result.violations).join("; "));
  }
  return [dataset];
}

export function evaluateTranscriptionInvariants(
  dataset: ReferenceDataset,
): TranscriptionInvariantResult[] {
  if (dataset.modelType !== "PERCENTILE_BANDS") return emptyInvariantResults();
  const payload = dataset.payload;
  if (payload.type !== "TABULATED_BANDS") return emptyInvariantResults();

  const v1: TranscriptionInvariantResult = { invariant: "V1", checks: 0, violations: [] };
  const v2: TranscriptionInvariantResult = { invariant: "V2", checks: 0, violations: [] };
  const v3: TranscriptionInvariantResult = { invariant: "V3", checks: 0, violations: [] };
  const v4: TranscriptionInvariantResult = { invariant: "V4", checks: 0, violations: [] };
  const v5: TranscriptionInvariantResult = { invariant: "V5", checks: 1, violations: [] };
  let valueCount = 0;
  const axialLength = dataset.measure === "AXIAL_LENGTH";

  for (const sex of ["MALE", "FEMALE"] as const) {
    const rows = payload.tables[sex] ?? [];
    for (const row of rows) {
      valueCount += row.values.length;
      for (let index = 0; index < row.values.length - 1; index += 1) {
        v1.checks += 1;
        if (!(row.values[index + 1]! > row.values[index]!)) {
          v1.violations.push(
            `${sex} age ${row.age}: P${payload.percentiles[index]} ${row.values[index]} ` +
            `must be less than P${payload.percentiles[index + 1]} ${row.values[index + 1]}.`,
          );
        }
      }
      if (axialLength) {
        for (const value of row.values) {
          v4.checks += 1;
          if (value < 18 || value > 32) {
            v4.violations.push(`${sex} age ${row.age}: ${value} mm is outside 18.0-32.0 mm.`);
          }
        }
      }
    }

    if (axialLength) {
      for (let index = 0; index < payload.percentiles.length; index += 1) {
        for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex += 1) {
          const current = rows[rowIndex]!;
          const next = rows[rowIndex + 1]!;
          const delta = next.values[index]! - current.values[index]!;
          v2.checks += 1;
          v3.checks += 1;
          if (delta < -0.10 - Number.EPSILON) {
            v2.violations.push(
              `${sex} P${payload.percentiles[index]} age ${current.age}->${next.age}: ` +
              `${delta.toFixed(2)} mm is below -0.10 mm.`,
            );
          }
          if (delta > 0.60 + Number.EPSILON) {
            v3.violations.push(
              `${sex} P${payload.percentiles[index]} age ${current.age}->${next.age}: ` +
              `${delta.toFixed(2)} mm exceeds 0.60 mm.`,
            );
          }
        }
      }
    }
  }

  const expectedRows = dataset.ageRangeMax - dataset.ageRangeMin + 1;
  const expectedValues = payload.percentiles.length * expectedRows * 2;
  const agesComplete = (["MALE", "FEMALE"] as const).every((sex) => {
    const rows = payload.tables[sex] ?? [];
    return rows.length === expectedRows &&
      rows.every((row, index) =>
        row.age === dataset.ageRangeMin + index &&
        row.values.length === payload.percentiles.length &&
        row.values.every((value) => Number.isFinite(value)));
  });
  if (valueCount !== expectedValues || !agesComplete) {
    v5.violations.push(
      `Expected ${payload.percentiles.length} percentiles x ${expectedRows} ages x 2 sexes = ` +
      `${expectedValues} finite values; found ${valueCount}.`,
    );
  }

  return [v1, v2, v3, v4, v5];
}

function interpolateRows(
  rows: readonly PercentileTableRow[],
  ageInYears: number,
): number[] | undefined {
  let lower: PercentileTableRow | undefined;
  let upper: PercentileTableRow | undefined;
  for (const row of rows) {
    if (row.age < ageInYears) {
      lower = row;
      continue;
    }
    if (row.age > ageInYears) {
      upper = row;
      break;
    }
  }
  if (!lower || !upper || upper.age === lower.age) return undefined;
  const fraction = (ageInYears - lower.age) / (upper.age - lower.age);
  return lower.values.map((value, index) =>
    value + (upper.values[index]! - value) * fraction);
}

function assertDataset(dataset: ReferenceDataset): void {
  if (!isRecord(dataset)) throw new Error("Reference dataset must be an object.");
  requiredString(dataset.datasetId, "datasetId");
  requiredString(dataset.version, "version");
  requiredString(dataset.citation, "citation");
  requiredString(dataset.populationNote, "populationNote");
  if (!Array.isArray(dataset.populationsCovered) || dataset.populationsCovered.length === 0) {
    throw new Error("Reference dataset populationsCovered must be non-empty.");
  }
  for (const population of dataset.populationsCovered) {
    if (!(REFERENCE_POPULATIONS as readonly string[]).includes(population)) {
      throw new Error(`Unsupported reference population ${population}.`);
    }
  }
  if (typeof dataset.sexStratified !== "boolean") {
    throw new Error("Reference dataset sexStratified must be boolean.");
  }
  if (!Number.isFinite(dataset.ageRangeMin) || !Number.isFinite(dataset.ageRangeMax)) {
    throw new Error("Reference dataset age range must be finite.");
  }
  if (!(REFERENCE_MEASURES as readonly string[]).includes(dataset.measure)) {
    throw new Error(`Unsupported reference measure ${dataset.measure}.`);
  }
  if (!(REFERENCE_MODEL_TYPES as readonly string[]).includes(dataset.modelType)) {
    throw new Error(`Unsupported reference model type ${dataset.modelType}.`);
  }
  if (dataset.modelType === "PERCENTILE_BANDS") {
    if (!isRecord(dataset.payload)) {
      throw new Error("Percentile dataset payload must be an object.");
    }
    if (!["TABULATED_BANDS", "LMS_PARAMETERS"].includes(String(dataset.payload.type))) {
      throw new Error(`Unsupported percentile payload type ${String(dataset.payload.type)}.`);
    }
    if (!Array.isArray(dataset.payload.percentiles)) {
      throw new Error("Percentile dataset payload must include percentiles.");
    }
    if (!dataset.payload.percentiles.every((percentile) => Number.isFinite(percentile))) {
      throw new Error("Percentile dataset payload percentiles must be finite.");
    }
    for (const sex of ["MALE", "FEMALE"] as const) {
      if (!Array.isArray(dataset.payload.tables?.[sex])) {
        throw new Error(`Percentile dataset payload is missing ${sex} rows.`);
      }
      if (dataset.payload.type === "TABULATED_BANDS") {
        for (const row of dataset.payload.tables[sex]) {
          if (
            !Number.isFinite(row.age) ||
            !Array.isArray(row.values) ||
            !row.values.every((value) => Number.isFinite(value))
          ) {
            throw new Error(`TABULATED_BANDS payload contains an invalid ${sex} row.`);
          }
        }
      } else {
        for (const row of dataset.payload.tables[sex]) {
          if (
            !Number.isFinite(row.age) ||
            !Number.isFinite(row.L) ||
            !Number.isFinite(row.M) ||
            !Number.isFinite(row.S)
          ) {
            throw new Error(`LMS_PARAMETERS payload contains an invalid ${sex} row.`);
          }
        }
      }
    }
  }
}

function emptyInvariantResults(): TranscriptionInvariantResult[] {
  return [
    { invariant: "V1", checks: 0, violations: [] },
    { invariant: "V2", checks: 0, violations: [] },
    { invariant: "V3", checks: 0, violations: [] },
    { invariant: "V4", checks: 0, violations: [] },
    { invariant: "V5", checks: 0, violations: [] },
  ];
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Reference dataset ${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const MYOPIA_REFERENCE_DATASET_REGISTRY = new ReferenceDatasetRegistry(
  loadReferenceDatasetSeeds(),
);
export const MYOPIA_REFERENCE_BAND_PROVIDER = new PercentileBandProvider(
  MYOPIA_REFERENCE_DATASET_REGISTRY,
);
