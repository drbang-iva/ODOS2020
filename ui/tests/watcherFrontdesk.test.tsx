import assert from "node:assert/strict";
import test from "node:test";
import type { Appointment, Schedule } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAppointmentBlockContent } from "../src/lib/scheduling";
import { DEFAULT_SCHEDULING_PRACTICE_CONFIG } from "../src/lib/scheduling-store";
import { watcherCollectionHref, type WatcherAlert, type WatcherFrontDeskProjection } from "../src/lib/watchers";
import { groupWatcherAlertsByAppointment } from "../src/scenes/SchedulerDayGrid";
import { FrontDeskCockpit } from "../src/scenes/frontdesk/FrontDeskCockpit";
import { PatientQuickCard } from "../src/scenes/scheduler/PatientQuickCard";
import { ResourceDayColumn } from "../src/scenes/scheduler/ResourceDayColumn";

const resource: Schedule = {
  resourceType: "Schedule",
  id: "schedule-1",
  active: true,
  actor: [{ reference: "Practitioner/doctor-1", display: "Dr One" }],
};
const sarah = appointment("appt-sarah", "Patient/sarah", "Sarah Miller", "2026-08-30T09:40:00-04:00");
const joe = appointment("appt-joe", "Patient/joe", "Joe Jones", "2026-08-30T10:10:00-04:00");
const alert: WatcherAlert = {
  taskId: "task-1",
  watcherId: "W1",
  severity: "today",
  patientReference: "Patient/sarah",
  patientDisplay: "Sarah M.",
  appointmentReference: "Appointment/appt-sarah",
  appointmentId: "appt-sarah",
  appointmentAt: "2026-08-30T09:40:00-04:00",
  message: "Sarah M. is on today's schedule at 9:40 AM with a $132 balance from March.",
  frontDeskMessage: "Sarah M. has a balance from March. She's on today's schedule at 9:40 AM — $132 from her last visit.",
  consequence: "Collecting at check-in works better than another statement.",
  primaryAction: { label: "View balance & collect", href: "/billing/claims/patient-payments?patientId=sarah" },
  dismissalReasons: [
    { code: "already-collected", display: "Already collected" },
    { code: "payment-plan", display: "Payment plan" },
    { code: "waived", display: "Waived" },
  ],
  balanceCents: 13200,
  ageDays: 173,
};
const coverageAlert: WatcherAlert = {
  ...alert,
  taskId: "task-21",
  watcherId: "W21",
  patientDisplay: "Sarah M.",
  message: "Sarah M. has inactive coverage before tomorrow's visit.",
  frontDeskMessage: "Sarah M. comes in tomorrow at 9:40 AM, and her insurance shows as inactive.",
  consequence: "Resolve coverage before the visit so it does not bill to the patient.",
  primaryAction: { label: "Open patient", href: "/insurance?patientId=sarah" },
  dismissalReasons: [
    { code: "already-sorted", display: "Already sorted" },
    { code: "patient-self-pay", display: "Patient is self-pay" },
    { code: "check-again", display: "Check again" },
  ],
  balanceCents: 0,
  ageDays: 0,
  reasonCode: "eligibility-inactive",
};

test("W1 cue attaches only to the matching patient's Appointment block", () => {
  const html = renderToStaticMarkup(
    <ResourceDayColumn
      resource={resource}
      config={DEFAULT_SCHEDULING_PRACTICE_CONFIG}
      date="2026-08-30"
      rows={[{ startMinutes: 570 }, { startMinutes: 600 }]}
      axisStartMinutes={570}
      axisEndMinutes={630}
      slotMinutes={30}
      appointments={[positioned(sarah, 0), positioned(joe, 1)]}
      watcherAlertsByAppointment={{ "appt-sarah": [alert] }}
      columnKey="watcher-test"
      rowHeight={70}
      onAppointmentClick={() => undefined}
      onBlockedRegionClick={() => undefined}
      onCellClick={() => undefined}
    />,
  );

  assert.equal(html.match(/\$132 balance/g)?.length, 1);
  assert.match(html, /Sarah Miller[\s\S]*\$132 balance/);
  assert.doesNotMatch(html, /Joe Jones[\s\S]*\$132 balance/);
});

test("the Appointment Quick Card renders the same Task's full W1 action and typed dismissals", () => {
  const html = renderToStaticMarkup(
    <PatientQuickCard
      appointment={sarah}
      watcherAlerts={[alert]}
      pinned={false}
      onPinnedChange={() => undefined}
      onClose={() => undefined}
      onDetails={() => undefined}
      onWatcherAction={() => undefined}
      date="2026-08-30"
    />,
  );

  assert.match(html, /Sarah M\. has a balance from March/);
  assert.match(html, /Collecting at check-in works better than another statement/);
  assert.equal(html.match(/View balance &amp; collect/g)?.length, 1);
  for (const reason of ["Already collected", "Payment plan", "Waived"]) assert.match(html, new RegExp(reason));
  assert.match(html, /collect=1&amp;watcherTaskId=task-1/);
});

test("W1 and W21 firing on the same appointment both render on the row and quick card", () => {
  const grouped = groupWatcherAlertsByAppointment([alert, coverageAlert]);
  assert.deepEqual(grouped["appt-sarah"].map((item) => item.taskId), ["task-1", "task-21"]);

  const row = renderToStaticMarkup(
    <ResourceDayColumn
      resource={resource}
      config={DEFAULT_SCHEDULING_PRACTICE_CONFIG}
      date="2026-08-30"
      rows={[{ startMinutes: 570 }]}
      axisStartMinutes={570}
      axisEndMinutes={600}
      slotMinutes={30}
      appointments={[positioned(sarah, 0)]}
      watcherAlertsByAppointment={grouped}
      columnKey="two-watchers"
      rowHeight={70}
      onAppointmentClick={() => undefined}
      onBlockedRegionClick={() => undefined}
      onCellClick={() => undefined}
    />,
  );
  assert.match(row, /\$132 balance/);
  assert.match(row, /Coverage problem/);

  const card = renderToStaticMarkup(
    <PatientQuickCard
      appointment={sarah}
      watcherAlerts={[alert, coverageAlert]}
      pinned={false}
      onPinnedChange={() => undefined}
      onClose={() => undefined}
      onDetails={() => undefined}
      onWatcherAction={() => undefined}
      date="2026-08-30"
    />,
  );
  assert.match(card, /Balance at check-in/);
  assert.match(card, /Coverage before visit/);
  assert.match(card, /View balance &amp; collect/);
  assert.match(card, /Open patient/);
});

test("the collection href carries the same Task id into the existing payment panel", () => {
  assert.equal(
    watcherCollectionHref(alert),
    "/billing/claims/patient-payments?patientId=sarah&collect=1&watcherTaskId=task-1",
  );
});

test("degraded Front Desk names the last success and renders no reassuring balance cue", () => {
  const degraded: WatcherFrontDeskProjection = {
    status: "degraded",
    reason: "failed",
    lastSuccessfulAt: "2026-08-30T11:55:00.000Z",
  };
  const html = renderToStaticMarkup(<FrontDeskCockpit initialWatcherProjection={degraded} />);

  assert.match(html, /Appointment watch degraded/);
  assert.match(html, /last succeeded.*2026-08-30T11:55/i);
  assert.doesNotMatch(html, /\$132 balance/);
});

function appointment(id: string, patientReference: string, display: string, start: string): Appointment {
  return {
    resourceType: "Appointment",
    id,
    status: "booked",
    start,
    end: start.replace(":40", ":55").replace(":10", ":25"),
    participant: [
      { actor: { reference: patientReference, display }, status: "accepted" },
      { actor: { reference: "Practitioner/doctor-1", display: "Dr One" }, status: "accepted" },
    ],
  };
}

function positioned(value: Appointment, rowStart: number) {
  return {
    appointment: value,
    geometry: { columnIndex: 0, rowStart, rowSpan: 1 },
    content: buildAppointmentBlockContent(value, []),
  };
}
