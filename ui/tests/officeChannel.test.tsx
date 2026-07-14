import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import { ClinicOfficeShell, OfficeChannelShell, searchClinicPatients, useOfficeInbox, type OfficeInboxApi } from "../src/components/OfficeChannel";
import { AppShell } from "../src/components/AppShell";
import type { ClinicSummary } from "../src/lib/clinic-summary";
import type { OfficeMessage } from "../src/lib/office-channel";
import { ClinicHome } from "../src/scenes/ClinicHome";
import { DESK_CARDS, DeskHome } from "../src/scenes/DeskHome";
import { PatientOverview } from "../src/scenes/PatientOverview";

test("Office pill badge and ambient panel reflect the real unacknowledged count", async () => {
  let emptyRenderer!: ReactTestRenderer;
  await act(async () => { emptyRenderer = create(<ClinicOfficeShell initialMessages={[]} initialSummary={summary()}><ClinicShell><ClinicHome /></ClinicShell></ClinicOfficeShell>); });
  assert.equal(emptyRenderer.root.findAllByProps({ className: "odos-office-badge" }).length, 0);
  emptyRenderer.unmount();

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ClinicOfficeShell initialMessages={[message(), message({ id: "seen", acknowledgement: acknowledgement })]} initialSummary={summary()}><ClinicShell><ClinicHome /></ClinicShell></ClinicOfficeShell>);
  });
  assert.equal(renderer.root.findByProps({ className: "odos-office-badge" }).children.join(""), "1");
  await act(async () => renderer.root.findByProps({ "aria-label": "Office" }).props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Office messages" }).length, 1);
  assert.match(renderer.toJSON() ? JSON.stringify(renderer.toJSON()) : "", /Insurance question/);
});

test("Office bell opens the shared inbox and renders its unread badge on Desk and Clinic sides", async () => {
  for (const side of ["desk", "clinic"] as const) {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <OfficeChannelShell side={side} initialMessages={[message()]} initialSummary={summary()}>
          <AppShell path={`/${side}`} roles={side === "desk" ? ["front-desk"] : ["clinician"]} homePath={`/${side}`} side={side} email={`${side}@example.test`}><main /></AppShell>
        </OfficeChannelShell>,
      );
    });
    assert.equal(renderer.root.findByProps({ className: "odos-office-badge" }).children.join(""), "1", side);
    await act(async () => renderer.root.findByProps({ "aria-label": "Office" }).props.onClick());
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Office messages" }).length, 1, side);
    renderer.unmount();
  }
});

test("Desk home consumes the shell Office source without starting a second poll", async () => {
  const originalWindow = globalThis.window;
  let listCalls = 0;
  let intervals = 0;
  const storage = memoryStorage();
  const windowStub = {
    localStorage: storage,
    setInterval: () => { intervals += 1; return intervals; },
    clearInterval: () => undefined,
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  const api: OfficeInboxApi = {
    list: async () => { listCalls += 1; return []; },
    acknowledge: async () => message({ acknowledgement }),
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <OfficeChannelShell side="desk" officeApi={api} initialSummary={summary()} pollMs={60_000}>
          <DeskHome initialSummary={emptyDeskSummary()} officeApi={{ list: api.list, send: async () => message() }} />
        </OfficeChannelShell>,
      );
      await Promise.resolve();
    });
    assert.equal(listCalls, 1);
    assert.equal(intervals, 1);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("unified Sections routes every named surface and gates Settings to practice admins", () => {
  const clinician = renderToStaticMarkup(<ClinicOfficeShell initialMessages={[]} initialSummary={summary()}><ClinicShell><ClinicHome /></ClinicShell></ClinicOfficeShell>);
  const admin = renderToStaticMarkup(<ClinicOfficeShell initialMessages={[]} initialSummary={summary()}><ClinicShell roles={["clinician", "practice-admin"]}><ClinicHome /></ClinicShell></ClinicOfficeShell>);
  for (const href of ["/schedule/day", "/frontdesk", "/billing/claims/worklist", "/billing/claims/reports/accounts-receivable", "/billing/statements", "/dispensary/lab-orders", "/admin/optical/catalog/frames", "/admin/optical/inventory/frames", "/admin/practice/settings/frames-data", "/audit/log", "/clinic"]) {
    assert.match(clinician, new RegExp(`href="${href.replaceAll("/", "\\/")}"`));
  }
  assert.doesNotMatch(clinician, /href="\/settings"/);
  assert.match(admin, /href="\/settings"/);
  assert.match(clinician, /Schedule/);
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
    renderer = create(<ClinicOfficeShell initialMessages={[first, second]} officeApi={api} initialSummary={summary()}><ClinicShell><ClinicHome /></ClinicShell></ClinicOfficeShell>);
  });
  assert.match(JSON.stringify(renderer.toJSON()), /Checkout question/);
  assert.match(JSON.stringify(renderer.toJSON()), /1 of 2/);

  await act(async () => renderer.root.findByProps({ role: "status" }).findByType("button").props.onClick());
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Checkout question/);
  assert.match(JSON.stringify(renderer.toJSON()), /Lab is holding/);
  assert.equal(renderer.root.findByProps({ className: "odos-office-badge" }).children.join(""), "1");

  await act(async () => renderer.update(
    <ClinicOfficeShell initialMessages={[first, second]} officeApi={api} initialSummary={summary()}>
      <ClinicShell><PatientOverview patient={patient} initialOverview={overviewFixture()} /></ClinicShell>
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

function ClinicShell({ children, roles = ["clinician"] }: { children: React.ReactNode; roles?: Array<"clinician" | "practice-admin"> }) {
  return <AppShell path="/clinic" roles={roles} homePath="/clinic" side="clinic" email="doctor@example.test">{children}</AppShell>;
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
    orders: {
      items: [],
      counts: {
        "patients-frame": 0,
        "in-office-not-sent": 2,
        outbound: 0,
        "at-lab": 0,
        "lenses-on-order": 0,
        "frame-on-order": 0,
        inbound: 0,
        received: 0,
        notified: 0,
        dispensed: 0,
      },
      activeCount: 2,
      alarms: { flaggedProblems: 0, atLabOverdue: 0, transmissionFailures: 0, receivedNotNotified: 0 },
      rollups: { preLab: 2, outbound: 0, atLab: 0, inbound: 0, notified: 0 },
      agingConfig: { outboundDays: 3, inboundDays: 3, atLabDays: 5, receivedNotifyHours: 24, notifiedRetryDays: 2, notifiedFollowUpDays: 7 },
    },
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

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function emptyDeskSummary() {
  const n = { value: 0, tone: "ok" as const };
  const off = { value: null, tone: "off" as const };
  return {
    cards: {
      schedule: { today: n, confirmed: n, checkedIn: n, webRequests: n, agenda: [] },
      attention: { items: [] },
      frontLine: { available: false, message: "Not wired", needsReply: off, missedCalls: off, voicemails: off, urgent: off, messages: [] },
      pendingRx: { spectacle: n, contactLens: off, labOrdersUnsent: off, oldestWaiting: off },
      productPickup: { openOrders: n, atLab: n, readyNotNotified: off, awaitingPickup: n },
      claims: { failed: n, inProcess: n, paperQueue: off, heldCents: n, lastTransmission: off },
      payments: { unappliedCount: n, unappliedCents: n, patientCreditsOpen: n, patientOpenBalanceCents: n, terminalMode: { value: "LIVE", tone: "ok" as const } },
      remits: { waitingToPost: n, unpostedCents: n },
      statements: { available: true, cadence: n, invalidRejects: n, lastStatement: off },
    },
    pulse: { itemsNeedingYou: 0, everythingElseAtTarget: true, lastClaimTransmission: null, lastClaimTransmissionTone: "off" as const },
  };
}
