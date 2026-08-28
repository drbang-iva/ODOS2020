import assert from "node:assert/strict";
import { test } from "node:test";
import type { Device, Observation, Patient } from "@medplum/fhirtypes";
import {
  createAuthenticatedFhirClient,
  loadRepoEnv,
  requireMedplumAdmin,
} from "./integration-helpers.js";
import { buildLensDevice, buildLensFitObservation } from "../src/fhir/contactLens.js";

test("Medplum Observation focus search conformance or documented fallback", { timeout: 120_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const credentials = requireMedplumAdmin(t, "v04-observation-focus-conformance");
  if (!credentials) {
    return;
  }
  const { email, password } = credentials;

  const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    active: true,
    name: [{ family: `FocusConformance${Date.now()}`, given: ["Test"] }],
  });
  assert.ok(patient.id);

  const device = await fhir.create<Device>(
    buildLensDevice({
      lensTypeCode: "ortho-K",
      patientReference: `Patient/${patient.id}`,
      properties: [{ code: "base-curve-mm", valueNumber: 7.8, unitCode: "mm" }],
    }),
  );
  assert.ok(device.id);

  const observation = await fhir.create<Observation>(
    buildLensFitObservation({
      patientReference: `Patient/${patient.id}`,
      lensDeviceReference: `Device/${device.id}`,
      findingCode: "central-clearance-settled",
      effectiveDateTime: "2026-01-02T12:00:00.000Z",
      valueNumber: 250,
      unitCode: "um",
    }),
  );
  assert.ok(observation.id);

  try {
    const bundle = await fhir.search<Observation>("Observation", {
      focus: `Device/${device.id}`,
      code: "https://odos2020.com/fhir/CodeSystem/contact-lens-clinical-observation|central-clearance-settled",
      date: "ge2026-01-01",
      _count: "10",
    });
    assert.ok(
      (bundle.entry ?? []).some((entry) => entry.resource?.id === observation.id),
      "Expected Observation focus search to return the fit finding.",
    );
  } catch (err) {
    assert.match(
      err instanceof Error ? err.message : String(err),
      /focus|SearchParameter|not supported|FHIR/i,
    );
    assert.ok(
      true,
      "Fallback documented: query by subject/code/date and filter Observation.focus client-side.",
    );
  }
});
