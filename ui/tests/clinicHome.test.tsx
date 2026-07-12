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
  const labels = ["With You", "Roomed", "Waiting", "Unsigned Checkout", "Upcoming"];
  const positions = labels.map((label) => html.indexOf(label));
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

test("Vite proxies the Clinic aggregate to the MCP server", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /"\/clinic": \{ target: "http:\/\/localhost:3333"/);
});

function fixture(flow: ClinicFlowRow[]): ClinicSummary {
  return {
    flow,
    signatures: { count: 0, olderThan24Hours: 0, rows: [] },
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
