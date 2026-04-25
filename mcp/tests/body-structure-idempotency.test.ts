import assert from "node:assert/strict";
import { test } from "node:test";
import type { BodyStructure, Encounter, Patient } from "@medplum/fhirtypes";
import {
  createAuthenticatedFhirClient,
  loadRepoEnv,
} from "./integration-helpers.js";
import { buildSectionSaveBundle } from "../src/fhir/ophthalmology/save-section-bundle.js";

test("section saves reuse BodyStructure by patient and location", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum integration tests.");
    return;
  }

  const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    name: [{ family: `BodyStructureIdempotency${Date.now()}`, given: ["Test"] }],
  });
  const encounter = await fhir.create<Encounter>({
    resourceType: "Encounter",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${patient.id}` },
    period: { start: new Date().toISOString() },
  });

  await saveIop(fhir, patient.id!, encounter.id!, "OD", 14);
  const odAfterFirst = await searchBodyStructures(fhir, patient.id!, "18944008");
  assert.equal(odAfterFirst.length, 1);

  await saveIop(fhir, patient.id!, encounter.id!, "OD", 15);
  const odAfterSecond = await searchBodyStructures(fhir, patient.id!, "18944008");
  assert.equal(odAfterSecond.length, 1);
  assert.equal(odAfterSecond[0].id, odAfterFirst[0].id);

  await saveIop(fhir, patient.id!, encounter.id!, "OS", 16);
  const osAfterFirst = await searchBodyStructures(fhir, patient.id!, "8966001");
  assert.equal(osAfterFirst.length, 1);
  assert.notEqual(osAfterFirst[0].id, odAfterFirst[0].id);

  const morphologySearch = await fhir.search<BodyStructure>("BodyStructure", {
    patient: `Patient/${patient.id}`,
    morphology: "18944008",
    _count: "10",
  });
  assert.equal(morphologySearch.entry?.length ?? 0, 0);
});

async function saveIop(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  patientId: string,
  encounterId: string,
  laterality: "OD" | "OS",
  value: number,
): Promise<void> {
  const response = await fhir.executeTransaction(
    buildSectionSaveBundle({
      patientReference: `Patient/${patientId}`,
      encounterReference: `Encounter/${encounterId}`,
      section: "iop",
      operatorDisplay: "OSOD body structure idempotency test",
      entries: [{ laterality, value, method: "GAT" }],
    }),
  );
  assert.ok(response.entry?.every((entry) => entry.response?.status?.match(/^2\d\d/)));
}

async function searchBodyStructures(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  patientId: string,
  location: string,
): Promise<BodyStructure[]> {
  const bundle = await fhir.search<BodyStructure>("BodyStructure", {
    patient: `Patient/${patientId}`,
    location,
    _count: "10",
  });
  return (bundle.entry ?? []).flatMap((entry) => (entry.resource ? [entry.resource] : []));
}
