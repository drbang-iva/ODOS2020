import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Bundle, Observation, Patient, Provenance } from "@medplum/fhirtypes";
import { Client } from "pg";
import { OBSERVATION_AXIAL_LENGTH_PROFILE_URL } from "../src/fhir/myopiaManagement.js";
import {
  evaluateTranscriptionInvariants,
  loadReferenceDatasetSeeds,
  MYOPIA_REFERENCE_BAND_PROVIDER,
  MYOPIA_REFERENCE_DATASET_REGISTRY,
  PercentileBandProvider,
  REFERENCE_POPULATIONS,
  ReferenceDatasetRegistry,
  type PercentileBandsDataset,
} from "../src/clinical-graph/myopia-reference-dataset.js";
import { buildMyopiaFindingDefinitions } from "../src/clinical-graph/myopia-finding-definition.js";
import { LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/clinical-graph/refractive-status.js";
import {
  handleEyeGrowthVisibilityRequest,
  handleMyopiaCaptureRequest,
  handleMyopiaHistoryRequest,
  calculateAxialGrowthRates,
  resolveMyopiaDefinitions,
  type EyeGrowthVisibilityResponse,
  type MyopiaProgressionEndpointDeps,
  type MyopiaProgressionHistoryResponse,
} from "../src/clinical-graph/eye-growth-endpoint.js";
import type {
  MyopiaPatientSettings,
  MyopiaReferencePopulationStore,
} from "../src/clinical-graph/myopia-reference-population-store.js";
import { PgMyopiaReferencePopulationStore } from "../src/clinical-graph/myopia-reference-population-store.js";
import { defaultMyopiaPatientSettings } from "../src/clinical-graph/myopia-reference-population-store.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";

const AUTH = "Bearer good";
const PATIENT_REFERENCE = "Patient/p1";
const ENCOUNTER_REFERENCE = "Encounter/e1";
const MEASURED_AT = "2026-07-25T14:00:00.000Z";

test("myopia finding definitions keep exact stable keys and capture contract", () => {
  const definitions = buildMyopiaFindingDefinitions({
    source: "manual",
    recordedAt: MEASURED_AT,
  });
  const axial = definitions.find((definition) => definition.stableKey === "AXIAL_LENGTH");
  const corneal = definitions.find((definition) => definition.stableKey === "CORNEAL_RADIUS");
  assert.ok(axial);
  assert.ok(corneal);
  const axialFields = axial.valueSchema.fields as Record<string, {
    required?: boolean;
    options?: Array<{ code: string }>;
  }>;
  assert.equal(axialFields.biometryMethod?.required, true);
  assert.deepEqual(
    axialFields.biometryMethod?.options?.map((option) => option.code),
    ["OPTICAL_BIOMETRY", "ULTRASOUND_A_SCAN"],
  );
  assert.equal(axialFields.instrument?.required, false);
  assert.equal(
    (corneal.normalSemantics as { lifecycle?: string }).lifecycle,
    "captured, not currently consumed",
  );
});

test("accepted He Table 4 seed satisfies transcription invariants V1-V5", () => {
  const dataset = loadReferenceDatasetSeeds()
    .find((candidate) => candidate.datasetId === "he-2023-chinese-axial-length");
  assert.ok(dataset);
  assert.equal(dataset.modelType, "PERCENTILE_BANDS");
  if (dataset.modelType !== "PERCENTILE_BANDS") assert.fail("Expected percentile-band seed.");
  assert.equal(dataset.payload.type, "TABULATED_BANDS");
  const results = evaluateTranscriptionInvariants(dataset);
  for (const result of results) {
    assert.deepEqual(result.violations, []);
  }
  assert.deepEqual(
    results.map((result) => [result.invariant, result.checks]),
    [["V1", 210], ["V2", 224], ["V3", 224], ["V4", 240], ["V5", 1]],
  );
});

test("supplied Truckenbrod seed transcribes all 40 values and satisfies per-year V1-V5", () => {
  const dataset = loadReferenceDatasetSeeds()
    .find((candidate) => candidate.datasetId === "truckenbrod-2021-german-axial-length");
  assert.ok(dataset);
  assert.equal(dataset.modelType, "PERCENTILE_BANDS");
  if (dataset.modelType !== "PERCENTILE_BANDS") assert.fail("Expected percentile-band seed.");
  assert.equal(dataset.payload.type, "TABULATED_BANDS");
  if (dataset.payload.type !== "TABULATED_BANDS") assert.fail("Expected tabulated seed.");
  assert.deepEqual(dataset.payload.percentiles, [2, 25, 50, 75, 98]);
  assert.deepEqual(dataset.payload.tables, {
    MALE: [
      { age: 6, values: [21.08, 22.13, 22.61, 23.08, 24.00] },
      { age: 9, values: [21.53, 22.59, 23.10, 23.61, 24.65] },
      { age: 12, values: [21.83, 22.90, 23.44, 24.00, 25.17] },
      { age: 15, values: [21.99, 23.06, 23.63, 24.23, 25.57] },
    ],
    FEMALE: [
      { age: 6, values: [20.76, 21.60, 22.00, 22.39, 23.16] },
      { age: 9, values: [21.21, 22.14, 22.59, 23.04, 23.97] },
      { age: 12, values: [21.48, 22.48, 22.99, 23.51, 24.64] },
      { age: 15, values: [21.57, 22.63, 23.19, 23.80, 25.18] },
    ],
  });
  const results = evaluateTranscriptionInvariants(dataset);
  for (const result of results) {
    assert.deepEqual(result.violations, []);
  }
  assert.deepEqual(
    results.map((result) => [result.invariant, result.checks]),
    [["V1", 32], ["V2", 30], ["V3", 30], ["V4", 40], ["V5", 1]],
  );
  assert.deepEqual(dataset.axialGrowthRateThresholds, {
    ageBoundaryYears: 10,
    younger: { normalUpperMmPerYear: 0.2, watchUpperMmPerYear: 0.3 },
    older: { normalUpperMmPerYear: 0.1, watchUpperMmPerYear: 0.2 },
  });
});

test("a patient without saved settings resolves to the European reference dataset", () => {
  const settings = defaultMyopiaPatientSettings(PATIENT_REFERENCE);
  assert.equal(settings.referencePopulation, "CAUCASIAN");
  assert.equal(
    MYOPIA_REFERENCE_DATASET_REGISTRY.latest({
      measure: "AXIAL_LENGTH",
      population: settings.referencePopulation,
    })?.datasetId,
    "truckenbrod-2021-german-axial-length",
  );
  assert.deepEqual(REFERENCE_POPULATIONS, ["ASIAN", "CAUCASIAN", "NOT_REPRESENTED"]);
});

test("registry accepts LMS parameters but provider leaves LMS evaluation unavailable", () => {
  const dataset: PercentileBandsDataset = {
    datasetId: "synthetic-lms-contract",
    version: "1.0.0",
    citation: "Synthetic schema fixture.",
    populationNote: "Synthetic schema fixture; not for clinical use.",
    medianRepresentsHealthy: false,
    populationsCovered: ["CAUCASIAN"],
    sexStratified: true,
    ageRangeMin: 4,
    ageRangeMax: 4,
    measure: "AXIAL_LENGTH",
    modelType: "PERCENTILE_BANDS",
    zoneThresholds: { neutralUpper: 3, typicalUpper: 50, borderlineUpper: 95 },
    payload: {
      type: "LMS_PARAMETERS",
      percentiles: [3, 50, 95],
      tables: {
        MALE: [{ age: 4, L: 1, M: 22.4, S: 0.04 }],
        FEMALE: [{ age: 4, L: 1, M: 22.2, S: 0.04 }],
      },
    },
  };
  const registry = new ReferenceDatasetRegistry([dataset]);
  const provider = new PercentileBandProvider(registry);

  assert.equal(provider.getBands({
    measure: "AXIAL_LENGTH",
    population: "CAUCASIAN",
    sex: "MALE",
    ageInYears: 4,
  }), null);
  assert.deepEqual(
    evaluateTranscriptionInvariants(dataset).map((result) => result.checks),
    [0, 0, 0, 0, 0],
  );
  assert.throws(
    () => new ReferenceDatasetRegistry([{
      ...dataset,
      payload: { type: "UNKNOWN_PAYLOAD", percentiles: [], tables: {} },
    } as never]),
    /Unsupported percentile payload type UNKNOWN_PAYLOAD/,
  );
  const withoutMedianSemantics = { ...dataset } as Partial<PercentileBandsDataset>;
  delete withoutMedianSemantics.medianRepresentsHealthy;
  assert.throws(
    () => new ReferenceDatasetRegistry([withoutMedianSemantics as PercentileBandsDataset]),
    /medianRepresentsHealthy must be boolean/,
  );
});

test("non-axial tabulated bands apply V1 and V5 without axial-length V2-V4 bounds", () => {
  const dataset = syntheticTabulatedDataset(10, 11, "AL_CR_RATIO");
  const results = evaluateTranscriptionInvariants(dataset);

  assert.deepEqual(
    results.map((result) => [result.invariant, result.checks, result.violations.length]),
    [["V1", 8, 0], ["V2", 0, 0], ["V3", 0, 0], ["V4", 0, 0], ["V5", 1, 0]],
  );
});

test("reference provider returns bands only for covered population and in-range ages", () => {
  const covered = MYOPIA_REFERENCE_BAND_PROVIDER.getBands({
    measure: "AXIAL_LENGTH",
    population: "ASIAN",
    sex: "MALE",
    ageInYears: 10.5,
  });
  assert.equal(covered?.bands.length, 8);
  assert.match(covered?.populationNote ?? "", /typical for this cohort, not a marker of normal or healthy eye growth/);
  const german = MYOPIA_REFERENCE_BAND_PROVIDER.getBands({
    measure: "AXIAL_LENGTH",
    population: "CAUCASIAN",
    sex: "FEMALE",
    ageInYears: 10,
  });
  assert.equal(german?.bands.length, 5);
  assert.deepEqual(german?.bands.map((band) => band.percentile), [2, 25, 50, 75, 98]);

  for (const input of [
    { population: "NOT_REPRESENTED" as const, ageInYears: 10 },
    { population: "ASIAN" as const, ageInYears: 3.99 },
    { population: "ASIAN" as const, ageInYears: 18.01 },
    { population: "CAUCASIAN" as const, ageInYears: 5.99 },
    { population: "CAUCASIAN" as const, ageInYears: 15.01 },
  ]) {
    assert.equal(MYOPIA_REFERENCE_BAND_PROVIDER.getBands({
      measure: "AXIAL_LENGTH",
      sex: "FEMALE",
      ...input,
    }), null);
  }
});

test("Eye Growth stays default-visible for paediatric ages below and above the active dataset range", async () => {
  for (const [referencePopulation, now, expectedAge, expectedVisible] of [
    ["CAUCASIAN", "2021-07-25T14:00:00.000Z", 5, true],
    ["CAUCASIAN", "2033-07-25T14:00:00.000Z", 17, true],
    ["NOT_REPRESENTED", "2021-07-25T14:00:00.000Z", 5, true],
    ["CAUCASIAN", "2035-07-25T14:00:00.000Z", 19, false],
  ] as const) {
    const fixture = endpointFixture(referencePopulation, { now: () => now });
    const visibility = await handleEyeGrowthVisibilityRequest(fixture.deps, {
      authHeader: AUTH,
      query: { patient: PATIENT_REFERENCE },
    });
    const body = visibility.body as EyeGrowthVisibilityResponse;
    assert.equal(visibility.status, 200);
    assert.ok(Math.abs(body.currentAgeInYears - expectedAge) < 0.01);
    assert.equal(body.defaultVisible, expectedVisible);
    assert.equal(body.ageRangeMin, 6);
    assert.equal(body.ageRangeMax, 15);
  }
});

test("reference history follows each dataset's declared age range", async () => {
  for (const [ageRangeMin, ageRangeMax] of [[6, 16], [3, 18]] as const) {
    const registry = new ReferenceDatasetRegistry([
      syntheticTabulatedDataset(ageRangeMin, ageRangeMax, "AXIAL_LENGTH"),
    ]);
    const fixture = endpointFixture("ASIAN", {
      bandProvider: new PercentileBandProvider(registry),
      referenceDatasetRegistry: registry,
    });
    const history = await handleMyopiaHistoryRequest(fixture.deps, {
      authHeader: AUTH,
      query: { patient: PATIENT_REFERENCE },
    });
    const body = history.body as MyopiaProgressionHistoryResponse;

    assert.equal(history.status, 200);
    assert.deepEqual(
      body.referenceDataset?.rows.map((row) => row.age),
      Array.from(
        { length: ageRangeMax - ageRangeMin + 1 },
        (_, index) => ageRangeMin + index,
      ),
    );
  }
});

test("empty finding-definition lists fall back to the built-in myopia seed", () => {
  const definitions = resolveMyopiaDefinitions([]);

  assert.equal(definitions.axialLength.stableKey, "AXIAL_LENGTH");
  assert.equal(definitions.cornealRadius.stableKey, "CORNEAL_RADIUS");
});

test("section id migration is data-neutral: Eye Growth reads existing AXIAL_LENGTH stable keys and values", async () => {
  const fixture = endpointFixture("ASIAN");
  const capture = await handleMyopiaCaptureRequest(fixture.deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT_REFERENCE,
      encounterReference: ENCOUNTER_REFERENCE,
      measuredAt: MEASURED_AT,
      eyes: {
        OD: {
          axialLengthMm: 24.21,
          cornealRadiusMm: 7.78,
          biometryMethod: "OPTICAL_BIOMETRY",
          instrument: "IOLMaster 700",
        },
        OS: {
          axialLengthMm: 24.48,
          biometryMethod: "ULTRASOUND_A_SCAN",
        },
      },
    },
  });
  assert.equal(capture.status, 200);
  assert.equal(fixture.created.filter((resource) => resource.resourceType === "Observation").length, 3);
  assert.equal(fixture.created.filter((resource) => resource.resourceType === "Provenance").length, 3);

  const axial = fixture.created.filter((resource): resource is Observation =>
    resource.resourceType === "Observation" &&
    resource.code.coding?.some((coding) => coding.code === "AXIAL_LENGTH") === true);
  assert.equal(axial.length, 2);
  assert.equal(axial.every((observation) =>
    !JSON.stringify(observation).includes("eye-growth") &&
    !JSON.stringify(observation).includes("myopia-management")), true);
  assert.equal(axial.every((observation) =>
    observation.meta?.profile?.includes(OBSERVATION_AXIAL_LENGTH_PROFILE_URL)), true);
  assert.deepEqual(
    axial.map((observation) => observation.component?.find((component) =>
      component.code.coding?.some((coding) => coding.code === "biometryMethod"),
    )?.valueCodeableConcept?.coding?.[0]?.code).sort(),
    ["OPTICAL_BIOMETRY", "ULTRASOUND_A_SCAN"],
  );

  const history = await handleMyopiaHistoryRequest(fixture.deps, {
    authHeader: AUTH,
    query: { patient: PATIENT_REFERENCE },
  });
  assert.equal(history.status, 200);
  const body = history.body as MyopiaProgressionHistoryResponse;
  assert.equal(body.readings.length, 2);
  assert.deepEqual(body.readings.map((reading) => reading.eye).sort(), ["OD", "OS"]);
  assert.equal(body.readings.find((reading) => reading.eye === "OD")?.instrument, "IOLMaster 700");
  assert.equal(body.readings.find((reading) => reading.eye === "OD")?.cornealRadiusMm, 7.78);
  assert.equal(body.referenceDataset?.rows.length, 15);
  assert.match(body.referenceDataset?.populationNote ?? "", /50th percentile here is typical for this cohort/);
});

test("a persisted NOT_REPRESENTED setting renders on the European curve without rewriting storage", async () => {
  const fixture = endpointFixture("NOT_REPRESENTED");
  await handleMyopiaCaptureRequest(fixture.deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT_REFERENCE,
      encounterReference: ENCOUNTER_REFERENCE,
      measuredAt: MEASURED_AT,
      eyes: {
        OD: { axialLengthMm: 25.02, biometryMethod: "OPTICAL_BIOMETRY" },
      },
    },
  });
  const history = await handleMyopiaHistoryRequest(fixture.deps, {
    authHeader: AUTH,
    query: { patient: PATIENT_REFERENCE },
  });
  const body = history.body as MyopiaProgressionHistoryResponse;
  assert.equal(body.readings.length, 1);
  assert.equal(body.referencePopulation, "CAUCASIAN");
  assert.equal(body.referenceDataset?.datasetId, "truckenbrod-2021-german-axial-length");
  assert.deepEqual(body.referenceDataset?.percentiles, [2, 25, 50, 75, 98]);
  assert.equal(body.noReferenceMessage, null);
});

test("Eye Growth returns independently classified refraction candidates with a cycloplegic default", async () => {
  const fixture = endpointFixture("CAUCASIAN");
  await handleMyopiaCaptureRequest(fixture.deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT_REFERENCE,
      encounterReference: ENCOUNTER_REFERENCE,
      measuredAt: MEASURED_AT,
      eyes: {
        OD: { axialLengthMm: 23.61, biometryMethod: "OPTICAL_BIOMETRY" },
      },
    },
  });
  fixture.created.push(
    refractionObservation({
      id: "legacy-manifest",
      system: LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      type: "MANIFEST",
      effectiveDateTime: "2026-07-24T10:00:00.000Z",
      sphere: -1.5,
    }),
    refractionObservation({
      id: "current-cycloplegic",
      system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      type: "CYCLOPLEGIC",
      effectiveDateTime: "2026-07-24T11:00:00.000Z",
      sphere: -0.25,
    }),
    refractionObservation({
      id: "future-manifest",
      system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      type: "MANIFEST",
      effectiveDateTime: "2026-07-26T10:00:00.000Z",
      sphere: -4,
    }),
  );

  const history = await handleMyopiaHistoryRequest(fixture.deps, {
    authHeader: AUTH,
    query: { patient: PATIENT_REFERENCE },
  });
  const body = history.body as MyopiaProgressionHistoryResponse;

  assert.equal(history.status, 200);
  assert.equal(body.readings.length, 1);
  assert.deepEqual(body.readings[0]?.refractiveStatus, {
    status: "PRE_MYOPIA",
    sphericalEquivalent: -0.25,
    refractionType: "CYCLOPLEGIC",
    refractionDate: "2026-07-24T11:00:00.000Z",
    observationReference: "Observation/current-cycloplegic",
    candidates: [
      {
        refractionType: "CYCLOPLEGIC",
        sphericalEquivalent: -0.25,
        status: "PRE_MYOPIA",
        refractionDate: "2026-07-24T11:00:00.000Z",
        observationReference: "Observation/current-cycloplegic",
      },
      {
        refractionType: "MANIFEST",
        sphericalEquivalent: -1.5,
        status: "MYOPIC",
        refractionDate: "2026-07-24T10:00:00.000Z",
        observationReference: "Observation/legacy-manifest",
      },
    ],
  });
  const refractionSearch = fixture.searches.find((params) =>
    params.code?.includes("REFRACTION"));
  assert.equal(
    refractionSearch?.code,
    `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|REFRACTION,${LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|REFRACTION`,
  );
});

test("a first-visit refraction saved after axial length pairs by encounter and resolves MYOPIC", async () => {
  const fixture = endpointFixture("CAUCASIAN");
  await handleMyopiaCaptureRequest(fixture.deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT_REFERENCE,
      encounterReference: ENCOUNTER_REFERENCE,
      measuredAt: MEASURED_AT,
      eyes: {
        OD: { axialLengthMm: 22.90, biometryMethod: "OPTICAL_BIOMETRY" },
      },
    },
  });
  fixture.created.push(
    refractionObservation({
      id: "first-visit-manifest",
      system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      type: "MANIFEST",
      effectiveDateTime: "2026-07-25T15:00:00.000Z",
      sphere: -1.25,
      encounterReference: ENCOUNTER_REFERENCE,
      status: "preliminary",
    }),
  );

  const history = await handleMyopiaHistoryRequest(fixture.deps, {
    authHeader: AUTH,
    query: { patient: PATIENT_REFERENCE },
  });
  const body = history.body as MyopiaProgressionHistoryResponse;

  assert.equal(history.status, 200);
  assert.equal(body.readings.length, 1);
  assert.equal(body.readings[0]?.refractiveStatus.status, "MYOPIC");
  assert.equal(
    body.readings[0]?.refractiveStatus.observationReference,
    "Observation/first-visit-manifest",
  );
});

test("latest consecutive same-method readings calculate the rate independently per eye", () => {
  const thresholds = MYOPIA_REFERENCE_DATASET_REGISTRY.axialGrowthRateThresholds();
  assert.ok(thresholds);
  const rates = calculateAxialGrowthRates([
    growthReading("OD", 9.0, 24.00, "OPTICAL_BIOMETRY", "2025-01-01T00:00:00Z", "od-1"),
    growthReading("OS", 9.1, 24.10, "ULTRASOUND_A_SCAN", "2025-02-01T00:00:00Z", "os-1"),
    growthReading("OD", 9.5, 24.10, "OPTICAL_BIOMETRY", "2025-07-02T00:00:00Z", "od-2"),
    growthReading("OS", 10.1, 24.30, "ULTRASOUND_A_SCAN", "2026-02-01T00:00:00Z", "os-2"),
  ], thresholds);

  assert.equal(rates.length, 2);
  assert.ok(Math.abs(rates[0]!.mmPerYear! - 0.2) < 1e-9);
  assert.equal(rates[0]!.classification, "NORMAL");
  assert.ok(Math.abs(rates[1]!.mmPerYear! - 0.2) < 1e-9);
  assert.equal(rates[1]!.classification, "WATCH");
});

test("growth-rate guards suppress short, mixed-method, and first-visit intervals", () => {
  const thresholds = MYOPIA_REFERENCE_DATASET_REGISTRY.axialGrowthRateThresholds();
  assert.ok(thresholds);
  assert.deepEqual(calculateAxialGrowthRates([
    growthReading("OD", 9.0, 24.00, "OPTICAL_BIOMETRY", "2025-01-01T00:00:00Z", "od-1"),
  ], thresholds), []);

  const short = calculateAxialGrowthRates([
    growthReading("OD", 9.0, 24.00, "OPTICAL_BIOMETRY", "2025-01-01T00:00:00Z", "od-1"),
    growthReading("OD", 9.49, 24.03, "OPTICAL_BIOMETRY", "2025-06-29T00:00:00Z", "od-2"),
  ], thresholds);
  assert.equal(short[0]?.status, "INTERVAL_TOO_SHORT");
  assert.equal(short[0]?.mmPerYear, null);

  const mixedMethod = calculateAxialGrowthRates([
    growthReading("OD", 8.0, 23.80, "OPTICAL_BIOMETRY", "2024-01-01T00:00:00Z", "od-0"),
    growthReading("OD", 9.0, 24.00, "OPTICAL_BIOMETRY", "2025-01-01T00:00:00Z", "od-1"),
    growthReading("OD", 10.0, 24.20, "ULTRASOUND_A_SCAN", "2026-01-01T00:00:00Z", "od-2"),
  ], thresholds);
  assert.equal(mixedMethod[0]?.status, "BIOMETRY_METHOD_CHANGED");
  assert.equal(mixedMethod[0]?.mmPerYear, null);
});

test("out-of-range history omits bands but preserves the patient series and qualifying rate", async () => {
  const fixture = endpointFixture("CAUCASIAN", { now: () => "2021-07-25T14:00:00.000Z" });
  for (const [measuredAt, axialLengthMm] of [
    ["2020-07-25T14:00:00.000Z", 22.40],
    ["2021-07-25T14:00:00.000Z", 22.56],
  ] as const) {
    const capture = await handleMyopiaCaptureRequest(fixture.deps, {
      authHeader: AUTH,
      body: {
        patientReference: PATIENT_REFERENCE,
        encounterReference: ENCOUNTER_REFERENCE,
        measuredAt,
        eyes: {
          OD: { axialLengthMm, biometryMethod: "OPTICAL_BIOMETRY" },
        },
      },
    });
    assert.equal(capture.status, 200);
  }

  const history = await handleMyopiaHistoryRequest(fixture.deps, {
    authHeader: AUTH,
    query: { patient: PATIENT_REFERENCE },
  });
  const body = history.body as MyopiaProgressionHistoryResponse;
  assert.equal(history.status, 200);
  assert.equal(body.readings.length, 2);
  assert.equal(body.referenceDataset, null);
  assert.equal(
    body.noReferenceMessage,
    "No reference data covers this age. Patient measurements are shown without reference bands.",
  );
  assert.equal(body.growthRates?.length, 1);
  assert.equal(body.growthRates?.[0]?.status, "AVAILABLE");
  assert.ok(Math.abs(body.growthRates?.[0]?.mmPerYear ?? 0) > 0);
});

test("missing growth-rate threshold config returns history with readings and bands but omits rates", async () => {
  const dataset = syntheticTabulatedDataset(6, 15, "AXIAL_LENGTH");
  delete dataset.axialGrowthRateThresholds;
  const registry = new ReferenceDatasetRegistry([dataset]);
  const fixture = endpointFixture("ASIAN", {
    bandProvider: new PercentileBandProvider(registry),
    referenceDatasetRegistry: registry,
  });
  for (const [measuredAt, axialLengthMm] of [
    ["2025-07-25T14:00:00.000Z", 23.90],
    ["2026-07-25T14:00:00.000Z", 24.06],
  ] as const) {
    const capture = await handleMyopiaCaptureRequest(fixture.deps, {
      authHeader: AUTH,
      body: {
        patientReference: PATIENT_REFERENCE,
        encounterReference: ENCOUNTER_REFERENCE,
        measuredAt,
        eyes: {
          OD: { axialLengthMm, biometryMethod: "OPTICAL_BIOMETRY" },
        },
      },
    });
    assert.equal(capture.status, 200);
  }

  const history = await handleMyopiaHistoryRequest(fixture.deps, {
    authHeader: AUTH,
    query: { patient: PATIENT_REFERENCE },
  });
  const body = history.body as MyopiaProgressionHistoryResponse;
  assert.equal(history.status, 200);
  assert.equal(body.readings.length, 2);
  assert.ok(body.referenceDataset);
  assert.equal(body.noReferenceMessage, null);
  assert.equal("growthRates" in body, false);
});

test("growth-rate classifications honor configured age and rate boundaries", () => {
  const configured = {
    ageBoundaryYears: 10,
    younger: { normalUpperMmPerYear: 0.2, watchUpperMmPerYear: 0.3 },
    older: { normalUpperMmPerYear: 0.1, watchUpperMmPerYear: 0.2 },
  };
  for (const [age, rate, expected] of [
    [9.9, 0.2, "NORMAL"],
    [9.9, 0.3, "WATCH"],
    [9.9, 0.3001, "FLAG"],
    [10.1, 0.1, "NORMAL"],
    [10.1, 0.2, "WATCH"],
    [10.1, 0.2001, "FLAG"],
  ] as const) {
    const result = calculateAxialGrowthRates([
      growthReading("OD", age - 1, 24, "OPTICAL_BIOMETRY", "2025-01-01T00:00:00Z", "od-1"),
      growthReading("OD", age, 24 + rate, "OPTICAL_BIOMETRY", "2026-01-01T00:00:00Z", "od-2"),
    ], configured);
    assert.equal(result[0]?.classification, expected, `age ${age}, rate ${rate}`);
  }

  const custom = calculateAxialGrowthRates([
    growthReading("OD", 8.9, 24, "OPTICAL_BIOMETRY", "2025-01-01T00:00:00Z", "od-1"),
    growthReading("OD", 9.9, 24.22, "OPTICAL_BIOMETRY", "2026-01-01T00:00:00Z", "od-2"),
  ], {
    ...configured,
    younger: { normalUpperMmPerYear: 0.25, watchUpperMmPerYear: 0.35 },
  });
  assert.equal(custom[0]?.classification, "NORMAL");
});

test("reference-population migration succeeds on fresh and populated Postgres databases", { timeout: 30_000 }, async (t) => {
  const adminUrl = process.env.ODOS_TEST_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_TEST_POSTGRES_URL is required for the destructive local myopia migration fixture.");
    return;
  }
  const adminTarget = new URL(adminUrl);
  assert.ok(
    adminTarget.hostname === "localhost" || adminTarget.hostname === "127.0.0.1",
    "ODOS_TEST_POSTGRES_URL must use localhost or 127.0.0.1.",
  );
  const admin = new Client({ connectionString: adminUrl });
  const databaseNames = [
    `odos_myopia_fresh_${randomUUID().replaceAll("-", "")}`,
    `odos_myopia_populated_${randomUUID().replaceAll("-", "")}`,
  ];
  await admin.connect();
  try {
    for (const [index, databaseName] of databaseNames.entries()) {
      await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
      const target = new URL(adminTarget);
      target.pathname = `/${databaseName}`;
      const store = new PgMyopiaReferencePopulationStore({ postgresUrl: target.toString() });
      const probe = new Client({ connectionString: target.toString() });
      try {
        if (index === 1) {
          await probe.connect();
          await probe.query(`
            CREATE TABLE synthetic_existing_patient_data (
              patient_reference TEXT PRIMARY KEY,
              display_name TEXT NOT NULL
            )
          `);
          await probe.query(
            "INSERT INTO synthetic_existing_patient_data VALUES ($1, $2)",
            ["Patient/existing", "Synthetic Existing Patient"],
          );
        }
        assert.deepEqual(await store.get("Patient/existing"), {
          patientReference: "Patient/existing",
          referencePopulation: "CAUCASIAN",
        });
        const saved = await store.set({
          patientReference: "Patient/existing",
          referencePopulation: "ASIAN",
          updatedBy: "Practitioner/doc1",
          updatedAt: MEASURED_AT,
        });
        assert.equal(saved.referencePopulation, "ASIAN");
        const deliberatelyNone = await store.set({
          patientReference: "Patient/existing",
          referencePopulation: "NOT_REPRESENTED",
          updatedBy: "Practitioner/doc1",
          updatedAt: MEASURED_AT,
        });
        assert.equal(deliberatelyNone.referencePopulation, "NOT_REPRESENTED");
        assert.equal((await store.get("Patient/existing")).referencePopulation, "NOT_REPRESENTED");
        if (index === 1) {
          const existing = await probe.query(
            "SELECT display_name FROM synthetic_existing_patient_data WHERE patient_reference = $1",
            ["Patient/existing"],
          );
          assert.equal(existing.rows[0]?.display_name, "Synthetic Existing Patient");
        }
      } finally {
        await store.close();
        await probe.end().catch(() => undefined);
      }
    }
  } finally {
    for (const databaseName of databaseNames) {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    }
    await admin.end();
  }
});

function endpointFixture(
  referencePopulation: MyopiaPatientSettings["referencePopulation"],
  overrides: Partial<MyopiaProgressionEndpointDeps> = {},
) {
  const created: Array<Observation | Provenance> = [];
  const searches: Array<Record<string, string>> = [];
  const settingsStore: MyopiaReferencePopulationStore = {
    get: async (patientReference) => ({ patientReference, referencePopulation }),
    set: async (input) => input,
  };
  const deps: MyopiaProgressionEndpointDeps = {
    settingsStore,
    now: () => MEASURED_AT,
    authenticate: async (authHeader) => authHeader === AUTH
      ? {
          staffReference: "Practitioner/doc1",
          actorRole: "clinician",
          fhir: {
            create: async <T extends Observation | Provenance>(resource: T): Promise<T> => {
              const copy = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${created.length + 1}` };
              created.push(copy);
              return copy;
            },
            read: async <T extends Patient>(): Promise<T> => ({
              resourceType: "Patient",
              id: "p1",
              birthDate: "2016-07-25",
              gender: "male",
            } as T),
            search: async <T extends Observation>(
              _resourceType: "Observation",
              params?: Record<string, string>,
            ): Promise<Bundle<T>> => {
              searches.push(params ?? {});
              const code = params?.code?.split("|").at(-1);
              const resources = created.filter((resource): resource is Observation =>
                resource.resourceType === "Observation" &&
                resource.code.coding?.some((coding) => coding.code === code) === true);
              return {
                resourceType: "Bundle",
                type: "searchset",
                entry: resources.map((resource) => ({
                  resource: {
                    ...resource,
                    ...(code === "CORNEAL_RADIUS" && resource.effectiveDateTime
                      ? { effectiveDateTime: resource.effectiveDateTime.replace(".000Z", "Z") }
                      : {}),
                  } as T,
                })),
              };
            },
          },
        }
      : null,
    ...overrides,
  };
  return { created, searches, deps };
}

function syntheticTabulatedDataset(
  ageRangeMin: number,
  ageRangeMax: number,
  measure: PercentileBandsDataset["measure"],
): PercentileBandsDataset {
  const rows = Array.from(
    { length: ageRangeMax - ageRangeMin + 1 },
    (_, index) => ({
      age: ageRangeMin + index,
      values: measure === "AXIAL_LENGTH"
        ? [20 + index * 0.1, 21 + index * 0.1, 22 + index * 0.1]
        : [2.8 + index * 0.01, 3 + index * 0.01, 3.2 + index * 0.01],
    }),
  );
  return {
    datasetId: `synthetic-${measure.toLowerCase()}-${ageRangeMin}-${ageRangeMax}`,
    version: "1.0.0",
    citation: "Synthetic regression fixture.",
    populationNote: "Synthetic regression fixture; not for clinical use.",
    medianRepresentsHealthy: false,
    populationsCovered: ["ASIAN", "CAUCASIAN"],
    sexStratified: true,
    ageRangeMin,
    ageRangeMax,
    measure,
    modelType: "PERCENTILE_BANDS",
    zoneThresholds: { neutralUpper: 3, typicalUpper: 50, borderlineUpper: 95 },
    axialGrowthRateThresholds: {
      ageBoundaryYears: 10,
      younger: { normalUpperMmPerYear: 0.2, watchUpperMmPerYear: 0.3 },
      older: { normalUpperMmPerYear: 0.1, watchUpperMmPerYear: 0.2 },
    },
    payload: {
      type: "TABULATED_BANDS",
      percentiles: [3, 50, 95],
      tables: { MALE: rows, FEMALE: rows.map((row) => ({ ...row, values: [...row.values] })) },
    },
  };
}

function growthReading(
  eye: "OD" | "OS",
  ageInYears: number,
  axialLengthMm: number,
  biometryMethod: "OPTICAL_BIOMETRY" | "ULTRASOUND_A_SCAN",
  measuredAt: string,
  observationId: string,
) {
  return {
    eye,
    axialLengthMm,
    cornealRadiusMm: null,
    ageInYears,
    measuredAt,
    biometryMethod,
    instrument: null,
    observationReference: `Observation/${observationId}`,
    refractiveStatus: {
      status: "UNKNOWN" as const,
      sphericalEquivalent: null,
      refractionType: null,
      refractionDate: null,
      observationReference: null,
      candidates: [],
    },
  };
}

function refractionObservation(input: {
  id: string;
  system: string;
  type: string;
  effectiveDateTime: string;
  sphere: number;
  encounterReference?: string;
  status?: Observation["status"];
}): Observation {
  const concept = (code: string) => ({ coding: [{ system: input.system, code }] });
  return {
    resourceType: "Observation",
    id: input.id,
    status: input.status ?? "final",
    code: concept("REFRACTION"),
    subject: { reference: PATIENT_REFERENCE },
    ...(input.encounterReference
      ? { encounter: { reference: input.encounterReference } }
      : {}),
    effectiveDateTime: input.effectiveDateTime,
    bodySite: concept("OD"),
    component: [
      {
        code: concept("REFRACTION_TYPE"),
        valueCodeableConcept: concept(input.type),
      },
      {
        code: concept("SPHERE"),
        valueQuantity: {
          value: input.sphere,
          unit: "D",
          system: "http://unitsofmeasure.org",
          code: "[diop]",
        },
      },
    ],
  };
}
