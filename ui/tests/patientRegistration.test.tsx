import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PatientDemographicsEditor } from "../src/components/patient/PatientDemographicsEditor";
import { resolveSmsNumber } from "../../mcp/src/comms/suppression-gate";
import {
  createPatientDemographicsActions,
  emptyPatientDemographics,
  localCalendarDate,
  patientDemographicsFromPatient,
  patientTelecomSnapshot,
  type PatientDraftPhone,
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
  phones: [{ value: "864-555-0100", use: "home", sourceIndex: 0 }, { value: "", use: "mobile", sourceIndex: null }],
  textable: "",
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
  assert.deepEqual(Object.keys(blankErrors).sort(), ["birthDate", "firstName", "gender", "lastName"]);
  const optionalAbsent = validatePatientDemographics({ ...COMPLETE_DRAFT, address: "", city: "", state: "", postalCode: "", email: "" });
  assert.deepEqual(optionalAbsent, {});
  assert.match(validatePatientDemographics({ ...COMPLETE_DRAFT, birthDate: "2026-02-30" }).birthDate, /valid YYYY-MM-DD/);
  assert.match(validatePatientDemographics({ ...COMPLETE_DRAFT, phones: [{ ...COMPLETE_DRAFT.phones[0], value: "123" }, COMPLETE_DRAFT.phones[1]] })["phones.0.value"], /valid phone/);
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
  const saved = await actions.save(changed, patientTelecomSnapshot(EXISTING, SMS_NOW.toISOString()));
  assert.equal(saved.name?.find((name) => name.use === "official")?.given?.[0], "Janet");
  assert.equal(sourceTag, "patient-demographics-update");
  assert.equal(updates, 1);
  assert.deepEqual(actions.discard(), COMPLETE_DRAFT);
  assert.equal(updates, 1);
});

const MOBILE = "+12025550101";
const WORK = "+12025550102";
const CHANGED = "+12025550103";
const SMS_NOW = new Date("2026-08-02T15:00:00.000Z");

function mobileWorkTelecom(): NonNullable<Patient["telecom"]> {
  return [
    { system: "phone", use: "mobile", value: MOBILE, rank: 2, period: { start: "2026-01-01", end: "2027-01-01" } },
    { system: "phone", use: "work", value: WORK, rank: 1 },
  ];
}

async function saveTelecom(telecom: Patient["telecom"], changes: Partial<Omit<PatientDemographicsDraft, "phones">> & { phones?: Record<number, Partial<PatientDraftPhone>> } = {}) {
  const subject = { ...EXISTING, telecom };
  const loaded = patientDemographicsFromPatient(subject, SMS_NOW.toISOString());
  const actions = createPatientDemographicsActions(subject, {
    update: async (patient: Patient) => patient,
  } as never);
  const draft = { ...loaded, ...changes, phones: loaded.phones.map((phone, index) => ({ ...phone, ...changes.phones?.[index] })) as PatientDemographicsDraft["phones"] };
  return { loaded, saved: await actions.save(draft, patientTelecomSnapshot(subject, SMS_NOW.toISOString())) };
}

test("G1: an unchanged demographics save keeps the mobile recipient and byte-identical telecom", async () => {
  const telecom = mobileWorkTelecom();
  const before = JSON.stringify(telecom);
  const html = renderToStaticMarkup(<PatientDemographicsEditor patient={{ ...EXISTING, telecom }} onSaved={() => undefined} onDiscard={() => undefined} />);
  assert.ok(html.includes(`value="${MOBILE}"`));
  const { loaded, saved } = await saveTelecom(telecom);
  assert.equal(loaded.phones[0].value, MOBILE);
  assert.equal(resolveSmsNumber(saved, SMS_NOW), MOBILE);
  assert.equal(JSON.stringify(saved.telecom), before);
  assert.equal(JSON.stringify(telecom), before);
});

test("G2: a changed mobile value stays at its original position with metadata intact", async () => {
  const telecom = mobileWorkTelecom();
  const { saved } = await saveTelecom(telecom, { phones: { 0: { value: CHANGED } } });
  assert.deepEqual(saved.telecom, [{ ...telecom[0], value: CHANGED }, telecom[1]]);
  assert.equal(resolveSmsNumber(saved, SMS_NOW), CHANGED);
  assert.equal(telecom[0].value, MOBILE);
});

test("G3: the displayed home slot is updated in place even when it is not the first phone", async () => {
  const home = { system: "phone", use: "home", value: WORK, rank: 2 } as const;
  const mobile = { system: "phone", use: "mobile", value: MOBILE, rank: 1 } as const;
  for (const telecom of [[home, mobile], [mobile, home]]) {
    const { loaded, saved } = await saveTelecom(telecom, { phones: { 1: { value: CHANGED } } });
    assert.equal(loaded.phones[1].value, WORK);
    assert.deepEqual(saved.telecom, telecom[0] === home
      ? [{ ...home, value: CHANGED }, mobile]
      : [mobile, { ...home, value: CHANGED }]);
    assert.equal(resolveSmsNumber(saved, SMS_NOW), MOBILE);
  }
});

test("G4: a missing phone appends exactly one entry with the chosen home use", async () => {
  const email = { system: "email", use: "work", value: "work@example.test" } as const;
  const { saved } = await saveTelecom([email], { phones: { 0: { value: "5550100", use: "home" } } });
  assert.deepEqual(saved.telecom, [email, { system: "phone", use: "home", value: "5550100" }]);
});

test("G5: the displayed home email changes in place or is removed when cleared without moving other entries", async () => {
  const work = { system: "email", use: "work", value: "work@example.test" } as const;
  const home = { system: "email", use: "home", value: "home@example.test", rank: 2, period: { start: "2026-01-01" } } as const;
  const phone = { system: "phone", use: "mobile", value: MOBILE } as const;
  for (const value of ["changed@example.test", "", "   "]) {
    const { loaded, saved } = await saveTelecom([work, home, phone], { email: value });
    assert.equal(loaded.email, "home@example.test");
    assert.deepEqual(saved.telecom, value.trim() ? [work, { ...home, value }, phone] : [work, phone]);
  }
});

test("G13: clearing the email box removes only the displayed entry from the real serialized PUT", async () => {
  const work = { system: "email", use: "work", value: "work@example.test", rank: 1 } as const;
  const home = { system: "email", use: "home", value: "home@example.test", rank: 2, period: { start: "2026-01-01" } } as const;
  const mobile = { system: "phone", use: "mobile", value: MOBILE, rank: 3 } as const;
  const patient: Patient = { ...EXISTING, telecom: [work, home, mobile] };
  const before = JSON.stringify(patient);
  const originalFetch = globalThis.fetch;
  try {
    for (const blank of ["", "   "]) {
      const requests: Array<{ url: string; body: string; ifMatch: string | null }> = [];
      let saved = false;
      let renderer!: ReactTestRenderer;
      globalThis.fetch = async (input, init) => {
        if (init?.method !== "PUT") return Response.json({ error: "Unavailable in this synthetic test" }, { status: 403 });
        const body = String(init.body);
        requests.push({ url: String(input), body, ifMatch: new Headers(init.headers).get("If-Match") });
        return Response.json({ ...JSON.parse(body), meta: { versionId: "4" } });
      };
      try {
        await act(async () => {
          renderer = create(<PatientDemographicsEditor patient={patient} onSaved={() => { saved = true; }} onDiscard={() => undefined} />);
        });
        const emailInput = () => renderer.root.findAllByType("input").find((input) => input.props.type === "email")!;
        assert.equal(emailInput().props.value, home.value);
        await act(async () => {
          emailInput().props.onChange({ target: { value: blank } });
        });
        await act(async () => {
          renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save demographics")!.props.onClick();
        });
        assert.equal(saved, true);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, `/fhir/R4/Patient/${patient.id}`);
        assert.equal(requests[0].ifMatch, 'W/"3"');
        assert.doesNotMatch(requests[0].body, /"value"\s*:\s*""/);
        assert.deepEqual(JSON.parse(requests[0].body).telecom, [work, mobile]);
        assert.equal(JSON.stringify(patient), before);
      } finally {
        act(() => renderer?.unmount());
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("G12: duplicate home entries keep the first displayed entry in place on unchanged and changed saves", async () => {
  const telecom: NonNullable<Patient["telecom"]> = [
    { system: "phone", use: "home", value: MOBILE, rank: 2, period: { start: "2026-01-01" } },
    { system: "phone", use: "home", value: WORK, rank: 1 },
  ];
  const before = JSON.stringify(telecom);
  const unchanged = await saveTelecom(telecom);
  assert.equal(unchanged.loaded.phones[0].value, MOBILE);
  assert.equal(patientDemographicsFromPatient(unchanged.saved).phones[0].value, MOBILE);
  assert.equal(JSON.stringify(unchanged.saved.telecom), before);
  const changed = await saveTelecom(telecom, { phones: { 0: { value: CHANGED } } });
  assert.deepEqual(changed.saved.telecom, [{ ...telecom[0], value: CHANGED }, telecom[1]]);
  assert.equal(patientDemographicsFromPatient(changed.saved).phones[0].value, CHANGED);
  assert.equal(JSON.stringify(telecom), before);
});

test("H1: obsolete-only contact displays blank and appends a new home without editing history", async () => {
  for (const system of ["phone", "email"] as const) {
    const old = { system, use: "old", value: system === "phone" ? MOBILE : "old@example.test", rank: 2 } as const;
    const value = system === "phone" ? CHANGED : "new@example.test";
    const companion = system === "email" ? [{ system: "phone" as const, use: "mobile" as const, value: MOBILE }] : [];
    const contacts = [...companion, old];
    const html = renderToStaticMarkup(<PatientDemographicsEditor patient={{ ...EXISTING, telecom: contacts }} onSaved={() => undefined} onDiscard={() => undefined} />);
    assert.ok(!html.includes(`value="${old.value}"`));
    const { loaded, saved } = await saveTelecom(contacts, system === "phone" ? { phones: { 0: { value, ...(system === "phone" && contacts.every(p => p.system !== "phone" || p.use === "old") ? { use: "home" as const } : {}) } } } : { email: value });
    assert.equal((system === "phone" ? loaded.phones[0].value : loaded.email), "");
    assert.deepEqual(saved.telecom, [...contacts, { system, use: "home", value }]);
    for (const blank of system === "email" ? ["", "   "] : []) {
      assert.deepEqual((await saveTelecom(contacts, { [system]: blank })).saved.telecom, contacts);
    }
  }
});

test("H2: obsolete then work displays and edits the same work contact in place", async () => {
  for (const system of ["phone", "email"] as const) {
    const old = { system, use: "old", value: system === "phone" ? MOBILE : "old@example.test" } as const;
    const work = { system, use: "work", value: system === "phone" ? WORK : "work@example.test", rank: 2, period: { start: "2026-01-01" } } as const;
    const value = system === "phone" ? CHANGED : "new@example.test";
    const companion = system === "email" ? [{ system: "phone" as const, use: "mobile" as const, value: MOBILE }] : [];
    const contacts = [...companion, old, work];
    const html = renderToStaticMarkup(<PatientDemographicsEditor patient={{ ...EXISTING, telecom: contacts }} onSaved={() => undefined} onDiscard={() => undefined} />);
    assert.ok(html.includes(`value="${work.value}"`));
    assert.ok(!html.includes(`value="${old.value}"`));
    const { loaded, saved } = await saveTelecom(contacts, system === "phone" ? { phones: { 0: { value, ...(system === "phone" && contacts.every(p => p.system !== "phone" || p.use === "old") ? { use: "home" as const } : {}) } } } : { email: value });
    assert.equal((system === "phone" ? loaded.phones[0].value : loaded.email), work.value);
    assert.deepEqual(saved.telecom, [...companion, old, { ...work, value }]);
    if (system === "email") assert.deepEqual((await saveTelecom(contacts, { [system]: "" })).saved.telecom, [...companion, old]);
  }
});

test("H3: a current home contact retains its value and metadata on unchanged save", async () => {
  const home = { system: "phone", use: "home", value: MOBILE, rank: 3, period: { start: "2026-01-01" } } as const;
  const { loaded, saved } = await saveTelecom([home]);
  assert.equal(loaded.phones[0].value, MOBILE);
  assert.deepEqual(saved.telecom, [home]);
});

test("H14: blank phone saves remove the entry while email still exercises contact removal", async () => {
  for (const phone of ["", "   "]) {
    const subject: Patient = { ...EXISTING, telecom: [{ system: "phone", use: "home", value: MOBILE }] };
    const draft = patientDemographicsFromPatient(subject, SMS_NOW.toISOString());
    draft.phones[0].value = phone;
    let writes = 0;
    let persisted: Patient | undefined;
    const actions = createPatientDemographicsActions(subject, {
      update: async (resource: Patient) => { writes++; persisted = resource; return resource; },
    } as never);
    let failure: unknown;
    try { await actions.save(draft, patientTelecomSnapshot(subject, SMS_NOW.toISOString())); } catch (error) { failure = error; }
    assert.equal(writes, 1);
    assert.equal(validatePatientDemographics(draft)["phones.0.value"], undefined);
    assert.equal(failure, undefined);
    assert.deepEqual(persisted?.telecom, []);
    assert.doesNotMatch(JSON.stringify(persisted), /"value"\s*:\s*""/);
  }
  const phone = { system: "phone", use: "home", value: MOBILE } as const;
  const email = { system: "email", use: "home", value: "synthetic@example.test" } as const;
  for (const blank of ["", "   "]) {
    assert.deepEqual((await saveTelecom([phone, email], { email: blank })).saved.telecom, [phone]);
  }
});
