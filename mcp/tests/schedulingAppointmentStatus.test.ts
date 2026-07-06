import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OSOD_APPOINTMENT_STATUSES,
  V2_0276_APPOINTMENT_TYPE_SYSTEM,
  assertOsodAppointmentStatus,
  osodAppointmentStatusOf,
  toFhirAppointmentStatus,
} from "../src/fhir/schedulingAppointmentStatus.js";

test("the appointment-status vocabulary is the Eyefinity five plus cancelled (brief §2.5)", () => {
  assert.deepEqual(
    OSOD_APPOINTMENT_STATUSES.map((s) => s.code),
    ["scheduled", "checked-in", "checked-out", "no-show", "walk-in", "cancelled"],
  );
  assert.deepEqual(
    OSOD_APPOINTMENT_STATUSES.map((s) => s.display),
    ["Scheduled", "Checked In", "Checked Out", "No Show", "Walk In", "Cancelled"],
  );
});

test("each OSOD status maps onto the R4 appointment-status VS (brief §6)", () => {
  assert.deepEqual(toFhirAppointmentStatus("scheduled"), { status: "booked" });
  assert.deepEqual(toFhirAppointmentStatus("checked-in"), { status: "checked-in" });
  assert.deepEqual(toFhirAppointmentStatus("checked-out"), { status: "fulfilled" });
  assert.deepEqual(toFhirAppointmentStatus("no-show"), { status: "noshow" });
  assert.deepEqual(toFhirAppointmentStatus("cancelled"), { status: "cancelled" });
});

test("walk-in maps to arrived + the v2-0276 WALKIN appointmentType (R4 status VS has no walk-in)", () => {
  assert.deepEqual(toFhirAppointmentStatus("walk-in"), {
    status: "arrived",
    appointmentTypeCode: "WALKIN",
  });
});

test("assertOsodAppointmentStatus rejects a code outside the vocabulary", () => {
  assert.throws(() => assertOsodAppointmentStatus("rescheduled"), /appointment status/i);
});

test("every OSOD status round-trips through its FHIR representation", () => {
  for (const { code } of OSOD_APPOINTMENT_STATUSES) {
    const fhir = toFhirAppointmentStatus(code);
    const roundTripped = osodAppointmentStatusOf({
      status: fhir.status,
      appointmentType: fhir.appointmentTypeCode
        ? {
            coding: [
              { system: V2_0276_APPOINTMENT_TYPE_SYSTEM, code: fhir.appointmentTypeCode },
            ],
          }
        : undefined,
    });
    assert.equal(roundTripped, code, `round-trip broke for ${code}`);
  }
});

test("a foreign 'arrived' without WALKIN reads as checked-in (the patient is here)", () => {
  assert.equal(osodAppointmentStatusOf({ status: "arrived" }), "checked-in");
});

test("FHIR statuses outside the front-desk vocabulary read as undefined", () => {
  assert.equal(osodAppointmentStatusOf({ status: "waitlist" }), undefined);
  assert.equal(osodAppointmentStatusOf({ status: "entered-in-error" }), undefined);
});
