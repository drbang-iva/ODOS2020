import type { Appointment, CodeableConcept } from "@medplum/fhirtypes";

/**
 * Appointment Status — the first status axis of the Eyefinity two-axis model (brief §2.5).
 *
 * The front-desk lifecycle vocabulary is Eyefinity-verbatim (Scheduled · Checked In · Checked Out ·
 * No Show · Walk In) plus Cancelled (every PMS cancels; R4 has it natively). Each code derives its
 * FHIR representation — no duplicate state to drift:
 *
 *   scheduled   ↔ booked
 *   checked-in  ↔ checked-in   (R4: pre-encounter administrative work complete — the desk's act)
 *   checked-out ↔ fulfilled
 *   no-show     ↔ noshow
 *   walk-in     ↔ arrived + appointmentType v2-0276 WALKIN (R4 status VS has no walk-in)
 *   cancelled   ↔ cancelled
 */

export const V2_0276_APPOINTMENT_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v2-0276";

type FhirAppointmentStatus = Appointment["status"];

export const OSOD_APPOINTMENT_STATUSES = [
  { code: "scheduled", display: "Scheduled", fhirStatus: "booked" },
  { code: "checked-in", display: "Checked In", fhirStatus: "checked-in" },
  { code: "checked-out", display: "Checked Out", fhirStatus: "fulfilled" },
  { code: "no-show", display: "No Show", fhirStatus: "noshow" },
  { code: "walk-in", display: "Walk In", fhirStatus: "arrived", appointmentTypeCode: "WALKIN" },
  { code: "cancelled", display: "Cancelled", fhirStatus: "cancelled" },
] as const;

export type OsodAppointmentStatus = (typeof OSOD_APPOINTMENT_STATUSES)[number]["code"];

const STATUS_BY_CODE = new Map<string, (typeof OSOD_APPOINTMENT_STATUSES)[number]>(
  OSOD_APPOINTMENT_STATUSES.map((status) => [status.code, status]),
);

export function assertOsodAppointmentStatus(
  code: string,
): asserts code is OsodAppointmentStatus {
  if (!STATUS_BY_CODE.has(code)) {
    throw new Error(
      `Unknown appointment status "${code}" — must be one of the six front-desk lifecycle values.`,
    );
  }
}

export interface FhirStatusMapping {
  status: FhirAppointmentStatus;
  /** Set only for walk-in: the v2-0276 appointmentType code carrying the booking style. */
  appointmentTypeCode?: string;
}

/** The FHIR representation of an OSOD front-desk status. */
export function toFhirAppointmentStatus(code: string): FhirStatusMapping {
  assertOsodAppointmentStatus(code);
  const status = STATUS_BY_CODE.get(code)!;
  return {
    status: status.fhirStatus,
    ...("appointmentTypeCode" in status
      ? { appointmentTypeCode: status.appointmentTypeCode }
      : {}),
  };
}

/**
 * Read the OSOD front-desk status back off an Appointment's FHIR fields.
 *
 * `arrived` + WALKIN reads as walk-in; a foreign `arrived` without WALKIN reads as checked-in
 * (the patient is physically here — the closest front-desk semantic). FHIR statuses outside the
 * front-desk vocabulary (proposed/pending/waitlist/entered-in-error) read as undefined.
 */
export function osodAppointmentStatusOf(appointment: {
  status: FhirAppointmentStatus;
  appointmentType?: CodeableConcept;
}): OsodAppointmentStatus | undefined {
  if (appointment.status === "arrived") {
    const isWalkIn = appointment.appointmentType?.coding?.some(
      (c) => c.system === V2_0276_APPOINTMENT_TYPE_SYSTEM && c.code === "WALKIN",
    );
    return isWalkIn ? "walk-in" : "checked-in";
  }
  const match = OSOD_APPOINTMENT_STATUSES.find(
    (status) => status.fhirStatus === appointment.status && !("appointmentTypeCode" in status),
  );
  return match?.code;
}
