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
} from "../src/clinical-graph/myopia-reference-dataset.js";
import { buildMyopiaFindingDefinitions } from "../src/clinical-graph/myopia-finding-definition.js";
import {
  handleMyopiaCaptureRequest,
  handleMyopiaHistoryRequest,
  type MyopiaProgressionEndpointDeps,
  type MyopiaProgressionHistoryResponse,
} from "../src/clinical-graph/myopia-progression-endpoint.js";
import type {
  MyopiaPatientSettings,
  MyopiaReferencePopulationStore,
} from "../src/clinical-graph/myopia-reference-population-store.js";
import { PgMyopiaReferencePopulationStore } from "../src/clinical-graph/myopia-reference-population-store.js";

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
  const dataset = loadReferenceDatasetSeeds()[0];
  assert.ok(dataset);
  const results = evaluateTranscriptionInvariants(dataset);
  for (const result of results) {
    console.log(`${result.invariant}: checks=${result.checks} violations=${result.violations.length}`);
    assert.deepEqual(result.violations, []);
  }
  assert.deepEqual(
    results.map((result) => [result.invariant, result.checks]),
    [["V1", 210], ["V2", 224], ["V3", 224], ["V4", 240], ["V5", 1]],
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

  for (const input of [
    { population: "CAUCASIAN" as const, ageInYears: 10 },
    { population: "NOT_REPRESENTED" as const, ageInYears: 10 },
    { population: "ASIAN" as const, ageInYears: 3.99 },
    { population: "ASIAN" as const, ageInYears: 18.01 },
  ]) {
    assert.equal(MYOPIA_REFERENCE_BAND_PROVIDER.getBands({
      measure: "AXIAL_LENGTH",
      sex: "FEMALE",
      ...input,
    }), null);
  }
});

test("clinical graph round-trip preserves both eyes, required method, and optional instrument", async () => {
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

test("NOT_REPRESENTED history returns patient series with zero reference bands", async () => {
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
  assert.equal(body.referenceDataset, null);
  assert.equal(
    body.noReferenceMessage,
    "No validated reference data exists for this population. Patient measurements are shown without reference bands.",
  );
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
          referencePopulation: "NOT_REPRESENTED",
        });
        const saved = await store.set({
          patientReference: "Patient/existing",
          referencePopulation: "ASIAN",
          updatedBy: "Practitioner/doc1",
          updatedAt: MEASURED_AT,
        });
        assert.equal(saved.referencePopulation, "ASIAN");
        if (index === 1) {
          const existing = await probe.query(
            "SELECT display_name FROM synthetic_existing_patient_data WHERE patient_reference = $1",
            ["Patient/existing"],
          );
          assert.equal(existing.rows[0]?.display_name, "Synthetic Existing Patient");
        }
        console.log(`migration fixture: ${index === 0 ? "fresh" : "populated"} database passed`);
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

function endpointFixture(referencePopulation: MyopiaPatientSettings["referencePopulation"]) {
  const created: Array<Observation | Provenance> = [];
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
              const code = params?.code?.split("|").at(-1);
              const resources = created.filter((resource): resource is Observation =>
                resource.resourceType === "Observation" &&
                resource.code.coding?.some((coding) => coding.code === code) === true);
              return {
                resourceType: "Bundle",
                type: "searchset",
                entry: resources.map((resource) => ({ resource: resource as T })),
              };
            },
          },
        }
      : null,
  };
  return { created, deps };
}
