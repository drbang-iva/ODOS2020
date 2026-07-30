import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Account,
  Bundle,
  Patient,
  Resource,
} from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import {
  createPatientDemographicsActions,
  createPatient,
  emptyPatientDemographics,
  patientDemographicsFromPatient,
  registerPatient,
  validatePatientDemographics,
  validatePatientRegistration,
  type PatientDemographicsDraft,
} from "../src/lib/patient-registration";
import {
  CONSENT_AUTHORITY_EXTENSION_URL,
  COURT_ORDER_NOTES_EXTENSION_URL,
  ODOS_MRN_SYSTEM,
  RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL,
  emptyRelatedResponsibleParty,
  formatOdosMrn,
  isValidOdosMrn,
  luhnCheckDigit,
} from "../src/lib/patient-identity";
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
  const api = new FakeRegistrationApi([
    { ...EXISTING, name: [{ use: "official", given: ["Janet"], family: "Doe" }] },
  ]);
  const result = await registerPatient(COMPLETE_DRAFT, api as never);
  assert.equal(result.kind, "created");
  assert.deepEqual(api.sourceTags, ["patient-mrn-reservation", "patient-registration"]);
  assert.equal(result.patient.name?.find((name) => name.use === "usual")?.given?.[0], "Janie");
  assert.equal(result.patient.telecom?.find((entry) => entry.system === "phone")?.value, "864-555-0100");
  assert.equal(isValidOdosMrn(result.patient.identifier?.find((identifier) => identifier.system === ODOS_MRN_SYSTEM)?.value ?? ""), true);
});

test("ODOS MRNs use a six-digit base plus a valid appended Luhn check digit", () => {
  const mrn = formatOdosMrn(100_001);
  assert.match(mrn, /^\d{7}$/);
  assert.equal(mrn.slice(6), luhnCheckDigit(mrn.slice(0, 6)));
  assert.equal(isValidOdosMrn(mrn), true);
  assert.equal(isValidOdosMrn(`${mrn.slice(0, 6)}${(Number(mrn[6]) + 1) % 10}`), false);
});

test("concurrent native registrations reserve unique MRNs when their first candidates collide", async () => {
  const api = new FakeRegistrationApi();
  const firstBases = [200_001];
  const secondBases = [200_001, 200_002];
  const [first, second] = await Promise.all([
    createPatient(COMPLETE_DRAFT, api as never, {
      today: "2026-07-30",
      nextMrnBase: () => firstBases.shift()!,
      nextUuid: sequentialUuid("first"),
    }),
    createPatient({ ...COMPLETE_DRAFT, firstName: "Janet" }, api as never, {
      today: "2026-07-30",
      nextMrnBase: () => secondBases.shift()!,
      nextUuid: sequentialUuid("second"),
    }),
  ]);
  const firstMrn = first.identifier?.find((identifier) => identifier.system === ODOS_MRN_SYSTEM)?.value;
  const secondMrn = second.identifier?.find((identifier) => identifier.system === ODOS_MRN_SYSTEM)?.value;
  assert.equal(isValidOdosMrn(firstMrn ?? ""), true);
  assert.equal(isValidOdosMrn(secondMrn ?? ""), true);
  assert.notEqual(firstMrn, secondMrn);
  assert.equal(api.accounts.size, 2);
});

test("minor registration refuses a missing consent authority before reserving an MRN", async () => {
  const api = new FakeRegistrationApi();
  const guardian = {
    ...emptyRelatedResponsibleParty("guardian", "2026-07-30"),
    firstName: "Pat",
    lastName: "Doe",
    address: "2 Main St",
    city: "Greenville",
    state: "SC",
    postalCode: "29601",
    consentAuthority: false,
  };
  const minorDraft = { ...COMPLETE_DRAFT, birthDate: "2015-01-02" };
  assert.match(
    validatePatientRegistration(minorDraft, {
      today: "2026-07-30",
      responsibleParties: [guardian],
    }).responsibleParties,
    /consent-authority/,
  );
  await assert.rejects(
    createPatient(minorDraft, api as never, {
      today: "2026-07-30",
      responsibleParties: [guardian],
    }),
    /consent-authority/,
  );
  assert.equal(api.sourceTags.length, 0);
});

test("minor registration writes RelatedPerson authority, primary, custody period, notes, and Account guarantor", async () => {
  const api = new FakeRegistrationApi();
  const guardian = {
    ...emptyRelatedResponsibleParty("guardian", "2026-07-01"),
    firstName: "Pat",
    lastName: "Doe",
    address: "2 Main St",
    city: "Greenville",
    state: "SC",
    postalCode: "29601",
    endDate: "2030-01-01",
    courtOrderNotes: "Medical decisions shared under current order.",
  };
  await createPatient({ ...COMPLETE_DRAFT, birthDate: "2015-01-02" }, api as never, {
    today: "2026-07-30",
    responsibleParties: [guardian],
    nextMrnBase: () => 300_001,
    nextUuid: sequentialUuid("minor"),
  });
  const transaction = api.transactions[0];
  const relatedPerson = transaction.entry?.find((entry) => entry.resource?.resourceType === "RelatedPerson")?.resource;
  const account = transaction.entry?.find((entry) => entry.resource?.resourceType === "Account")?.resource as Account;
  assert.equal(relatedPerson?.resourceType, "RelatedPerson");
  if (relatedPerson?.resourceType !== "RelatedPerson") throw new Error("RelatedPerson missing");
  assert.deepEqual(relatedPerson.period, { start: "2026-07-01", end: "2030-01-01" });
  assert.equal(relatedPerson.extension?.find((extension) => extension.url === CONSENT_AUTHORITY_EXTENSION_URL)?.valueBoolean, true);
  assert.equal(relatedPerson.extension?.find((extension) => extension.url === RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL)?.valueBoolean, true);
  assert.equal(relatedPerson.extension?.find((extension) => extension.url === COURT_ORDER_NOTES_EXTENSION_URL)?.valueString, "Medical decisions shared under current order.");
  assert.match(account.guarantor?.[0]?.party.reference ?? "", /^urn:uuid:minor-/);
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

class FakeRegistrationApi {
  readonly accounts = new Map<string, Account>();
  readonly patients = new Map<string, Patient>();
  readonly sourceTags: string[] = [];
  readonly transactions: Bundle[] = [];
  private accountSequence = 0;
  private patientSequence = 0;

  constructor(private readonly duplicateRows: Patient[] = []) {}

  async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    const rows = resourceType === "Patient" ? this.duplicateRows : [];
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })),
    };
  }

  async create<T extends Resource>(
    resource: T,
    sourceTag: string,
    headers: Record<string, string>,
  ): Promise<T> {
    this.sourceTags.push(sourceTag);
    assert.equal(resource.resourceType, "Account");
    assert.match(headers["If-None-Exist"] ?? "", /^identifier=/);
    const account = resource as Account;
    const mrn = account.identifier?.find((identifier) => identifier.system === ODOS_MRN_SYSTEM)?.value;
    assert.ok(mrn);
    const existing = this.accounts.get(mrn);
    if (existing) return structuredClone(existing) as T;
    const created = { ...structuredClone(account), id: `account-${++this.accountSequence}`, meta: { versionId: "1" } };
    this.accounts.set(mrn, created);
    return structuredClone(created) as T;
  }

  async executeTransaction(bundle: Bundle, sourceTag: string): Promise<Bundle> {
    this.sourceTags.push(sourceTag);
    this.transactions.push(structuredClone(bundle));
    const patientEntry = bundle.entry?.find((entry) => entry.resource?.resourceType === "Patient");
    const patientId = `patient-${++this.patientSequence}`;
    const patient = { ...(patientEntry?.resource as Patient), id: patientId, meta: { versionId: "1" } };
    this.patients.set(patientId, patient);
    for (const entry of bundle.entry ?? []) {
      if (entry.resource?.resourceType !== "Account") continue;
      const mrn = entry.resource.identifier?.find((identifier) => identifier.system === ODOS_MRN_SYSTEM)?.value;
      if (mrn) this.accounts.set(mrn, { ...entry.resource, meta: { versionId: "2" } });
    }
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: (bundle.entry ?? []).map((entry) => ({
        response: {
          status: entry.request?.method === "PUT" ? "200 OK" : "201 Created",
          location: entry.resource?.resourceType === "Patient"
            ? `Patient/${patientId}/_history/1`
            : `${entry.resource?.resourceType}/${entry.resource?.id ?? "created"}/_history/1`,
        },
      })),
    };
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    assert.equal(resourceType, "Patient");
    const patient = this.patients.get(id);
    assert.ok(patient);
    return structuredClone(patient) as T;
  }

  async update<T extends Resource>(resource: T): Promise<T> {
    return resource;
  }
}

function sequentialUuid(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}
