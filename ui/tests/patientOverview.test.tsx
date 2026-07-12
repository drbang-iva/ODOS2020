import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import type { ClinicSummary } from "../src/lib/clinic-summary";
import { fetchPatientOverview, type PatientOverviewPayload } from "../src/lib/patient-overview";
import { patientOverviewView, useViewState } from "../src/lib/view-state";
import { ClinicHome } from "../src/scenes/ClinicHome";
import { PatientOverview } from "../src/scenes/PatientOverview";

test("Clinic flow and unsigned-chart clicks both route through PatientOverview", () => {
  useViewState.setState({ view: { kind: "picker" } });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ClinicHome initialSummary={clinicSummary} />);
  });
  const root = renderer.root;

  const flowButton = root.findByProps({ className: "odos-clinic-flow-row" });
  act(() => flowButton.props.onClick());
  assert.deepEqual(useViewState.getState().view, { kind: "overview", patientId: "flow-patient" });

  useViewState.setState({ view: { kind: "picker" } });
  const signatureCard = root.findByProps({ "data-testid": "clinic-signatures-card" });
  const signatureButton = signatureCard.findByType("button");
  act(() => signatureButton.props.onClick());
  assert.deepEqual(useViewState.getState().view, { kind: "overview", patientId: "signature-patient" });
});

test("every remaining patient-opening entry point uses the shared overview transition", () => {
  assert.deepEqual(patientOverviewView("patient-1"), { kind: "overview", patientId: "patient-1" });
  for (const relativePath of [
    "../src/scenes/ClinicHome.tsx",
    "../src/scenes/PatientPicker.tsx",
    "../src/scenes/NewPatient.tsx",
    "../src/components/charting/EncounterHeader.tsx",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /patientOverviewView\(/, `${relativePath} must enter the overview`);
  }
});

test("seeded overview renders real snapshot data, newest-first visits, and linked dx chips", () => {
  const html = renderToStaticMarkup(<PatientOverview patient={patient} initialOverview={fixture()} />);
  assert.match(html, /Howard Enwright/);
  assert.match(html, /Ocular condition/);
  assert.match(html, /One drop nightly/);
  assert.match(html, /Former smoker/);
  assert.ok(html.indexOf("Jun 30") < html.indexOf("Feb 02"));
  assert.match(html, /DX-NEW/);
  assert.match(html, /Start today&#x27;s visit →/);
});

test("zero-data overview renders an honest empty state for every snapshot section", () => {
  const empty = fixture();
  empty.insurance = [];
  empty.stickyNote = undefined;
  empty.snapshot = {
    ocularHistory: [], ocularSurgicalHistory: [], medicalConditions: [], socialHistory: [], ophthalmicMedications: [], systemicMedications: [],
  };
  empty.visits = [];
  const html = renderToStaticMarkup(<PatientOverview patient={patient} initialOverview={empty} />);
  assert.equal((html.match(/None recorded/g) ?? []).length, 6);
  assert.match(html, /No sticky note recorded/);
  assert.match(html, /Insurance not recorded/);
  assert.match(html, /No matching visits recorded/);
});

test("visit and diagnosis filters produce a new server request instead of filtering a prefetched page", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(fixture()), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await fetchPatientOverview("patient-1", { filter: "eye-exams" }, fetchImpl as typeof fetch);
  await fetchPatientOverview("patient-1", {
    filter: "office-visits",
    diagnosisSystem: "https://example.test/diagnosis",
    diagnosisCode: "DX-NEW",
  }, fetchImpl as typeof fetch);
  assert.equal(calls.length, 2);
  assert.match(calls[0] ?? "", /filter=eye-exams/);
  assert.match(calls[1] ?? "", /filter=office-visits/);
  assert.match(calls[1] ?? "", /diagnosisCode=DX-NEW/);
});

const patient: Patient = {
  resourceType: "Patient",
  id: "patient-1",
  name: [{ given: ["Howard"], family: "Enwright" }],
  birthDate: "1950-04-09",
  gender: "male",
  identifier: [{ value: "1176" }],
};

const clinicSummary: ClinicSummary = {
  flow: [{
    appointmentId: "appointment-1",
    patientId: "flow-patient",
    time: "9:00 AM",
    patient: "Flow Patient",
    visitType: "Eye exam",
    state: "waiting",
    stateDetail: "checked in",
    flags: { unsigned: false },
  }],
  signatures: {
    count: 1,
    olderThan24Hours: 0,
    rows: [{
      encounterId: "encounter-1",
      patientId: "signature-patient",
      patient: "Signature Patient",
      visitType: "Office visit",
      checkoutAt: "2026-07-11T14:00:00Z",
      ageMinutes: 30,
      olderThan24Hours: false,
    }],
  },
  erx: { available: false, message: "Not wired" },
  review: { available: false, message: "Not wired" },
};

function fixture(): PatientOverviewPayload {
  return {
    patient,
    insurance: ["Primary plan", "Secondary plan"],
    stickyNote: { id: "sticky-1", text: "Prefers early appointments", editedAt: "2026-03-14T12:00:00Z", editedBy: "Practitioner/one" },
    snapshot: {
      ocularHistory: [{ name: "Ocular condition", laterality: "Both eyes" }],
      ocularSurgicalHistory: [{ name: "Ocular surgery", date: "2020-01-01" }],
      medicalConditions: [{ name: "Medical condition" }],
      socialHistory: ["Former smoker"],
      ophthalmicMedications: [{ name: "Ophthalmic medication", sig: "One drop nightly" }],
      systemicMedications: [{ name: "Systemic medication", sig: "Daily" }],
    },
    visits: [
      {
        encounterId: "newer",
        date: "2026-06-30T12:00:00Z",
        provider: "Dr. Clinician",
        facility: "Practice location",
        visitType: "Eye exam",
        status: "Final",
        diagnoses: [{ conditionId: "dx-new", encounterId: "newer", name: "Newer diagnosis", code: "DX-NEW" }],
      },
      {
        encounterId: "older",
        date: "2026-02-02T12:00:00Z",
        visitType: "Office visit",
        status: "Preliminary",
        diagnoses: [],
      },
    ],
    diagnosisChoices: [{ name: "Newer diagnosis", system: "https://example.test/diagnosis", code: "DX-NEW" }],
  };
}
