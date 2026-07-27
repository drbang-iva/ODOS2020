import type {
  Bundle,
  CodeableConcept,
  Observation,
  Patient,
  Provenance,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { OBSERVATION_AXIAL_LENGTH_PROFILE_URL } from "../fhir/myopiaManagement.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  captureGlaucomaFinding,
  patientScopedProvenanceTargets,
  type CapturedGlaucomaFinding,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";
import {
  AXIAL_LENGTH_KEY,
  BIOMETRY_METHODS,
  CORNEAL_RADIUS_KEY,
  buildMyopiaFindingDefinitions,
  type BiometryMethod,
} from "./myopia-finding-definition.js";
import {
  MYOPIA_REFERENCE_BAND_PROVIDER,
  MYOPIA_REFERENCE_DATASET_REGISTRY,
  type AxialGrowthRateThresholds,
  type ReferenceBandProvider,
  type ReferenceDatasetRegistry,
  type ReferencePopulation,
  REFERENCE_POPULATIONS,
} from "./myopia-reference-dataset.js";
import type { MyopiaReferencePopulationStore } from "./myopia-reference-population-store.js";
import {
  LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
  resolveRefractiveStatus,
  type ResolvedRefractiveStatus,
} from "./refractive-status.js";

type Eye = "OD" | "OS";

export interface MyopiaProgressionFhirClient {
  create<T extends Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  read<T extends Patient>(resourceType: "Patient", id: string): Promise<T>;
  search<T extends Observation>(
    resourceType: "Observation",
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface MyopiaProgressionAuthenticatedStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: MyopiaProgressionFhirClient;
}

export interface MyopiaProgressionEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<MyopiaProgressionAuthenticatedStaff | null>;
  settingsStore: MyopiaReferencePopulationStore;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  bandProvider?: ReferenceBandProvider;
  referenceDatasetRegistry?: ReferenceDatasetRegistry;
  now?: () => string;
}

export interface MyopiaProgressionEndpointResult {
  status: number;
  body: unknown;
}

export interface MyopiaProgressionReading {
  eye: Eye;
  axialLengthMm: number;
  cornealRadiusMm: number | null;
  ageInYears: number;
  measuredAt: string;
  biometryMethod: BiometryMethod;
  instrument: string | null;
  observationReference: string;
  refractiveStatus: ResolvedRefractiveStatus;
}

export type AxialGrowthRateClassification = "NORMAL" | "WATCH" | "FLAG";
export type AxialGrowthRateStatus = "AVAILABLE" | "INTERVAL_TOO_SHORT" | "BIOMETRY_METHOD_CHANGED";

export interface MyopiaAxialGrowthRate {
  eye: Eye;
  status: AxialGrowthRateStatus;
  earlierMeasuredAt: string;
  laterMeasuredAt: string;
  intervalYears: number;
  biometryMethod: BiometryMethod | null;
  mmPerYear: number | null;
  classification: AxialGrowthRateClassification | null;
}

export interface MyopiaProgressionHistoryResponse {
  referencePopulation: ReferencePopulation;
  patientSex: "MALE" | "FEMALE" | null;
  birthDate: string;
  readings: MyopiaProgressionReading[];
  growthRates?: MyopiaAxialGrowthRate[];
  referenceDataset: {
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
  } | null;
  noReferenceMessage: string | null;
}

export interface EyeGrowthVisibilityResponse {
  currentAgeInYears: number;
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  defaultVisible: boolean;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/eye_growth" } as const;
const LEDGER_REF = "data/code-bindings/myopia-growth-ledger.md";
const EYES = ["OD", "OS"] as const;
const AGE_NOT_COVERED_MESSAGE =
  "No reference data covers this age. Patient measurements are shown without reference bands.";
const PEDIATRIC_MAX_AGE_YEARS = 18;
const RATE_BOUNDARY_EPSILON = 1e-9;

const eyePayloadSchema = z.object({
  axialLengthMm: z.number().min(18).max(32),
  cornealRadiusMm: z.number().min(5).max(12).optional(),
  biometryMethod: z.enum(BIOMETRY_METHODS),
  instrument: z.string().trim().min(1).max(200).optional(),
}).strict();

const captureRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  measuredAt: z.string().datetime({ offset: true }).optional(),
  eyes: z.object({
    OD: eyePayloadSchema.optional(),
    OS: eyePayloadSchema.optional(),
  }).strict().refine((eyes) => Boolean(eyes.OD || eyes.OS), {
    message: "At least one eye payload is required.",
  }),
}).strict();

const historyQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
}).strict();

const populationRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  referencePopulation: z.enum(REFERENCE_POPULATIONS),
}).strict();

export async function handleMyopiaDefinitionRequest(
  deps: Pick<MyopiaProgressionEndpointDeps, "authenticate" | "findingDefinitions" | "settingsStore">,
  input: { authHeader: string | undefined },
): Promise<MyopiaProgressionEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read myopia definitions." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const definitions = resolveMyopiaDefinitions(deps.findingDefinitions?.());
  return {
    status: 200,
    body: {
      definitions: {
        axialLength: definitionSummary(definitions.axialLength),
        cornealRadius: definitionSummary(definitions.cornealRadius),
      },
      referencePopulations: REFERENCE_POPULATIONS,
    },
  };
}

export async function handleMyopiaCaptureRequest(
  deps: MyopiaProgressionEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<MyopiaProgressionEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save myopia findings." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = captureRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 400,
      body: { error: issue ? `${issue.path.join(".") || "Myopia request"}: ${issue.message}` : "Invalid myopia request." },
    };
  }

  const definitions = resolveMyopiaDefinitions(deps.findingDefinitions?.());
  const measuredAt = parsed.data.measuredAt ?? deps.now?.() ?? new Date().toISOString();
  const captured = EYES.flatMap((eye) => {
    const payload = parsed.data.eyes[eye];
    if (!payload) return [];
    return [{
      eye,
      payload,
      graphs: buildMyopiaEyeCapture({
        definitions,
        patientReference: parsed.data.patientReference,
        encounterReference: parsed.data.encounterReference,
        eye,
        measuredAt,
        biometryMethod: payload.biometryMethod,
        instrument: payload.instrument,
        axialLengthMm: payload.axialLengthMm,
        cornealRadiusMm: payload.cornealRadiusMm,
        staffReference: staff.staffReference,
      }),
    }];
  });

  const eyes: Record<string, unknown> = {};
  for (const item of captured) {
    const axial = await persistGraph(
      staff.fhir,
      item.graphs.axialLength,
      parsed.data.patientReference,
    );
    const cornealRadius = item.graphs.cornealRadius
      ? await persistGraph(staff.fhir, item.graphs.cornealRadius, parsed.data.patientReference)
      : undefined;
    eyes[item.eye] = {
      axialLengthObservationReference: axial.observationReference,
      axialLengthProvenanceReference: axial.provenanceReference,
      ...(cornealRadius
        ? {
            cornealRadiusObservationReference: cornealRadius.observationReference,
            cornealRadiusProvenanceReference: cornealRadius.provenanceReference,
          }
        : {}),
      biometryMethod: item.payload.biometryMethod,
      instrument: item.payload.instrument ?? null,
    };
  }
  return { status: 200, body: { eyes } };
}

export async function handleMyopiaHistoryRequest(
  deps: MyopiaProgressionEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<MyopiaProgressionEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read myopia progression." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = historyQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid myopia history request." } };
  }

  const patientId = parsed.data.patient.replace(/^Patient\//, "");
  const definitions = resolveMyopiaDefinitions(deps.findingDefinitions?.());
  const [patient, axialBundle, cornealBundle, refractionBundle, settings] = await Promise.all([
    staff.fhir.read<Patient>("Patient", patientId),
    staff.fhir.search<Observation>("Observation", observationSearchParams(parsed.data.patient, definitions.axialLength)),
    staff.fhir.search<Observation>("Observation", observationSearchParams(parsed.data.patient, definitions.cornealRadius)),
    staff.fhir.search<Observation>("Observation", refractionSearchParams(parsed.data.patient)),
    deps.settingsStore.get(parsed.data.patient),
  ]);
  if (!patient.birthDate) {
    return { status: 422, body: { error: "Patient birth date is required to calculate age for myopia progression." } };
  }

  const cornealByEyeAndTime = new Map(
    bundleResources(cornealBundle).flatMap((observation) => {
      const eye = observationEye(observation);
      const measuredAt = observation.effectiveDateTime;
      const value = observation.valueQuantity?.value;
      const key = measuredAt ? instantKey(measuredAt) : null;
      return eye && key !== null && typeof value === "number"
        ? [[`${eye}|${key}`, value] as const]
        : [];
    }),
  );
  const refractionObservations = bundleResources(refractionBundle);
  const readings = bundleResources(axialBundle)
    .flatMap((observation) =>
      observationToReading(
        observation,
        patient.birthDate!,
        cornealByEyeAndTime,
        refractionObservations,
      ))
    .sort((left, right) => left.measuredAt.localeCompare(right.measuredAt));
  const patientSex = patient.gender === "male" ? "MALE" : patient.gender === "female" ? "FEMALE" : null;
  const registry = deps.referenceDatasetRegistry ?? MYOPIA_REFERENCE_DATASET_REGISTRY;
  const referencePopulation = displayReferencePopulation(settings.referencePopulation);
  const currentAgeInYears = decimalAge(patient.birthDate, deps.now?.() ?? new Date().toISOString());
  const activeDataset = registry.latest({ measure: "AXIAL_LENGTH", population: referencePopulation });
  const referenceDataset = patientSex &&
      activeDataset &&
      currentAgeInYears >= activeDataset.ageRangeMin &&
      currentAgeInYears <= activeDataset.ageRangeMax
    ? buildReferenceDataset(
        deps.bandProvider ?? MYOPIA_REFERENCE_BAND_PROVIDER,
        registry,
        referencePopulation,
        patientSex,
      )
    : null;
  const rateThresholds = registry.axialGrowthRateThresholds();

  return {
    status: 200,
    body: {
      referencePopulation,
      patientSex,
      birthDate: patient.birthDate,
      readings,
      ...(rateThresholds ? { growthRates: calculateAxialGrowthRates(readings, rateThresholds) } : {}),
      referenceDataset,
      noReferenceMessage: referenceDataset ? null : AGE_NOT_COVERED_MESSAGE,
    } satisfies MyopiaProgressionHistoryResponse,
  };
}

export function calculateAxialGrowthRates(
  readings: readonly MyopiaProgressionReading[],
  thresholds: AxialGrowthRateThresholds,
): MyopiaAxialGrowthRate[] {
  return EYES.flatMap<MyopiaAxialGrowthRate>((eye) => {
    const eyeReadings = readings
      .filter((reading) => reading.eye === eye)
      .sort((left, right) =>
        left.ageInYears - right.ageInYears ||
        left.measuredAt.localeCompare(right.measuredAt));
    if (eyeReadings.length < 2) return [];
    const earlier = eyeReadings.at(-2)!;
    const later = eyeReadings.at(-1)!;
    const intervalYears = later.ageInYears - earlier.ageInYears;
    const common = {
      eye,
      earlierMeasuredAt: earlier.measuredAt,
      laterMeasuredAt: later.measuredAt,
      intervalYears,
    };
    if (earlier.biometryMethod !== later.biometryMethod) {
      return [{
        ...common,
        status: "BIOMETRY_METHOD_CHANGED" as const,
        biometryMethod: null,
        mmPerYear: null,
        classification: null,
      }];
    }
    if (intervalYears < 0.5) {
      return [{
        ...common,
        status: "INTERVAL_TOO_SHORT" as const,
        biometryMethod: later.biometryMethod,
        mmPerYear: null,
        classification: null,
      }];
    }
    const mmPerYear = (later.axialLengthMm - earlier.axialLengthMm) / intervalYears;
    const band = later.ageInYears < thresholds.ageBoundaryYears
      ? thresholds.younger
      : thresholds.older;
    const classification = mmPerYear <= band.normalUpperMmPerYear + RATE_BOUNDARY_EPSILON
      ? "NORMAL"
      : mmPerYear <= band.watchUpperMmPerYear + RATE_BOUNDARY_EPSILON
        ? "WATCH"
        : "FLAG";
    return [{
      ...common,
      status: "AVAILABLE" as const,
      biometryMethod: later.biometryMethod,
      mmPerYear,
      classification,
    }];
  });
}

export async function handleEyeGrowthVisibilityRequest(
  deps: Pick<MyopiaProgressionEndpointDeps, "authenticate" | "settingsStore" | "referenceDatasetRegistry" | "now">,
  input: { authHeader: string | undefined; query: unknown },
): Promise<MyopiaProgressionEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read eye-growth visibility." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = historyQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid eye-growth visibility request." } };
  }
  const patientId = parsed.data.patient.replace(/^Patient\//, "");
  const [patient, settings] = await Promise.all([
    staff.fhir.read<Patient>("Patient", patientId),
    deps.settingsStore.get(parsed.data.patient),
  ]);
  if (!patient.birthDate) {
    return { status: 422, body: { error: "Patient birth date is required to calculate eye-growth visibility." } };
  }
  const currentAgeInYears = decimalAge(
    patient.birthDate,
    deps.now?.() ?? new Date().toISOString(),
  );
  const referencePopulation = displayReferencePopulation(settings.referencePopulation);
  const dataset = (deps.referenceDatasetRegistry ?? MYOPIA_REFERENCE_DATASET_REGISTRY)
    .latest({ measure: "AXIAL_LENGTH", population: referencePopulation });
  const ageRangeMin = dataset?.ageRangeMin ?? null;
  const ageRangeMax = dataset?.ageRangeMax ?? null;
  return {
    status: 200,
    body: {
      currentAgeInYears,
      ageRangeMin,
      ageRangeMax,
      defaultVisible: currentAgeInYears <= PEDIATRIC_MAX_AGE_YEARS,
    } satisfies EyeGrowthVisibilityResponse,
  };
}

export async function handleMyopiaReferencePopulationRequest(
  deps: MyopiaProgressionEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<MyopiaProgressionEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save reference population." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = populationRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid reference population request." } };
  }
  const saved = await deps.settingsStore.set({
    patientReference: parsed.data.patientReference,
    referencePopulation: parsed.data.referencePopulation,
    updatedBy: staff.staffReference,
    updatedAt: deps.now?.() ?? new Date().toISOString(),
  });
  return { status: 200, body: saved };
}

export function resolveMyopiaDefinitions(
  suppliedDefinitions: ClinicalFindingDefinition[] | undefined,
): { axialLength: ClinicalFindingDefinition; cornealRadius: ClinicalFindingDefinition } {
  const definitions = suppliedDefinitions?.length
    ? suppliedDefinitions
    : buildMyopiaFindingDefinitions(myopiaProvenance(
        "Practitioner/odos-system",
        new Date(0).toISOString(),
      ));
  const axialLength = definitions.find((row) => row.stableKey === AXIAL_LENGTH_KEY);
  const cornealRadius = definitions.find((row) => row.stableKey === CORNEAL_RADIUS_KEY);
  if (!axialLength) throw new Error(`${AXIAL_LENGTH_KEY} finding definition seed is missing.`);
  if (!cornealRadius) throw new Error(`${CORNEAL_RADIUS_KEY} finding definition seed is missing.`);
  return { axialLength, cornealRadius };
}

export function buildMyopiaEyeCapture(input: {
  definitions: { axialLength: ClinicalFindingDefinition; cornealRadius: ClinicalFindingDefinition };
  patientReference: string;
  encounterReference: string;
  eye: Eye;
  measuredAt: string;
  biometryMethod: BiometryMethod;
  instrument?: string;
  axialLengthMm: number;
  cornealRadiusMm?: number;
  staffReference: string;
}): { axialLength: CapturedGlaucomaFinding; cornealRadius?: CapturedGlaucomaFinding } {
  const method = odosConcept(input.biometryMethod, biometryMethodDisplay(input.biometryMethod));
  const provenance = myopiaProvenance(input.staffReference, input.measuredAt);
  const common = {
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    laterality: input.eye,
    method,
    sourceType: "manual" as const,
    performerReferences: [input.staffReference],
    recordedAt: input.measuredAt,
    provenance,
  };
  const axialLength = captureGlaucomaFinding({
    ...common,
    definition: input.definitions.axialLength,
    value: {
      type: "quantity",
      value: input.axialLengthMm,
      unit: "mm",
      system: "http://unitsofmeasure.org",
      code: "mm",
    },
  });
  axialLength.observation.meta = {
    ...axialLength.observation.meta,
    profile: Array.from(new Set([
      ...(axialLength.observation.meta?.profile ?? []),
      OBSERVATION_AXIAL_LENGTH_PROFILE_URL,
    ])),
  };
  addCaptureComponents(axialLength.observation, input.biometryMethod, input.instrument);

  const cornealRadius = input.cornealRadiusMm === undefined
    ? undefined
    : captureGlaucomaFinding({
        ...common,
        definition: input.definitions.cornealRadius,
        value: {
          type: "quantity",
          value: input.cornealRadiusMm,
          unit: "mm",
          system: "http://unitsofmeasure.org",
          code: "mm",
        },
      });
  if (cornealRadius) addCaptureComponents(cornealRadius.observation, input.biometryMethod, input.instrument);
  return { axialLength, cornealRadius };
}

function buildReferenceDataset(
  provider: ReferenceBandProvider,
  registry: ReferenceDatasetRegistry,
  population: ReferencePopulation,
  sex: "MALE" | "FEMALE",
): MyopiaProgressionHistoryResponse["referenceDataset"] {
  const dataset = registry.latest({ measure: "AXIAL_LENGTH", population });
  if (
    !dataset ||
    dataset.modelType !== "PERCENTILE_BANDS" ||
    dataset.payload.type !== "TABULATED_BANDS"
  ) {
    return null;
  }
  const rows = [];
  let identity: {
    datasetId: string;
    version: string;
    citation: string;
    populationNote: string;
  } | null = null;
  for (const sourceRow of dataset.payload.tables[sex]) {
    const result = provider.getBands({
      measure: "AXIAL_LENGTH",
      population,
      sex,
      ageInYears: sourceRow.age,
    });
    if (!result) return null;
    identity ??= result;
    if (
      result.datasetId !== dataset.datasetId ||
      result.version !== dataset.version ||
      result.datasetId !== identity.datasetId ||
      result.version !== identity.version ||
      result.bands.length === 0
    ) {
      return null;
    }
    rows.push({ age: sourceRow.age, values: result.bands.map((band) => band.value) });
  }
  const first = provider.getBands({
    measure: "AXIAL_LENGTH",
    population,
    sex,
    ageInYears: dataset.ageRangeMin,
  });
  return identity && first
    ? {
        ...identity,
        medianRepresentsHealthy: dataset.medianRepresentsHealthy,
        ageRangeMin: dataset.ageRangeMin,
        ageRangeMax: dataset.ageRangeMax,
        percentiles: first.bands.map((band) => band.percentile),
        zoneThresholds: dataset.zoneThresholds,
        rows,
      }
    : null;
}

function displayReferencePopulation(population: ReferencePopulation): ReferencePopulation {
  return population === "ASIAN" ? "ASIAN" : "CAUCASIAN";
}

function observationToReading(
  observation: Observation,
  birthDate: string,
  cornealByEyeAndTime: ReadonlyMap<string, number>,
  refractionObservations: readonly Observation[],
): MyopiaProgressionReading[] {
  const eye = observationEye(observation);
  const axialLengthMm = observation.valueQuantity?.value;
  const measuredAt = observation.effectiveDateTime;
  const method = biometryMethodFromObservation(observation);
  if (
    !eye ||
    typeof axialLengthMm !== "number" ||
    !measuredAt ||
    !method ||
    !observation.id
  ) {
    return [];
  }
  const ageInYears = decimalAge(birthDate, measuredAt);
  const measuredAtKey = instantKey(measuredAt);
  if (!Number.isFinite(ageInYears) || measuredAtKey === null) return [];
  return [{
    eye,
    axialLengthMm,
    cornealRadiusMm: cornealByEyeAndTime.get(`${eye}|${measuredAtKey}`) ?? null,
    ageInYears,
    measuredAt,
    biometryMethod: method,
    instrument: componentString(observation, "instrument"),
    observationReference: `Observation/${observation.id}`,
    refractiveStatus: resolveRefractiveStatus(
      refractionObservations,
      eye,
      measuredAt,
      observation.encounter?.reference,
    ),
  }];
}

function observationSearchParams(
  patientReference: string,
  definition: ClinicalFindingDefinition,
): Record<string, string> {
  const coding = definition.fhirObservationCode?.coding?.find((candidate) => candidate.system && candidate.code);
  return {
    subject: patientReference,
    code: coding?.system && coding.code
      ? `${coding.system}|${coding.code}`
      : `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${definition.stableKey}`,
    _count: "500",
  };
}

function refractionSearchParams(patientReference: string): Record<string, string> {
  return {
    subject: patientReference,
    code: [
      `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|REFRACTION`,
      `${LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|REFRACTION`,
    ].join(","),
    _sort: "-date",
    _count: "500",
  };
}

function observationEye(observation: Observation): Eye | null {
  const values = [
    ...(observation.bodySite?.coding ?? []).map((coding) => coding.code),
    ...(observation.extension ?? []).flatMap((extension) =>
      extension.valueCodeableConcept?.coding?.map((coding) => coding.code) ?? []),
    ...(observation.contained ?? []).flatMap((resource) =>
      resource.resourceType === "BodyStructure"
        ? resource.location?.coding?.map((coding) => coding.code) ?? []
        : []),
  ];
  return values.some((value) => value === "OD" || value === "right") ? "OD"
    : values.some((value) => value === "OS" || value === "left") ? "OS"
      : null;
}

function biometryMethodFromObservation(observation: Observation): BiometryMethod | null {
  const component = observation.component?.find((candidate) =>
    candidate.code.coding?.some((coding) => coding.code === "biometryMethod"));
  const code = component?.valueCodeableConcept?.coding?.[0]?.code ??
    observation.method?.coding?.[0]?.code;
  return code && (BIOMETRY_METHODS as readonly string[]).includes(code)
    ? code as BiometryMethod
    : null;
}

function componentString(observation: Observation, code: string): string | null {
  return observation.component?.find((candidate) =>
    candidate.code.coding?.some((coding) => coding.code === code))?.valueString ?? null;
}

function decimalAge(birthDate: string, measuredAt: string): number {
  const birth = Date.parse(`${birthDate}T00:00:00Z`);
  const measured = Date.parse(measuredAt);
  return (measured - birth) / (365.2425 * 24 * 60 * 60 * 1000);
}

function instantKey(value: string): number | null {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function addCaptureComponents(
  observation: Observation,
  method: BiometryMethod,
  instrument: string | undefined,
): void {
  observation.component = [
    ...(observation.component ?? []),
    {
      code: odosConcept("biometryMethod", "Biometry method"),
      valueCodeableConcept: odosConcept(method, biometryMethodDisplay(method)),
    },
    ...(instrument
      ? [{ code: odosConcept("instrument", "Instrument"), valueString: instrument }]
      : []),
  ];
}

function definitionSummary(definition: ClinicalFindingDefinition) {
  return {
    id: definition.id,
    stableKey: definition.stableKey,
    display: definition.display,
    fields: asRecord(definition.valueSchema.fields),
    normalSemantics: definition.normalSemantics,
  };
}

function biometryMethodDisplay(method: BiometryMethod): string {
  return method === "OPTICAL_BIOMETRY" ? "Optical biometry" : "Ultrasound A-scan";
}

function myopiaProvenance(staffReference: string, recordedAt: string): ClinicalGraphProvenance {
  return {
    source: "manual",
    recordedAt,
    actorReference: staffReference,
    ledgerRefs: [LEDGER_REF],
    note: "Clinical-graph capture of axial length and optional corneal radius for longitudinal myopia progression.",
  };
}

async function persistGraph(
  fhir: MyopiaProgressionFhirClient,
  graph: CapturedGlaucomaFinding,
  patientReference: string,
): Promise<{ observationReference: string; provenanceReference?: string }> {
  const observation = await fhir.create<Observation>(graph.observation, WRITE_HEADERS);
  const id = observation.id ?? graph.observation.id;
  if (!id) throw new Error("Observation create response did not include an id.");
  const observationReference = `Observation/${id}`;
  const provenance = await fhir.create<Provenance>({
    ...graph.provenance,
    target: patientScopedProvenanceTargets(observationReference, patientReference),
  }, WRITE_HEADERS);
  return {
    observationReference,
    provenanceReference: provenance.id ? `Provenance/${provenance.id}` : undefined,
  };
}

function bundleResources<T extends Observation>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
