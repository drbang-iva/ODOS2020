import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import { ClinicOfficeShell, searchClinicPatients, useOfficeInbox, type OfficeInboxApi } from "../src/components/OfficeChannel";
import type { ClinicSummary } from "../src/lib/clinic-summary";
import type { OfficeMessage } from "../src/lib/office-channel";
import { ClinicHome } from "../src/scenes/ClinicHome";
import { DESK_CARDS, DeskHome } from "../src/scenes/DeskHome";
import { PatientOverview } from "../src/scenes/PatientOverview";

test("Office pill badge and ambient panel reflect the real unacknowledged count", async () => {
  let emptyRenderer!: ReactTestRenderer;
  await act(async () => { emptyRenderer = create(<ClinicOfficeShell location="Clinic home" initialMessages={[]}><ClinicHome initialSummary={summary()} /></ClinicOfficeShell>); });
  assert.equal(emptyRenderer.root.findAllByProps({ className: "odos-office-badge" }).length, 0);
  emptyRenderer.unmount();

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ClinicOfficeShell location="Clinic home" initialMessages={[message(), message({ id: "seen", acknowledgement: acknowledgement })]}><ClinicHome initialSummary={summary()} /></ClinicOfficeShell>);
  });
  assert.equal(renderer.root.findByProps({ className: "odos-office-badge" }).children.join(""), "1");
  await act(async () => renderer.root.findByProps({ className: "odos-pill odos-office-pill" }).props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Office messages" }).length, 1);
  assert.match(renderer.toJSON() ? JSON.stringify(renderer.toJSON()) : "", /Insurance question/);
});

test("Clinic Sections drawer routes every shipped item and gates Settings to practice admins", () => {
  const clinician = renderToStaticMarkup(<ClinicOfficeShell location="Clinic home" roles={["clinician"]} initialMessages={[]} initialSummary={summary()}><ClinicHome /></ClinicOfficeShell>);
  const admin = renderToStaticMarkup(<ClinicOfficeShell location="Clinic home" roles={["clinician", "practice-admin"]} initialMessages={[]} initialSummary={summary()}><ClinicHome /></ClinicOfficeShell>);
  for (const href of ["/clinic/patients", "/patient/new", "/schedule/day", "/dispensary/lab-orders", "/settings/chart-fields-sections", "/settings/suggested-diagnoses", "/audit/log"]) {
    assert.match(clinician, new RegExp(`href="${href.replaceAll("/", "\\/")}"`));
  }
  assert.doesNotMatch(clinician, /href="\/settings"/);
  assert.match(admin, /href="\/settings"/);
  assert.match(clinician, /Results review[\s\S]*review queue not wired/);
  assert.match(clinician, /E-Rx queue[\s\S]*not wired/);
  assert.match(clinician, /Orders worklist[\s\S]*>2<\/i>/);
});

test("Clinic patient search uses existing FHIR name, DOB, identifier, and id searches", async () => {
  const calls: Record<string, string>[] = [];
  const patient = { resourceType: "Patient", id: "chart-42", name: [{ given: ["Maya"], family: "Alvarez" }] } satisfies Patient;
  const api = {
    search: async (_resourceType: "Patient", params: Record<string, string>) => {
      calls.push(params);
      return { resourceType: "Bundle" as const, type: "searchset" as const, entry: [{ resource: patient }] };
    },
  };
  const nameResults = await searchClinicPatients("chart-42", api as never);
  assert.equal(nameResults.length, 1);
  assert.deepEqual(calls, [
    { name: "chart-42", _count: "8" },
    { identifier: "chart-42", _count: "8" },
    { _id: "chart-42", _count: "8" },
  ]);
  calls.length = 0;
  await searchClinicPatients("07/13/1980", api as never);
  assert.deepEqual(calls, [{ birthdate: "1980-07-13", _count: "8" }]);
});

test("urgent queue persists across Clinic views, dismisses globally, and reveals the next urgent", async () => {
  const first = message({ id: "urgent-1", tier: "urgent", text: "Checkout question" });
  const second = message({ id: "urgent-2", tier: "urgent", text: "Lab is holding" });
  const acknowledge = async (id: string) => ({ ...(id === first.id ? first : second), acknowledgement });
  const api = { list: async () => [first, second], acknowledge };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ClinicOfficeShell location="Clinic home" initialMessages={[first, second]} officeApi={api}><ClinicHome initialSummary={summary()} /></ClinicOfficeShell>);
  });
  assert.match(JSON.stringify(renderer.toJSON()), /Checkout question/);
  assert.match(JSON.stringify(renderer.toJSON()), /1 of 2/);

  await act(async () => renderer.root.findByProps({ role: "status" }).findByType("button").props.onClick());
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Checkout question/);
  assert.match(JSON.stringify(renderer.toJSON()), /Lab is holding/);
  assert.equal(renderer.root.findByProps({ className: "odos-office-badge" }).children.join(""), "1");

  await act(async () => renderer.update(
    <ClinicOfficeShell location="Patient overview" initialMessages={[first, second]} officeApi={api}>
      <PatientOverview patient={patient} initialOverview={overviewFixture()} />
    </ClinicOfficeShell>,
  ));
  assert.match(JSON.stringify(renderer.toJSON()), /Lab is holding/);

  const css = readFileSync(new URL("../src/styles/desk-home.css", import.meta.url), "utf8");
  const nudgeRule = css.match(/\.odos-office-nudge \{[^}]+\}/)?.[0] ?? "";
  assert.match(nudgeRule, /position: relative/);
  assert.doesNotMatch(nudgeRule, /position: fixed|backdrop|inset: 0/);
});

test("patient pin appears on the matching flow row and chart header, is ackable, and remains as quiet seen state", async () => {
  const pinned = message({ tier: "patient-pinned", patient: { reference: "Patient/patient-1", id: "patient-1", display: "Maya Alvarez" } });
  const seenPinned = { ...pinned, acknowledgement };
  let homeRenderer!: ReactTestRenderer;
  await act(async () => { homeRenderer = create(<ClinicOfficeShell location="Clinic home" initialMessages={[pinned]}><ClinicHome initialSummary={summary()} /></ClinicOfficeShell>); });
  const flowRows = homeRenderer.root.findAllByProps({ className: "odos-clinic-flow-row" });
  const mayaRow = flowRows.find((row) => row.findByProps({ className: "odos-clinic-who" }).children.join("").includes("Maya Alvarez"));
  const otherRow = flowRows.find((row) => row.findByProps({ className: "odos-clinic-who" }).children.join("").includes("Other Patient"));
  assert.equal(mayaRow?.findAllByProps({ className: "odos-office-pin-context is-compact" }).length, 1);
  assert.equal(otherRow?.findAllByType("details").length, 0);

  let overviewRenderer!: ReactTestRenderer;
  await act(async () => { overviewRenderer = create(<ClinicOfficeShell location="Patient overview" initialMessages={[pinned]}><PatientOverview patient={patient} initialOverview={overviewFixture()} /></ClinicOfficeShell>); });
  assert.equal(overviewRenderer.root.findAllByProps({ "aria-label": "Pinned Office note from Hannah Desk" }).length, 1);
  await act(async () => { overviewRenderer.update(<ClinicOfficeShell location="Patient overview" initialMessages={[pinned]}><PatientOverview patient={{ ...patient, id: "patient-2" }} initialOverview={overviewFixture()} /></ClinicOfficeShell>); });
  assert.equal(overviewRenderer.root.findAllByType("details").length, 0);
  await act(async () => { overviewRenderer.update(<ClinicOfficeShell key="seen" location="Patient overview" initialMessages={[seenPinned]}><PatientOverview patient={patient} initialOverview={overviewFixture()} /></ClinicOfficeShell>); });
  assert.equal(overviewRenderer.root.findAllByProps({ className: "odos-office-pin-context is-seen" }).length, 1);
  assert.equal(overviewRenderer.root.findByProps({ className: "odos-office-pin-context is-seen" }).findByType("summary").children.join(""), "📌 ✓");

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ClinicOfficeShell location="Patient overview" initialMessages={[pinned]} officeApi={{ list: async () => [pinned], acknowledge: async () => seenPinned }}><PatientOverview patient={patient} initialOverview={overviewFixture()} /></ClinicOfficeShell>);
  });
  await act(async () => renderer.root.findByProps({ className: "odos-office-pin-context" }).findByType("button").props.onClick());
  assert.equal(renderer.root.findByProps({ className: "odos-office-pin-context is-seen" }).findByType("summary").children.join(""), "📌 ✓");
});

test("Desk Office surface is a real DESK_CARDS card with three tiers and seen identity", () => {
  assert.equal(DESK_CARDS.some((card) => card.id === "office"), true);
  const seen = message({ acknowledgement });
  const html = renderToStaticMarkup(<DeskHome initialOfficeMessages={[seen]} />);
  assert.match(html, /Office <i>· closed loop/);
  assert.match(html, /Office message tier/);
  assert.match(html, />Note<\/button>/);
  assert.match(html, />Urgent<\/button>/);
  assert.match(html, /📌 Patient/);
  assert.match(html, /Seen ✓ by Dr\. Eric Bang/);
  assert.doesNotMatch(html, /Front Line[\s\S]*Seen ✓ by Dr\. Eric Bang[\s\S]*Open desk inbox/);
});

test("Clinic poll ignores an older response after a newer refresh completes", async () => {
  const pending: Array<(value: OfficeMessage[]) => void> = [];
  const api = { list: async () => new Promise<OfficeMessage[]>((resolve) => pending.push(resolve)), acknowledge: async () => message() };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<OfficeProbe api={api} />); });
  assert.equal(pending.length, 0);
  await act(async () => { void renderer.root.findByProps({ id: "refresh" }).props.onClick(); });
  await act(async () => { void renderer.root.findByProps({ id: "refresh" }).props.onClick(); });
  assert.equal(pending.length, 2);
  await act(async () => { pending[1]([message({ id: "latest" })]); });
  await act(async () => { pending[0]([message({ id: "stale" })]); });
  assert.equal(renderer.root.findByProps({ id: "ids" }).children.join(""), "latest");
});

function OfficeProbe({ api }: { api: OfficeInboxApi }) {
  const office = useOfficeInbox({ api, pollMs: 60_000 });
  return <div><button id="refresh" onClick={() => office.refresh()}>Refresh</button><span id="ids">{office.messages.map((item) => item.id).join(",")}</span></div>;
}

const acknowledgement = { by: "Practitioner/doctor-1", display: "Dr. Eric Bang", at: "2026-07-11T15:01:00Z" };
const patient = { resourceType: "Patient", id: "patient-1", name: [{ given: ["Maya"], family: "Alvarez" }], birthDate: "1960-01-01", gender: "female" } satisfies Patient;

function message(overrides: Partial<OfficeMessage> = {}): OfficeMessage {
  return {
    id: "message-1",
    text: "Insurance question",
    sentAt: "2026-07-11T15:00:00Z",
    sender: { reference: "Practitioner/desk-1", display: "Hannah Desk" },
    tier: "ambient",
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
    orders: { count: 2, agingCount: 0, agingThresholdDays: 5, rows: [] },
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
