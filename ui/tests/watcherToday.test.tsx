import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WatcherAlert, WatcherTodayProjection } from "../src/lib/watchers";
import { BillingToday } from "../src/scenes/BillingToday";

test("Today renders the server-capped five cards, one overflow group, and adjacent count-dollar deltas", () => {
  const projection: WatcherTodayProjection = {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    goLiveAt: "2026-08-01T00:00:00.000Z",
    items: Array.from({ length: 5 }, (_, index) => alert(index + 1)),
    overflow: { total: 3, groups: [{ watcherId: "W1", count: 3 }] },
    sinceYesterday: {
      today: { patientCount: 8, dollarsCents: 36000 },
      yesterday: { patientCount: 2, dollarsCents: 6000 },
      delta: { patientCount: 6, dollarsCents: 30000 },
    },
  };
  const html = renderToStaticMarkup(<BillingToday initialProjection={projection} />);

  assert.equal(html.match(/data-watcher-card="W1"/g)?.length, 5);
  assert.match(html, /3 more, grouped by reason/);
  assert.match(html, /8 patients[\s\S]*\$360/);
  assert.match(html, /\+6 patients[\s\S]*\+\$300/);
});

test("Today healthy-empty and degraded-last-success states are mutually exclusive", () => {
  const empty = renderToStaticMarkup(<BillingToday initialProjection={{
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    goLiveAt: "2026-08-01T00:00:00.000Z",
    items: [],
    overflow: { total: 0, groups: [] },
    sinceYesterday: {
      today: { patientCount: 0, dollarsCents: 0 },
      yesterday: { patientCount: 0, dollarsCents: 0 },
      delta: { patientCount: 0, dollarsCents: 0 },
    },
  }} />);
  const degraded = renderToStaticMarkup(<BillingToday initialProjection={{
    status: "degraded",
    reason: "stale",
    lastSuccessfulAt: "2026-08-30T11:30:00.000Z",
  }} />);

  assert.match(empty, /Nothing needs a human today/);
  assert.match(empty, /Watching since/);
  assert.doesNotMatch(empty, /Watch degraded/);
  assert.match(degraded, /Watch degraded/);
  assert.match(degraded, /2026-08-30T11:30/);
  assert.doesNotMatch(degraded, /Nothing needs a human today/);
});

test("each Today card has one front-desk primary action plus snooze, typed dismiss, and reassign controls", () => {
  const projection: WatcherTodayProjection = {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    goLiveAt: "2026-08-01T00:00:00.000Z",
    items: [alert(1)],
    overflow: { total: 0, groups: [] },
    sinceYesterday: {
      today: { patientCount: 1, dollarsCents: 1000 },
      yesterday: { patientCount: 0, dollarsCents: 0 },
      delta: { patientCount: 1, dollarsCents: 1000 },
    },
  };
  const html = renderToStaticMarkup(<BillingToday initialProjection={projection} />);

  assert.equal(html.match(/Act at appointment/g)?.length, 1);
  assert.match(html, /Snooze/);
  assert.match(html, /Already collected/);
  assert.match(html, /Payment plan/);
  assert.match(html, /Waived/);
  assert.match(html, /Reassign/);
  assert.match(html, /href="\/frontdesk\?appointmentId=appt-1"/);
});

function alert(index: number): WatcherAlert {
  return {
    taskId: `task-${index}`,
    watcherId: "W1",
    severity: "today",
    patientReference: `Patient/patient-${index}`,
    patientDisplay: `Patient ${index}`,
    appointmentReference: `Appointment/appt-${index}`,
    appointmentId: `appt-${index}`,
    appointmentAt: `2026-08-30T0${index}:40:00-04:00`,
    message: `Patient ${index} is on today's schedule with a balance.`,
    frontDeskMessage: `Patient ${index} has a balance.`,
    consequence: "Collecting at check-in works better than another statement.",
    primaryAction: { label: "View balance & collect", href: `/billing/claims/patient-payments?patientId=patient-${index}` },
    dismissalReasons: [
      { code: "already-collected", display: "Already collected" },
      { code: "payment-plan", display: "Payment plan" },
      { code: "waived", display: "Waived" },
    ],
    balanceCents: index * 1000,
    ageDays: index,
  };
}
