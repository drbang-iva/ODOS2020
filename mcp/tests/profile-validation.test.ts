import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { before, test } from "node:test";
import type { BodyStructure, Encounter, Observation, Patient, StructureDefinition } from "@medplum/fhirtypes";
import {
  createAuthenticatedFhirClient,
  loadRepoEnv,
} from "./integration-helpers.js";
import { buildEyeBodyStructure, BODY_SITE_REFERENCE_EXTENSION_URL } from "../src/fhir/ophthalmology/bodyStructure.js";
import { osodConcept } from "../src/fhir/ophthalmology/extensions.js";
import { buildIopObservation } from "../src/fhir/ophthalmology/iop.js";
import { buildRefractionObservation } from "../src/fhir/ophthalmology/refraction.js";
import { buildVisualAcuityObservation } from "../src/fhir/ophthalmology/visualAcuity.js";

const PROFILE = {
  encounter: "https://osod.dev/fhir/StructureDefinition/Encounter-ComprehensiveExam",
  va: "https://osod.dev/fhir/StructureDefinition/Observation-VA",
  iop: "https://osod.dev/fhir/StructureDefinition/Observation-IOP",
  refraction: "https://osod.dev/fhir/StructureDefinition/Observation-Refraction",
  axial: "https://osod.dev/fhir/StructureDefinition/Observation-AxialLength",
} as const;

let fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"];
let patient: Patient;
let encounter: Encounter;
let bodyStructure: BodyStructure;
let profileValidationSetup: Promise<void> | undefined;

const MEDPLUM_SKIP_MESSAGE =
  "MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum integration tests.";

before(async () => {
  loadRepoEnv();
});

async function setupProfileValidationFixture(baseUrl: string, email: string, password: string): Promise<void> {
  ({ fhir } = await createAuthenticatedFhirClient({ baseUrl, email, password }));
  await installProfilesForTest();
  patient = await fhir.create<Patient>({
    resourceType: "Patient",
    name: [{ family: `ProfileValidation${Date.now()}`, given: ["Test"] }],
  });
  encounter = await fhir.create<Encounter>(buildEncounter("in-progress"));
  bodyStructure = await fhir.create<BodyStructure>({
    ...buildEyeBodyStructure("OD", `Patient/${patient.id}`),
    id: undefined,
  });
}

async function ensureProfileValidationFixture(baseUrl: string, email: string, password: string): Promise<void> {
  profileValidationSetup ??= setupProfileValidationFixture(baseUrl, email, password);
  await profileValidationSetup;
}

async function installProfilesForTest(): Promise<void> {
  const profilesDir = resolve(process.cwd(), "../data/profiles");
  const files = (await readdir(profilesDir)).filter((file) => file.endsWith(".json")).sort();

  for (const file of files) {
    const profile = JSON.parse(
      await readFile(resolve(profilesDir, file), "utf8"),
    ) as StructureDefinition;
    const existingBundle = await fhir.search<StructureDefinition>("StructureDefinition", {
      url: profile.url,
      _count: "1",
    });
    const existing = existingBundle.entry?.[0]?.resource;
    if (existing?.id) {
      await fhir.update<StructureDefinition>(
        "StructureDefinition",
        existing.id,
        { ...profile, id: existing.id },
      );
    } else {
      await fhir.create<StructureDefinition>(profile);
    }
  }
}

// TODO(osod#11): integration tests skip when MEDPLUM env is unset. CI has no Medplum backend yet — see issue 11.
test("profile validation accepts conformant v0.3 resources", async (t) => {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip(MEDPLUM_SKIP_MESSAGE);
    return;
  }

  await ensureProfileValidationFixture(baseUrl, email, password);

  const resources = [
    buildVaObservation(),
    buildIopProfileObservation(),
    buildRefractionProfileObservation(),
    buildAxialLengthObservation(),
  ];

  for (const resource of resources) {
    const created = await fhir.create<Observation>(resource);
    assert.ok(created.id, `Expected ${resource.meta?.profile?.[0]} to create.`);
  }

  const createdEncounter = await fhir.create<Encounter>(buildEncounter("arrived"));
  assert.ok(createdEncounter.id, "Expected comprehensive Encounter to create.");
});

test("profile validation rejects IOP with non-UCUM pressure unit", async (t) => {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip(MEDPLUM_SKIP_MESSAGE);
    return;
  }

  await ensureProfileValidationFixture(baseUrl, email, password);

  const invalid = buildIopProfileObservation();
  invalid.valueQuantity = {
    ...invalid.valueQuantity,
    unit: "psi",
    code: "psi",
  };
  await assertRejectsProfile(invalid, /valueQuantity\.unit|mm\[Hg\]|Observation/);
});

test("profile validation rejects Observation missing bodySite reference extension", async (t) => {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip(MEDPLUM_SKIP_MESSAGE);
    return;
  }

  await ensureProfileValidationFixture(baseUrl, email, password);

  const invalid = buildVaObservation();
  invalid.bodySite = { ...invalid.bodySite, extension: [] };
  await assertRejectsProfile(invalid, /bodySite|Observation/);
});

test("profile validation rejects Observation missing encounter", async (t) => {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip(MEDPLUM_SKIP_MESSAGE);
    return;
  }

  await ensureProfileValidationFixture(baseUrl, email, password);

  const invalid = buildRefractionProfileObservation();
  delete invalid.encounter;
  await assertRejectsProfile(invalid, /encounter|Observation/);
});

test("profile validation rejects axial length with non-mm UCUM code", async (t) => {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip(MEDPLUM_SKIP_MESSAGE);
    return;
  }

  await ensureProfileValidationFixture(baseUrl, email, password);

  const invalid = buildAxialLengthObservation();
  invalid.valueQuantity = {
    ...invalid.valueQuantity,
    unit: "cm",
    code: "cm",
  };
  await assertRejectsProfile(invalid, /valueQuantity|mm|Observation/);
});

test("profile validation rejects comprehensive Encounter with non-AMB class", async (t) => {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip(MEDPLUM_SKIP_MESSAGE);
    return;
  }

  await ensureProfileValidationFixture(baseUrl, email, password);

  const invalid = buildEncounter("in-progress");
  invalid.class = {
    system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
    code: "EMER",
  };
  await assertRejectsProfile(invalid, /class|Encounter/);
});

test("profile validation rejects finished Encounter without period.end", async (t) => {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip(MEDPLUM_SKIP_MESSAGE);
    return;
  }

  await ensureProfileValidationFixture(baseUrl, email, password);

  const invalid = buildEncounter("finished");
  await assertRejectsProfile(invalid, /period\.end|Encounter|finished/);
});

function buildEncounter(status: Encounter["status"]): Encounter {
  return {
    resourceType: "Encounter",
    status,
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
    },
    subject: { reference: `Patient/${patient.id}` },
    period: { start: new Date().toISOString() },
    meta: { profile: [PROFILE.encounter] },
  };
}

function buildVaObservation(): Observation {
  const observation = buildVisualAcuityObservation({
    patientReference: `Patient/${patient.id}`,
    encounterReference: `Encounter/${encounter.id}`,
    eye: "OD",
    measuredAt: new Date().toISOString(),
    snellen: "20/20",
    chartType: "SNELLEN",
    correction: "SC",
  }).resource;
  return withProfile(withBodyStructureReference(observation), PROFILE.va);
}

function buildIopProfileObservation(): Observation {
  const observation = buildIopObservation({
    patientReference: `Patient/${patient.id}`,
    encounterReference: `Encounter/${encounter.id}`,
    eye: "OD",
    measuredAt: new Date().toISOString(),
    value: 14,
    method: osodConcept("GAT", "GAT"),
  }).resource;
  return withProfile(withBodyStructureReference(observation), PROFILE.iop);
}

function buildRefractionProfileObservation(): Observation {
  const observation = buildRefractionObservation({
    patientReference: `Patient/${patient.id}`,
    encounterReference: `Encounter/${encounter.id}`,
    eye: "OD",
    measuredAt: new Date().toISOString(),
    refractionType: "MANIFEST",
    sphere: -1.25,
    cylinder: -0.5,
    axis: 90,
  }).resource;
  return withProfile(withBodyStructureReference(observation), PROFILE.refraction);
}

function buildAxialLengthObservation(): Observation {
  return {
    resourceType: "Observation",
    status: "final",
    meta: { profile: [PROFILE.axial] },
    code: osodConcept("AXIAL_LENGTH", "Axial length"),
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "exam",
            display: "Exam",
          },
        ],
      },
    ],
    subject: { reference: `Patient/${patient.id}` },
    encounter: { reference: `Encounter/${encounter.id}` },
    effectiveDateTime: new Date().toISOString(),
    bodySite: {
      coding: [{ system: "https://osod.dev/fhir/CodeSystem/ophthalmology", code: "OD" }],
      extension: [
        {
          url: BODY_SITE_REFERENCE_EXTENSION_URL,
          valueReference: { reference: `BodyStructure/${bodyStructure.id}` },
        },
      ],
    },
    valueQuantity: {
      value: 24.1,
      unit: "mm",
      system: "http://unitsofmeasure.org",
      code: "mm",
    },
  };
}

function withProfile(observation: Observation, profile: string): Observation {
  return {
    ...observation,
    meta: { ...(observation.meta ?? {}), profile: [profile] },
  };
}

function withBodyStructureReference(observation: Observation): Observation {
  return {
    ...observation,
    contained: observation.contained?.filter((resource) => resource.resourceType !== "BodyStructure"),
    bodySite: {
      ...(observation.bodySite ?? {}),
      extension: [
        {
          url: BODY_SITE_REFERENCE_EXTENSION_URL,
          valueReference: { reference: `BodyStructure/${bodyStructure.id}` },
        },
      ],
    },
  };
}

async function assertRejectsProfile(resource: Observation | Encounter, pattern: RegExp): Promise<void> {
  await assert.rejects(
    () => fhir.create(resource),
    (err: unknown) => err instanceof Error && pattern.test(err.message),
  );
}
