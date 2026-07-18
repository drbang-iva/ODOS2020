import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Patient } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import {
  createPatientDemographicsActions,
  emptyPatientDemographics,
  patientDemographicsFromPatient,
  registerPatient,
  validatePatientDemographics,
  type PatientDemographicsDraft,
} from "../src/lib/patient-registration";
import { DuplicatePatientWarning } from "../src/scenes/NewPatient";

const COMPLETE_DRAFT: PatientDemographicsDraft = {
  firstName: "Jane",
  middleName: "Q",
  lastName: "Doe",
  preferredName: "Janie",
  birthDate: "1980-01-02",
  gender: "female",
  phone: "864-555-0100",
  email: "jane@example.test",
  address: "1 Main St",
  city: "Greenville",
  state: "SC",
  postalCode: "29601",
};

const EXISTING: Patient = {
  resourceType: "Patient",
  id: "patient-1",
  meta: { versionId: "3" },
  name: [{ use: "official", given: ["Jane", "Q"], family: "Doe" }, { use: "usual", given: ["Janie"] }],
  birthDate: "1980-01-02",
  gender: "female",
  telecom: [{ system: "phone", use: "home", value: "864-555-0100" }, { system: "email", use: "home", value: "jane@example.test" }],
  address: [{ use: "home", line: ["1 Main St"], city: "Greenville", state: "SC", postalCode: "29601" }],
};

test("exact duplicate search returns a warning result and does not create", async () => {
  let createCalls = 0;
  let searchParams: Record<string, string> | undefined;
  const api = {
    search: async (_resourceType: string, params: Record<string, string>) => {
      searchParams = params;
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: EXISTING }] } as Bundle<Patient>;
    },
    create: async (patient: Patient) => { createCalls += 1; return patient; },
    update: async (patient: Patient) => patient,
  };
  const result = await registerPatient(COMPLETE_DRAFT, api as never);
  assert.equal(result.kind, "duplicates");
  assert.equal(createCalls, 0);
  assert.deepEqual(searchParams, { given: "Jane", family: "Doe", birthdate: "1980-01-02" });
  const html = renderToStaticMarkup(<DuplicatePatientWarning patients={[EXISTING]} saving={false} onUseExisting={() => undefined} onBack={() => undefined} onCreateAnyway={() => undefined} />);
  assert.match(html, /Possible duplicate patient/);
  assert.match(html, /Jane Q Doe/);
  assert.match(html, /DOB 1980-01-02 · ID patient-1/);
  assert.match(html, /Use existing patient/);
  assert.match(html, /Create anyway/);
});

test("no exact duplicate creates the patient with the registration source tag", async () => {
  let sourceTag = "";
  let created: Patient | undefined;
  const api = {
    search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [{ resource: { ...EXISTING, name: [{ use: "official", given: ["Janet"], family: "Doe" }] } }] }) as Bundle<Patient>,
    create: async (patient: Patient, source: string) => { created = patient; sourceTag = source; return { ...patient, id: "patient-2" }; },
    update: async (patient: Patient) => patient,
  };
  const result = await registerPatient(COMPLETE_DRAFT, api as never);
  assert.equal(result.kind, "created");
  assert.equal(sourceTag, "patient-registration");
  assert.equal(created?.name?.find((name) => name.use === "usual")?.given?.[0], "Janie");
  assert.equal(created?.telecom?.find((entry) => entry.system === "phone")?.value, "864-555-0100");
});

test("required fields block creation while address and email remain optional", () => {
  const blank = emptyPatientDemographics();
  const blankErrors = validatePatientDemographics(blank);
  assert.deepEqual(Object.keys(blankErrors).sort(), ["birthDate", "firstName", "gender", "lastName", "phone"]);
  const optionalAbsent = validatePatientDemographics({ ...COMPLETE_DRAFT, address: "", city: "", state: "", postalCode: "", email: "" });
  assert.deepEqual(optionalAbsent, {});
  assert.match(validatePatientDemographics({ ...COMPLETE_DRAFT, birthDate: "2026-02-30" }).birthDate, /valid YYYY-MM-DD/);
  assert.match(validatePatientDemographics({ ...COMPLETE_DRAFT, phone: "123" }).phone, /valid phone/);
});

test("demographics editor loads shared Patient fields, saves with the update source tag, and discards without a write", async () => {
  const loaded = patientDemographicsFromPatient(EXISTING);
  assert.deepEqual(loaded, COMPLETE_DRAFT);
  const html = renderToStaticMarkup(<PatientDemographicsEditor patient={EXISTING} onSaved={() => undefined} onDiscard={() => undefined} />);
  assert.match(html, /value="Jane"/);
  assert.match(html, /value="Janie"/);
  assert.match(html, /value="864-555-0100"/);

  let updates = 0;
  let sourceTag = "";
  const actions = createPatientDemographicsActions(EXISTING, {
    update: async (patient: Patient, source: string) => { updates += 1; sourceTag = source; return patient; },
  } as never);
  const changed = { ...loaded, firstName: "Janet" };
  const saved = await actions.save(changed);
  assert.equal(saved.name?.find((name) => name.use === "official")?.given?.[0], "Janet");
  assert.equal(sourceTag, "patient-demographics-update");
  assert.equal(updates, 1);
  assert.deepEqual(actions.discard(), COMPLETE_DRAFT);
  assert.equal(updates, 1);
});
