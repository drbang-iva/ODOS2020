import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { RouteSwitch } from "../src/App";
import type { DayCloseData } from "../src/lib/day-close";
import { fetchDayClose, fetchDaySeal, fetchDaySealArchive, postDaySeal } from "../src/lib/day-close";
import { CloseDay, DaySealArchive } from "../src/scenes/CloseDay";

const CLOSE_DATA: DayCloseData = {
  date: "2026-07-15",
  ledger: {
    date: "2026-07-15",
    payments: {
      available: true,
      tenderTotalsCents: { CASH: 12500, CHECK: 5000, CARD_MANUAL: 7500 },
      totalCents: 25000,
      detail: [{ time: "2026-07-15T15:00:00.000Z", patientReference: "Patient/p1", staffer: "Practitioner/alex", tender: "CASH", amountCents: 12500 }],
      staffLedgerTotals: [{ staffer: "Practitioner/alex", count: 1, subtotalCents: 12500 }],
    },
    heldCreditsToday: { available: true, count: 1, totalCents: 2000 },
  },
  review: {
    available: true,
    unattachedCharges: [{ chargeItemReference: "ChargeItem/c1", patientReference: "Patient/p2", description: "Exam", amountCents: 9000 }],
    heldCreditsToday: { available: true, count: 1, totalCents: 2000 },
    patientSkim: [{ patientReference: "Patient/p1", chargesTotalCents: 12500, paidTotalCents: 12500 }],
  },
};

test("Close the Day renders Verify, Review, Seal, tender counts, exceptions, and a role-specific blocked state", () => {
  const html = renderToStaticMarkup(<CloseDay roles={["provider"]} initialData={CLOSE_DATA} />);
  assert.match(html, /Verify/);
  assert.match(html, /Review/);
  assert.match(html, /Seal/);
  assert.match(html, /Cash counted/);
  assert.match(html, /Manual card counted/);
  assert.match(html, /Counted variance/);
  assert.match(html, /Unattached billable charges/);
  assert.match(html, /Held credits today/);
  assert.match(html, /Patient skim/);
  assert.match(html, /Admin \/ Manager/);
  assert.match(html, /Claims and billing work continue unchanged/);
  const renderer = create(<CloseDay roles={["provider"]} initialData={CLOSE_DATA} />);
  assert.equal(renderer.root.findByType("button").props.disabled, true);
});

test("a completed seal renders immutable attribution and the explicit no-claims-change Billing handoff", () => {
  const html = renderToStaticMarkup(<CloseDay roles={["staff"]} initialData={{
    ...CLOSE_DATA,
    seal: { id: "seal-1", date: "2026-07-15", sealedBy: "Practitioner/alex", sealedAt: "2026-07-15T22:00:00.000Z" },
  }} />);
  assert.match(html, /The day is sealed/);
  assert.match(html, /alex/);
  assert.match(html, /with Billing/);
  assert.match(html, /no claims or billing workflow was changed/);
  const renderer = create(<CloseDay roles={["staff"]} initialData={{
    ...CLOSE_DATA,
    seal: { id: "seal-1", date: "2026-07-15", sealedBy: "Practitioner/alex", sealedAt: "2026-07-15T22:00:00.000Z" },
  }} />);
  assert.equal(renderer.root.findAllByType("button").length, 0);
});

test("a sealed day never presents unavailable payment totals as zero", () => {
  const html = renderToStaticMarkup(<CloseDay roles={["staff"]} initialData={{
    ...CLOSE_DATA,
    ledger: { ...CLOSE_DATA.ledger, payments: { available: false, reason: "Payment totals unavailable." } },
    seal: { id: "seal-1", date: "2026-07-15", sealedBy: "Practitioner/alex", sealedAt: "2026-07-15T22:00:00.000Z" },
  }} />);
  assert.match(html, /Total unavailable/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("a known nonzero variance does not disable sealing for an authorized Admin", () => {
  const renderer = create(<CloseDay roles={["admin"]} initialData={CLOSE_DATA} />);
  const inputs = renderer.root.findAllByType("input");
  act(() => {
    for (const input of inputs) input.props.onChange({ target: { value: "0.00" } });
  });
  const button = renderer.root.findByType("button");
  assert.equal(button.props.disabled, false);
  assert.match(JSON.stringify(renderer.toJSON()), /-\$250\.00/);
});

test("Day archive links each seal to the historical ledger and shows live-read totals", () => {
  const html = renderToStaticMarkup(<DaySealArchive initialRows={[{
    id: "seal-1",
    date: "2026-07-15",
    sealedBy: "Practitioner/alex",
    sealedAt: "2026-07-15T22:00:00.000Z",
    totalCents: 25000,
  }]} />);
  assert.match(html, /Day Archive/);
  assert.match(html, /href="\/desk\/ledger\?date=2026-07-15"/);
  assert.match(html, /\$250\.00/);
  assert.match(html, /alex/);
});

test("close and archive routes are registered", () => {
  assert.match(renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/desk/ledger/close" roles={["staff"]} />), /Close the Day/);
  assert.match(renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/desk/ledger/archive" roles={["staff"]} />), /Day Archive/);
});

test("day-close API helpers preserve dates, JSON cents payload boundaries, and endpoint failures", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    if (String(input).includes("/close")) return new Response(JSON.stringify(CLOSE_DATA), { status: 200 });
    if (String(input).includes("/archive")) return new Response(JSON.stringify({ seals: [] }), { status: 200 });
    if (init?.method === "POST") return new Response(JSON.stringify({ seal: { id: "s1" }, ledger: CLOSE_DATA.ledger }), { status: 201 });
    return new Response(JSON.stringify({ seal: null }), { status: 200 });
  }) as typeof fetch;
  await fetchDayClose("2026-07-15", fetchImpl);
  await fetchDaySeal("2026-07-15", fetchImpl);
  await postDaySeal("2026-07-15", fetchImpl);
  await fetchDaySealArchive(fetchImpl);
  assert.equal(calls[0].input, "/desk/ledger/close?date=2026-07-15");
  assert.equal(calls[1].input, "/desk/ledger/seal?date=2026-07-15");
  assert.equal(calls[2].input, "/desk/ledger/seal");
  assert.equal(calls[2].init?.body, JSON.stringify({ date: "2026-07-15" }));
  assert.equal(calls[3].input, "/desk/ledger/archive");
  await assert.rejects(() => fetchDayClose(undefined, async () => new Response(JSON.stringify({ error: "review unavailable" }), { status: 409 })), /review unavailable/);
});

test("Close the Day CSS has explicit tablet and phone layouts", () => {
  const css = readFileSync(new URL("../src/styles/day-close.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /\.odos-close-count-grid, \.odos-close-review-grid \{ grid-template-columns: 1fr; \}/);
});
