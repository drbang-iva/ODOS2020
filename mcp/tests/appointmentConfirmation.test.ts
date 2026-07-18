import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment } from "@medplum/fhirtypes";
import {
  APPOINTMENT_CONFIRMATION_STATUSES,
  ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
  ODOS_APPOINTMENT_CONFIRMATION_SYSTEM,
  appointmentConfirmationExtension,
  assertConfirmationStatus,
  confirmationStatusOf,
} from "../src/fhir/appointmentConfirmation.js";

test("the confirmation vocabulary is the Eyefinity four, verbatim (brief §2.5)", () => {
  assert.deepEqual(
    APPOINTMENT_CONFIRMATION_STATUSES.map((s) => s.code),
    ["not-confirmed", "left-message", "not-available", "confirmed"],
  );
  assert.deepEqual(
    APPOINTMENT_CONFIRMATION_STATUSES.map((s) => s.display),
    ["Not Confirmed", "Left Message", "Not Available", "Confirmed"],
  );
});

test("appointmentConfirmationExtension builds the odos extension with a coded value", () => {
  const ext = appointmentConfirmationExtension("left-message");
  assert.equal(ext.url, ODOS_APPOINTMENT_CONFIRMATION_EXTENSION_URL);
  const coding = ext.valueCodeableConcept?.coding?.[0];
  assert.equal(coding?.system, ODOS_APPOINTMENT_CONFIRMATION_SYSTEM);
  assert.equal(coding?.code, "left-message");
  assert.equal(coding?.display, "Left Message");
});

test("assertConfirmationStatus rejects a code outside the four-value vocabulary", () => {
  assert.throws(() => assertConfirmationStatus("maybe"), /confirmation/i);
});

test("confirmationStatusOf reads the confirmation code back off an Appointment", () => {
  const appointment: Appointment = {
    resourceType: "Appointment",
    status: "booked",
    participant: [{ actor: { reference: "Patient/p1" }, status: "accepted" }],
    extension: [appointmentConfirmationExtension("confirmed")],
  };
  assert.equal(confirmationStatusOf(appointment), "confirmed");
});

test("confirmationStatusOf is undefined when the extension is absent", () => {
  const appointment: Appointment = {
    resourceType: "Appointment",
    status: "booked",
    participant: [{ actor: { reference: "Patient/p1" }, status: "accepted" }],
  };
  assert.equal(confirmationStatusOf(appointment), undefined);
});
