import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClinicFlowRow, ClinicSummary } from "../src/lib/clinic-summary";
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
  summary.orders = { count: 4, agingCount: 1, agingThresholdDays: 5, rows: [] };
  const html = renderToStaticMarkup(<ClinicHome initialSummary={summary} />);
  const unsigned = html.match(/data-testid="clinic-wait-unsigned"[\s\S]*?<\/a>/)?.[0] ?? "";
  const signatures = html.match(/data-testid="clinic-signatures-card"[\s\S]*?<\/section>/)?.[0] ?? "";
  const orders = html.match(/data-testid="clinic-wait-orders"[\s\S]*?<\/a>/)?.[0] ?? "";
  const orderCard = html.match(/data-testid="clinic-orders-card"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(unsigned, />3<\/strong>/);
  assert.match(signatures, />3 charts<\/span>/);
  assert.match(orders, />4<\/strong>/);
  assert.match(orderCard, />4 active · 1 aging<\/span>/);
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

test("Vite proxies the Clinic aggregate to the MCP server", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /"\/clinic": \{ target: "http:\/\/localhost:3333"/);
});

function fixture(flow: ClinicFlowRow[]): ClinicSummary {
  return {
    flow,
    signatures: { count: 0, olderThan24Hours: 0, rows: [] },
    orders: { count: 0, agingCount: 0, agingThresholdDays: 5, rows: [] },
    erx: { available: false, message: "E-prescribing and refill queues arrive with the WENO integration — not wired yet." },
    review: { available: false, message: "Captured results do not yet persist a clinician-reviewed event — review queue not wired yet." },
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
