import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, Encounter, Patient, Provenance, Task } from "@medplum/fhirtypes";
import { projectClinicSummary, type ClinicSummaryInput } from "../src/clinic/clinic-summary.js";

const NOW = "2026-07-11T15:00:00.000Z";
const DATE = "2026-07-11";

test("clinic summary derives every Encounter state and sorts actionable flow from a mixed seed", () => {
  const appointments = [
    appointment("scheduled", "booked", "15:00:00.000Z"),
    appointment("checked-out", "fulfilled", "13:00:00.000Z"),
    appointment("waiting", "checked-in", "14:30:00.000Z"),
    appointment("waiting-no-floor", "checked-in", "14:45:00.000Z"),
    appointment("with-you", "checked-in", "14:00:00.000Z"),
    appointment("roomed", "checked-in", "14:15:00.000Z"),
  ];
  const encounters = [
    encounter("checked-out", "finished"),
    encounter("waiting", "arrived"),
    encounter("roomed", "triaged"),
    encounter("with-you", "in-progress"),
  ];
  const patients = appointments.map((item) => patient(item.id!));
  const summary = projectClinicSummary(input({ appointments, encounters, patients }));

  assert.deepEqual(summary.flow.map((row) => row.state), ["with-you", "roomed", "waiting", "waiting", "checked-out", "scheduled"]);
  assert.deepEqual(summary.flow.map((row) => row.appointmentId), ["with-you", "roomed", "waiting", "waiting-no-floor", "checked-out", "scheduled"]);
  assert.equal(summary.flow.find((row) => row.appointmentId === "waiting")?.arrivedLateMinutes, 5);
  assert.equal(summary.flow.find((row) => row.appointmentId === "roomed")?.room, "Room 1");
  assert.equal(summary.flow.find((row) => row.appointmentId === "waiting-no-floor")?.waitingMinutes, undefined);
  assert.equal(summary.flow.find((row) => row.appointmentId === "checked-out")?.flags.unsigned, true);
  assert.equal("dilated" in (summary.flow[0]?.flags ?? {}), false);
});

test("signature debt uses the existing finish event and treats exactly 24h as inside the boundary", () => {
  const encounters = [
    finishedEncounter("exactly-24h", "2026-07-10T15:00:00.000Z"),
    finishedEncounter("older", "2026-07-10T14:59:00.000Z"),
    finishedEncounter("signed", "2026-07-09T15:00:00.000Z"),
    finishedEncounter("off-by-ms", "2026-07-11T14:00:00.000Z"),
  ];
  const provenances: Provenance[] = [
    {
      resourceType: "Provenance",
      target: [{ reference: "Encounter/signed" }],
      recorded: "2026-07-09T15:00:00.000Z",
      agent: [{ who: { display: "A label that is not used for matching" } }],
    },
    {
      resourceType: "Provenance",
      target: [{ reference: "Encounter/off-by-ms" }],
      recorded: "2026-07-11T14:00:00.001Z",
      agent: [{ who: { display: "Near checkout is not sign-off" } }],
    },
  ];
  const summary = projectClinicSummary(input({ encounters, provenances }));

  assert.equal(summary.signatures.count, 3);
  assert.equal(summary.signatures.olderThan24Hours, 1);
  assert.equal(summary.signatures.rows.find((row) => row.encounterId === "exactly-24h")?.olderThan24Hours, false);
  assert.equal(summary.signatures.rows.find((row) => row.encounterId === "older")?.olderThan24Hours, true);
  assert.ok(summary.signatures.rows.some((row) => row.encounterId === "off-by-ms"));
});

test("flow rows within the same state stay chronological by Appointment instant", () => {
  const summary = projectClinicSummary(input({
    appointments: [
      appointment("later", "booked", "15:00:00.000Z"),
      appointment("earlier", "booked", "13:00:00.000Z"),
    ],
    patients: [patient("later"), patient("earlier")],
  }));
  assert.deepEqual(summary.flow.map((row) => row.appointmentId), ["earlier", "later"]);
});

test("E-Rx and result review remain explicit wiring states with no invented counts", () => {
  const summary = projectClinicSummary(input());
  assert.deepEqual(summary.erx, {
    available: false,
    message: "E-prescribing and refill queues arrive with the WENO integration — not wired yet.",
  });
  assert.deepEqual(summary.review, {
    available: false,
    message: "Captured results do not yet persist a clinician-reviewed event — review queue not wired yet.",
  });
  assert.equal("count" in summary.erx, false);
  assert.equal("count" in summary.review, false);
});

test("Clinic-home orders reuse the board projection, counts, status-specific aging, and flagged-first sort", () => {
  const summary = projectClinicSummary(input({
    labOrders: [
      labTask("fresh", "sent", "2026-07-10T15:00:00.000Z", "Fresh Patient", "at-lab"),
      labTask("received", "received", "2026-07-11T13:00:00.000Z", "Received Patient", "received"),
      labTask("aging", "sent", "2026-07-05T14:59:00.000Z", "Aging Patient", "at-lab"),
      labTask("flagged", "sent", "2026-07-11T14:00:00.000Z", "Flagged Patient", "at-lab", true),
    ],
  }));

  assert.equal(summary.orders.activeCount, 4);
  assert.equal(summary.orders.counts["at-lab"], 3);
  assert.equal(summary.orders.alarms.atLabOverdue, 1);
  assert.equal(summary.orders.alarms.receivedNotNotified, 1);
  assert.equal(summary.orders.alarms.flaggedProblems, 1);
  assert.equal(summary.orders.items[0].reference, "Task/flagged");
  assert.equal(summary.orders.items.find((row) => row.reference === "Task/aging")?.overdue, true);
  assert.deepEqual(summary.orders.rollups, { preLab: 0, outbound: 0, atLab: 3, inbound: 1, notified: 0 });
});

function input(overrides: Partial<ClinicSummaryInput> = {}): ClinicSummaryInput {
  return { appointments: [], encounters: [], patients: [], provenances: [], labOrders: [], now: NOW, date: DATE, timeZone: "America/New_York", ...overrides };
}

function labTask(
  id: string,
  state: "queued" | "sent" | "received",
  authoredOn: string,
  patientName: string,
  status?: "at-lab" | "received",
  flagged = false,
): Task {
  return {
    resourceType: "Task",
    id,
    status: state === "received" ? "completed" : state === "queued" ? "requested" : "in-progress",
    intent: "order",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/task-type", code: "lab-order-transmission" }] },
    businessStatus: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/lab-transport-state", code: state }] },
    authoredOn,
    input: [{
      type: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/lab-order-task-input", code: "lab-order-export" }] },
      valueString: JSON.stringify({
        format: "odos-lab-order",
        version: "0",
        order: {
          header: { orderId: id, orderDate: "2026-07-05", lab: "Example Lab", patientName, patientRef: `Patient/${id}` },
          rx: { od: {}, os: {} },
          lensSpec: { jobType: "Rx", lensDesign: "Progressive", lensMaterial: "Poly", treatments: [] },
          frameSource: 4,
          frameOwnership: "in-house",
        },
      }),
    }, ...(status ? [{
      type: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/lab-order-task-input", code: "lab-order-status" }] },
      valueString: JSON.stringify({
        version: 1,
        currentStatus: status,
        history: [{ status, enteredAt: authoredOn }],
        problemFlags: flagged ? [{
          id: "flag-1",
          reason: "lab-breakage-remake",
          note: "Remaking lens",
          flaggedBy: "Practitioner/hannah",
          flaggedAt: authoredOn,
        }] : [],
      }),
    }] : [])],
  };
}

function appointment(id: string, status: Appointment["status"], time: string): Appointment {
  return {
    resourceType: "Appointment",
    id,
    status,
    start: `2026-07-11T${time}`,
    end: `2026-07-11T15:30:00.000Z`,
    serviceType: [{ text: "Comprehensive" }],
    participant: [{ actor: { reference: `Patient/${id}` }, status: "accepted" }],
    ...(id === "waiting" ? { extension: [floor("waiting", "2026-07-11T14:35:00.000Z", "2026-07-11T14:35:00.000Z")] } : {}),
    ...(id === "roomed" ? { extension: [floor("room-1", "2026-07-11T14:40:00.000Z", "2026-07-11T14:15:00.000Z")] } : {}),
  };
}

function encounter(id: string, status: Encounter["status"]): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status,
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${id}` },
    appointment: [{ reference: `Appointment/${id}` }],
    period: { start: "2026-07-11T14:00:00.000Z", ...(status === "finished" ? { end: "2026-07-11T14:50:00.000Z" } : {}) },
  };
}

function finishedEncounter(id: string, end: string): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${id}` },
    period: { start: end, end },
    type: [{ text: "Comprehensive" }],
  };
}

function patient(id: string): Patient {
  return { resourceType: "Patient", id, name: [{ given: [id], family: "Patient" }], birthDate: "1980-07-12", gender: "female" };
}

function floor(station: string, since: string, checkedInAt: string) {
  return {
    url: "https://odos2020.com/fhir/StructureDefinition/odos-floor-state",
    extension: [
      { url: "station", valueString: station },
      { url: "since", valueInstant: since },
      { url: "checkedInAt", valueInstant: checkedInAt },
    ],
  };
}
