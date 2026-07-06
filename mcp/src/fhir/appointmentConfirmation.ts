import type { Appointment, Extension } from "@medplum/fhirtypes";

/**
 * Confirmation Status — the second status axis of the Eyefinity two-axis model (brief §2.5).
 *
 * Front-desk confirmation workflow state ("did we reach the patient?"), fully independent of the
 * appointment lifecycle status. R4 Appointment has no such field, so it rides a local osod
 * extension. Vocabulary is Eyefinity-verbatim (live screenshots, 2026-07-06).
 */

export const OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-appointment-confirmation";

export const OSOD_APPOINTMENT_CONFIRMATION_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/appointment-confirmation";

export const APPOINTMENT_CONFIRMATION_STATUSES = [
  { code: "not-confirmed", display: "Not Confirmed" },
  { code: "left-message", display: "Left Message" },
  { code: "not-available", display: "Not Available" },
  { code: "confirmed", display: "Confirmed" },
] as const;

export type AppointmentConfirmationStatus =
  (typeof APPOINTMENT_CONFIRMATION_STATUSES)[number]["code"];

const CONFIRMATION_BY_CODE = new Map<string, (typeof APPOINTMENT_CONFIRMATION_STATUSES)[number]>(
  APPOINTMENT_CONFIRMATION_STATUSES.map((status) => [status.code, status]),
);

export function assertConfirmationStatus(
  code: string,
): asserts code is AppointmentConfirmationStatus {
  if (!CONFIRMATION_BY_CODE.has(code)) {
    throw new Error(
      `Unknown confirmation status "${code}" — must be one of the four Eyefinity confirmation values.`,
    );
  }
}

/** Build the osod-appointment-confirmation extension carrying the confirmation state. */
export function appointmentConfirmationExtension(code: string): Extension {
  assertConfirmationStatus(code);
  const status = CONFIRMATION_BY_CODE.get(code)!;
  return {
    url: OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL,
    valueCodeableConcept: {
      coding: [
        {
          system: OSOD_APPOINTMENT_CONFIRMATION_SYSTEM,
          code: status.code,
          display: status.display,
        },
      ],
      text: status.display,
    },
  };
}

/** Read the confirmation code off an Appointment (undefined when never set). */
export function confirmationStatusOf(
  appointment: Appointment,
): AppointmentConfirmationStatus | undefined {
  const coding = appointment.extension
    ?.find((e) => e.url === OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.find(
      (c) => c.system === OSOD_APPOINTMENT_CONFIRMATION_SYSTEM,
    );
  return coding?.code as AppointmentConfirmationStatus | undefined;
}
