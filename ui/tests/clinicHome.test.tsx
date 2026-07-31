import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClinicFlowRow, ClinicSummary } from "../src/lib/clinic-summary";
import type { LabOrderBoardSummary } from "../src/lib/lab-order-transport";
import { ClinicHome } from "../src/scenes/ClinicHome";

test("Clinic home renders a mixed-state payload in the server-defined action order", () => {
  const summary = fixture([
    row("with-you", "With You"),
    row("roomed", "Roomed"),
    row("waiting", "Waiting"),
    row("checked-out", "Unsigned Checkout", true),
    row("scheduled", "Upcoming"),
  ]);
  const html = renderToStaticMarkup(<ClinicHome initialSummary={summary} />);
  const flowCard = html.match(/class="odos-clinic-card odos-clinic-flow-card[\s\S]*?<\/section>/)?.[0] ?? "";
  const labels = ["With You", "Roomed", "Waiting", "Unsigned Checkout", "Upcoming"];
  const positions = labels.map((label) => flowCard.indexOf(label));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(html, /Open full schedule →/);
});

test("flow rows show the full trimmed note on the compact cue and mark urgent appointments", () => {
  const note = "Dilate before OCT retina recheck.";
  const marked = { ...row("waiting", "Marked"), note, urgent: true, followUp: true };
  const html = renderToStaticMarkup(<ClinicHome initialSummary={fixture([marked])} />);

  assert.match(html, new RegExp(`aria-label="Appointment note" title="${note}"`));
  assert.match(html, /class="odos-clinic-urgent-cue" title="Urgent">!<\/span>/);
});

test("authorized present rows get start-or-open while scheduled and checked-out rows keep patient navigation", () => {
  const presentOpen = { ...row("with-you", "With You"), encounterId: "encounter-1" };
  const summary = fixture([
    presentOpen,
    row("roomed", "Roomed"),
    row("waiting", "Waiting"),
    row("checked-out", "Checked Out"),
    row("scheduled", "Scheduled"),
  ]);
  const html = renderToStaticMarkup(
    <ClinicHome initialSummary={summary} roles={["front-desk", "clinician"]} />,
  );

  assert.equal((html.match(/>Open chart<\/button>/g) ?? []).length, 1);
  assert.equal((html.match(/>Start chart<\/button>/g) ?? []).length, 2);
  assert.equal((html.match(/class="odos-clinic-flow-open"/g) ?? []).length, 5);
  assert.equal((html.match(/<button type="button" class="odos-clinic-flow-open"/g) ?? []).length, 2);
});

test("Clinic flow imports the existing chart RBAC gate instead of deriving roles locally", () => {
  const source = readFileSync(new URL("../src/scenes/ClinicHome.tsx", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ canStartAppointmentChart, type PracticeRoleId \} from "\.\.\/lib\/practice-roles"/);
  assert.match(source, /const canStartChart = canStartAppointmentChart\(roles\)/);
  assert.doesNotMatch(source, /roles\.includes\(/);
  assert.match(appSource, /<ClinicHome roles=\{roles\} \/>/);
});

test("E-Rx wiring card contains no numeric zero placeholder", () => {
  const html = renderToStaticMarkup(<ClinicHome initialSummary={fixture([])} />);
  const card = html.match(/data-testid="clinic-erx-card"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(card, /not wired yet/);
  assert.doesNotMatch(card, /0/);
});

test("results review renders the honest wiring state because no reviewed event is persisted", () => {
  const html = renderToStaticMarkup(<ClinicHome initialSummary={fixture([])} />);
  const card = html.match(/data-testid="clinic-review-card"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(card, /do not yet persist a clinician-reviewed event/);
  assert.doesNotMatch(card, /waiting<\/span>/);
});

test("waiting strip counts reuse the matching signature and order card values", () => {
  const summary = fixture([]);
  summary.signatures = { count: 3, olderThan24Hours: 1, rows: [] };
  summary.orders = orders({
    activeCount: 4,
    rollups: { preLab: 1, outbound: 1, atLab: 1, inbound: 1, notified: 0 },
    counts: { ...orders().counts, "in-office-not-sent": 1, outbound: 1, "at-lab": 1, received: 1 },
    alarms: { ...orders().alarms, receivedNotNotified: 1 },
    items: [{
      reference: "Task/received",
      orderId: "received",
      patientName: "Patient Ready",
      lab: "Cherry",
      frame: "Ray-Ban",
      lenses: "SV · Poly",
      frameSource: 4,
      frameSourceLabel: "Frame enclosed",
      frameOwnership: "in-house",
      status: "received",
      statusLabel: "Received",
      enteredAt: "2026-07-11T14:00:00Z",
      ageMinutes: 60,
      limitMinutes: 1440,
      needsAction: true,
      overdue: false,
      transportState: "received",
      transmissionFact: { kind: "manual", label: "print + mail" },
      problemFlags: [],
    }],
  });
  const html = renderToStaticMarkup(<ClinicHome initialSummary={summary} />);
  const unsigned = html.match(/data-testid="clinic-wait-unsigned"[\s\S]*?<\/a>/)?.[0] ?? "";
  const signatures = html.match(/data-testid="clinic-signatures-card"[\s\S]*?<\/section>/)?.[0] ?? "";
  const ordersChip = html.match(/data-testid="clinic-wait-orders"[\s\S]*?<\/a>/)?.[0] ?? "";
  const orderCard = html.match(/data-testid="clinic-orders-card"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(unsigned, />3<\/strong>/);
  assert.match(signatures, />3 charts<\/span>/);
  assert.match(ordersChip, />4<\/strong>/);
  assert.match(orderCard, />1 need attention<\/span>/);
  assert.match(orderCard, />1<\/b> pre-lab/);
  assert.match(orderCard, />1<\/b> inbound/);
});

test("unavailable queues render honest strings in the strip instead of numeric placeholders", () => {
  const html = renderToStaticMarkup(<ClinicHome initialSummary={fixture([])} />);
  for (const testId of ["clinic-wait-results", "clinic-wait-refills", "clinic-wait-erx"]) {
    const chip = html.match(new RegExp(`data-testid="${testId}"[\\s\\S]*?<\\/button>`))?.[0] ?? "";
    assert.match(chip, /not wired/i);
    assert.doesNotMatch(chip, />0</);
  }
});

test("container-query contracts stack tablet cards and fold phone detail cards", () => {
  const css = readFileSync(new URL("../src/styles/clinic-home.css", import.meta.url), "utf8");
  const tablet = css.match(/@container \(max-width: 1120px\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const phone = css.match(/@container \(max-width: 700px\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(css, /\.odos-clinic-shell \{[^}]*container-type: inline-size/);
  assert.match(css, /\.odos-clinic-flow-card \{ grid-column: span 8/);
  assert.match(css, /\.odos-clinic-lower-row \{ grid-column: span 12; display: grid; grid-template-columns: repeat\(3/);
  assert.match(tablet, /\.odos-clinic-flow-card, \.odos-clinic-stack \{ grid-column: span 12/);
  assert.match(tablet, /\.odos-clinic-shell \.odos-location \{ display: none/);
  assert.match(phone, /\.odos-clinic-lower-row \{ display: none/);
  assert.match(phone, /\.odos-clinic-search \{ order: 9; flex-basis: 100%/);
  assert.match(phone, /\.odos-clinic-flow-open \{ grid-template-columns: 40px 1fr/);
});

test("Vite serves Desk and Clinic navigations from the SPA while preserving their MCP proxies", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /const mcpTarget = env\.ODOS_MCP_PROXY_TARGET \|\| "http:\/\/localhost:3333"/);
  for (const route of ["desk", "clinic"]) {
    const proxy = config.match(new RegExp(`"/${route}": \\{[\\s\\S]*?\\n      \\},`))?.[0] ?? "";
    assert.match(proxy, /target: mcpTarget/);
    assert.match(proxy, /req\.headers\["sec-fetch-dest"\] === "document"/);
    assert.match(proxy, /req\.headers\.accept \|\| ""/);
    assert.match(proxy, /return "\/index\.html"/);
  }
  assert.match(config, /"\/practice": \{ target: mcpTarget, changeOrigin: true \}/);
});

function fixture(flow: ClinicFlowRow[]): ClinicSummary {
  return {
    flow,
    signatures: { count: 0, olderThan24Hours: 0, rows: [] },
    orders: orders(),
    erx: { available: false, message: "E-prescribing and refill queues arrive with the WENO integration — not wired yet." },
    review: { available: false, message: "Captured results do not yet persist a clinician-reviewed event — review queue not wired yet." },
  };
}

function orders(overrides: Partial<LabOrderBoardSummary> = {}): LabOrderBoardSummary {
  return {
    items: [],
    counts: {
      "patients-frame": 0,
      "in-office-not-sent": 0,
      outbound: 0,
      "at-lab": 0,
      "lenses-on-order": 0,
      "frame-on-order": 0,
      inbound: 0,
      received: 0,
      notified: 0,
      dispensed: 0,
    },
    activeCount: 0,
    unprojectableCount: 0,
    skippedInventoryUnitCount: 0,
    alarms: { flaggedProblems: 0, atLabOverdue: 0, transmissionFailures: 0, receivedNotNotified: 0 },
    rollups: { preLab: 0, outbound: 0, atLab: 0, inbound: 0, notified: 0 },
    agingConfig: { outboundDays: 3, inboundDays: 3, atLabDays: 5, receivedNotifyHours: 24, notifiedRetryDays: 2, notifiedFollowUpDays: 7 },
    ...overrides,
  };
}

function row(state: ClinicFlowRow["state"], patient: string, unsigned = false): ClinicFlowRow {
  return {
    appointmentId: patient,
    patientId: patient,
    time: "9:00 AM",
    patient,
    visitType: "Comprehensive",
    state,
    stateDetail: state,
    flags: { unsigned },
  };
}
