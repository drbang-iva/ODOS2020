import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import type { ClinicSummary } from "../src/lib/clinic-summary";
import type { OfficeMessage } from "../src/lib/office-channel";
import { ClinicHome } from "../src/scenes/ClinicHome";
import { DeskHome } from "../src/scenes/DeskHome";
import { PatientOverview } from "../src/scenes/PatientOverview";

test("Office badge is absent at zero and real when unread messages exist", () => {
  const empty = renderToStaticMarkup(<ClinicHome initialSummary={summary()} initialOfficeMessages={[]} />);
  assert.match(empty, />Office <\/button>/);
  assert.doesNotMatch(empty, /odos-office-badge/);
  const unread = renderToStaticMarkup(<ClinicHome initialSummary={summary()} initialOfficeMessages={[message()]} />);
  assert.match(unread, /odos-office-badge[^>]*>1</);
});

test("urgent Office message renders in-flow and acknowledgement dismisses it", async () => {
  const original = message({ urgent: true });
  const acknowledged = { ...original, acknowledgements: [{ by: "Practitioner/doctor-1", display: "Dr. Eric Bang", at: "2026-07-11T15:01:00Z" }] };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ClinicHome initialSummary={summary()} initialOfficeMessages={[original]} officeApi={{ list: async () => [acknowledged], acknowledge: async () => acknowledged }} />);
  });
  assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 1);
  await act(async () => { await renderer.root.findByProps({ role: "status" }).findByType("button").props.onClick(); });
  assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 0);

  const css = readFileSync(new URL("../src/styles/desk-home.css", import.meta.url), "utf8");
  const nudgeRule = css.match(/\.odos-office-nudge \{[^}]+\}/)?.[0] ?? "";
  assert.match(nudgeRule, /position: relative/);
  assert.doesNotMatch(nudgeRule, /position: fixed|backdrop|inset: 0/);
});

test("patient pin appears only on the matching Clinic row and matching overview header", () => {
  const pinned = message({ patient: { reference: "Patient/patient-1", id: "patient-1", display: "Maya Alvarez" } });
  const home = renderToStaticMarkup(<ClinicHome initialSummary={summary()} initialOfficeMessages={[pinned]} />);
  const flowRows = [...home.matchAll(/<button type="button" class="odos-clinic-flow-row"[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
  const mayaRow = flowRows.find((row) => row.includes("Maya Alvarez")) ?? "";
  const otherRow = flowRows.find((row) => row.includes("Other Patient")) ?? "";
  assert.match(mayaRow, /📌/);
  assert.doesNotMatch(otherRow, /📌/);

  const overview = renderToStaticMarkup(<PatientOverview patient={patient} initialOverview={overviewFixture()} initialOfficeMessages={[pinned]} />);
  assert.match(overview, /odos-overview-head[^]*?📌 Hannah Desk: Insurance question/);
  const otherOverview = renderToStaticMarkup(<PatientOverview patient={{ ...patient, id: "patient-2" }} initialOverview={overviewFixture()} initialOfficeMessages={[pinned]} />);
  assert.doesNotMatch(otherOverview, /📌 Hannah Desk: Insurance question/);
});

test("Desk sent list exposes the real acknowledgement identity and time", () => {
  const seen = message({ acknowledgements: [{ by: "Practitioner/doctor-1", display: "Dr. Eric Bang", at: "2026-07-11T15:01:00Z" }] });
  const html = renderToStaticMarkup(<DeskHome initialOfficeMessages={[seen]} initialOfficeOpen />);
  assert.match(html, /Seen ✓ by Dr\. Eric Bang/);
  assert.doesNotMatch(html, /Front Line[^]*Seen ✓ by Dr\. Eric Bang/);
});

const patient = { resourceType: "Patient", id: "patient-1", name: [{ given: ["Maya"], family: "Alvarez" }], birthDate: "1960-01-01", gender: "female" } satisfies Patient;

function message(overrides: Partial<OfficeMessage> = {}): OfficeMessage {
  return {
    id: "message-1",
    text: "Insurance question",
    sentAt: "2026-07-11T15:00:00Z",
    sender: { reference: "Practitioner/desk-1", display: "Hannah Desk" },
    recipient: { role: "clinician", display: "Clinician role" },
    urgent: false,
    acknowledgements: [],
    ...overrides,
  };
}

function summary(): ClinicSummary {
  return {
    flow: [
      { appointmentId: "a1", patientId: "patient-1", time: "9:00 AM", patient: "Maya Alvarez", visitType: "Comprehensive", state: "checked-out", stateDetail: "checked out", flags: { unsigned: true } },
      { appointmentId: "a2", patientId: "patient-2", time: "9:30 AM", patient: "Other Patient", visitType: "Medical", state: "roomed", stateDetail: "roomed", flags: { unsigned: false } },
    ],
    signatures: { count: 0, olderThan24Hours: 0, rows: [] },
    erx: { available: false, message: "not wired yet" },
    review: { available: false, message: "not wired yet" },
  };
}

function overviewFixture() {
  return {
    patient,
    insurance: [],
    snapshot: { ocularHistory: [], ocularSurgicalHistory: [], medicalConditions: [], socialHistory: [], ophthalmicMedications: [], systemicMedications: [] },
    visits: [],
    diagnosisChoices: [],
  };
}
