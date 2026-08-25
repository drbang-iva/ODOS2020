import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import {
  createPatientDemographicsActions,
  emptyPatientDemographics,
  localCalendarDate,
  patientDemographicsFromPatient,
  validatePatientDemographics,
  validatePatientRegistration,
  type PatientDemographicsDraft,
} from "../src/lib/patient-registration";
import {
  emptyRelatedResponsibleParty,
  emptySelfResponsibleParty,
  formatOdosMrn,
  isValidOdosMrn,
  luhnCheckDigit,
} from "../src/lib/patient-identity";
import {
  DuplicatePatientWarning,
  RegistrationRepairNotice,
  withoutResponsiblePartyErrors,
} from "../src/scenes/NewPatient";

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

test("registration uses the local calendar date and clears stale responsible-party errors", () => {
  assert.equal(localCalendarDate(new Date(2026, 6, 5, 23, 30)), "2026-07-05");
  assert.deepEqual(withoutResponsiblePartyErrors({
    firstName: "Legal first name is required.",
    responsibleParties: "A responsible party is required.",
    "responsibleParties.1.address": "Mailing address is required.",
  }), {
    firstName: "Legal first name is required.",
  });
});

test("exact duplicate warning presents both safe choices", () => {
  const html = renderToStaticMarkup(<DuplicatePatientWarning patients={[EXISTING]} saving={false} onUseExisting={() => undefined} onBack={() => undefined} onCreateAnyway={() => undefined} />);
  assert.match(html, /Possible duplicate patient/);
  assert.match(html, /Jane Q Doe/);
  assert.match(html, /DOB 1980-01-02 · ID patient-1/);
  assert.match(html, /Use existing patient/);
  assert.match(html, /Create anyway/);
});

test("a completed registration warning renders a terminal repair state without another create action", () => {
  const html = renderToStaticMarkup(<RegistrationRepairNotice
    warning={{
      message: "Ask a practice administrator to repair your patient access.",
    }}
    onBack={() => undefined}
  />);
  assert.match(html, /Patient registered/);
  assert.match(html, /Back to patient search/);
  assert.doesNotMatch(html, /Create patient|Create anyway/);
  assert.doesNotMatch(html, /Patient\/patient-1/);
});

test("ODOS MRNs use a six-digit base plus a valid appended Luhn check digit", () => {
  const mrn = formatOdosMrn(100_001);
  assert.match(mrn, /^\d{7}$/);
  assert.equal(mrn.slice(6), luhnCheckDigit(mrn.slice(0, 6)));
  assert.equal(isValidOdosMrn(mrn), true);
  assert.equal(isValidOdosMrn(`${mrn.slice(0, 6)}${(Number(mrn[6]) + 1) % 10}`), false);
});

test("minor registration validation refuses a missing consent authority", () => {
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
});

test("registration validation refuses missing and invalid birth dates", () => {
  for (const birthDate of ["", "2026-02-30"]) {
    assert.match(validatePatientRegistration({ ...COMPLETE_DRAFT, birthDate }).birthDate, /Date of birth/);
  }
});

test("responsible-party collection errors accumulate without hiding minor consent requirements", () => {
  const self = emptySelfResponsibleParty("self");
  const errors = validatePatientRegistration(
    { ...COMPLETE_DRAFT, birthDate: "2015-01-02" },
    {
      today: "2026-07-30",
      responsibleParties: [self, { ...self, localId: "duplicate-self" }],
    },
  );
  assert.match(errors.responsibleParties, /appear as self only once/);
  assert.match(errors.responsibleParties, /minor cannot be registered as their own responsible party/);
  assert.match(errors.responsibleParties, /minor must have at least one current consent-authority party/);
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
