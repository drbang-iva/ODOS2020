import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouteSwitch } from "../src/App";
import { fetchDayLedger, type DayLedger as DayLedgerData } from "../src/lib/day-ledger";
import { DayLedger } from "../src/scenes/DayLedger";

const LEDGER: DayLedgerData = {
  date: "2026-07-15",
  payments: {
    available: true,
    tenderTotalsCents: { CASH: 12500, CHECK: 5000, CARD_MANUAL: 7500 },
    totalCents: 25000,
    detail: [
      { time: "2026-07-15T15:00:00.000Z", patientReference: "Patient/patient-1", staffer: "Practitioner/alex", tender: "CASH", amountCents: 12500 },
      { time: "2026-07-15T14:00:00.000Z", patientReference: "Patient/patient-2", staffer: "Practitioner/blair", tender: "CHECK", amountCents: 5000 },
      { time: "2026-07-15T13:00:00.000Z", patientReference: "Patient/patient-3", staffer: "Practitioner/alex", tender: "CARD_MANUAL", amountCents: 7500 },
    ],
    staffLedgerTotals: [
      { staffer: "Practitioner/alex", count: 2, subtotalCents: 20000 },
      { staffer: "Practitioner/blair", count: 1, subtotalCents: 5000 },
    ],
  },
  heldCreditsToday: { available: true, count: 0, totalCents: 0 },
};

test("Day Ledger renders monumental tenders, live feed, Sessions, credits, and the Close-day entry", () => {
  const html = renderToStaticMarkup(<DayLedger initialLedger={LEDGER} />);
  assert.match(html, /Day Ledger/);
  assert.match(html, /Cash/);
  assert.match(html, /\$125\.00/);
  assert.match(html, /Check/);
  assert.match(html, /Card/);
  assert.match(html, /Live feed/);
  assert.match(html, /Sessions/);
  assert.match(html, /Held credits today/);
  assert.match(html, /Close the day/);
  assert.match(html, /href="\/desk\/ledger\/close\?date=2026-07-15"/);
  assert.match(html, /href="\/desk\/ledger\/archive"/);
});

test("a sealed historical ledger renders the seal banner", () => {
  const html = renderToStaticMarkup(<DayLedger initialLedger={LEDGER} initialSeal={{
    id: "seal-1",
    date: "2026-07-15",
    sealedBy: "Practitioner/alex",
    sealedAt: "2026-07-15T21:00:00.000Z",
  }} />);
  assert.match(html, /Sealed by alex/);
  assert.match(html, /alex/);
});

test("Day Ledger route is registered in the application switch", () => {
  const html = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/desk/ledger" />);
  assert.match(html, /Day Ledger/);
  assert.match(html, /Opening today’s ledger/);
});

test("fetchDayLedger carries an optional date and surfaces endpoint errors", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const loaded = await fetchDayLedger("2026-07-15", async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(LEDGER), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  assert.equal(loaded.date, "2026-07-15");
  assert.equal(calls[0].input, "/desk/ledger?date=2026-07-15");
  assert.equal((calls[0].init?.headers as Record<string, string>).Accept, "application/json");
  await assert.rejects(
    () => fetchDayLedger(undefined, async () => new Response(JSON.stringify({ error: "Ledger unavailable" }), { status: 503 })),
    /Ledger unavailable/,
  );
});

test("Day Ledger CSS keeps tablet operation and phone triage layouts explicit", () => {
  const css = readFileSync(new URL("../src/styles/day-ledger.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 1024px\)/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /\.odos-ledger-tenders, \.odos-ledger-lower \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.odos-ledger-feed \{ order: 2; \}/);
});
