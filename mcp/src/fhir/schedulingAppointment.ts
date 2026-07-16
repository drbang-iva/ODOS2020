import type { Appointment, Extension, Reference, Slot } from "@medplum/fhirtypes";
import { assertDiscipline, disciplineCoding } from "../scheduling/clinic-mode.js";
import { appointmentConfirmationExtension } from "./appointmentConfirmation.js";
import {
  V2_0276_APPOINTMENT_TYPE_SYSTEM,
  toFhirAppointmentStatus,
} from "./schedulingAppointmentStatus.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "./schedulingVisitType.js";

/**
 * The scheduler Appointment builder — the Eyefinity details-modal data model on FHIR R4
 * (brief §3.2): service type + discipline, vision/medical insurance, resource(s), date/time/
 * duration, both status axes, notes, urgent + follow-up flags, non-patient appointments.
 *
 * R4 homes, native-first: notes → `comment`; urgent → `priority` 1 (iCal highest); walk-in →
 * `appointmentType` v2-0276 WALKIN via the status-axis module. Only what R4 lacks rides odos
 * extensions: confirmation status, vision/medical coverage split, the follow-up flag.
 */

export const ODOS_VISION_COVERAGE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-vision-coverage";

export const ODOS_MEDICAL_COVERAGE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-medical-coverage";

export const ODOS_FOLLOW_UP_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-appointment-follow-up";

export interface CoverageInput {
  /** Coverage/… reference when the payer is on file. */
  reference?: string;
  /** Payer display name for the block ("VSP", "BCBS"). */
  display?: string;
}

export interface SchedulingAppointmentInput {
  /** Absent for non-patient appointments (then description is required). */
  patient?: { reference: string; display?: string };
  /** Block label for non-patient appointments; optional subject line otherwise. */
  description?: string;
  /** Catalog code from the visit-type catalog (Appointment.serviceType). */
  visitTypeCode: string;
  visitTypeDisplay?: string;
  discipline: string;
  /** The resource column(s) this block occupies; at least one. */
  resources: { reference: string; display?: string }[];
  /** ISO dateTime WITH timezone offset (R4 requires it when time is present). */
  start: string;
  durationMinutes: number;
  /** ODOS front-desk status (default "scheduled"). */
  status?: string;
  /** Confirmation axis (default "not-confirmed"). */
  confirmation?: string;
  visionCoverage?: CoverageInput;
  medicalCoverage?: CoverageInput;
  /** Internal notes → Appointment.comment. */
  notes?: string;
  urgent?: boolean;
  followUp?: boolean;
  /** Slots this booking fills (set by the booking flow). */
  slotReferences?: string[];
  /** Booking-creation timestamp (service layer stamps with its injected clock). */
  created?: string;
}

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

/** Add minutes to an ISO dateTime, preserving its timezone offset suffix. */
export function addMinutesIso(start: string, minutes: number): string {
  const match = ISO_WITH_OFFSET.exec(start);
  if (!match) {
    throw new Error(
      `Appointment start must be an ISO dateTime with a timezone offset, got "${start}".`,
    );
  }
  const [, year, month, day, hour, minute, second, offset] = match;
  const wallClockMs =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) +
    minutes * 60_000;
  const shifted = new Date(wallClockMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    offset
  );
}

function coverageExtension(url: string, coverage: CoverageInput): Extension {
  return {
    url,
    valueReference: {
      ...(coverage.reference ? { reference: coverage.reference } : {}),
      ...(coverage.display ? { display: coverage.display } : {}),
    },
  };
}

/** Build the R4 Appointment for a front-desk booking (patient or non-patient). */
export function buildSchedulingAppointment(input: SchedulingAppointmentInput): Appointment {
  if (!input.patient && !input.description) {
    throw new Error(
      "An appointment requires a patient — or a description when booking a non-patient block.",
    );
  }
  if (!input.visitTypeCode) {
    throw new Error("An appointment requires a visit-type catalog code.");
  }
  assertDiscipline(input.discipline);
  if (!input.resources || input.resources.length === 0) {
    throw new Error("An appointment requires at least one resource (provider/room/equipment).");
  }
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new Error("Appointment duration (durationMinutes) must be a positive integer.");
  }
  const end = addMinutesIso(input.start, input.durationMinutes);

  const fhirStatus = toFhirAppointmentStatus(input.status ?? "scheduled");

  return {
    resourceType: "Appointment",
    status: fhirStatus.status,
    ...(fhirStatus.appointmentTypeCode
      ? {
          appointmentType: {
            coding: [
              {
                system: V2_0276_APPOINTMENT_TYPE_SYSTEM,
                code: fhirStatus.appointmentTypeCode,
              },
            ],
          },
        }
      : {}),
    serviceCategory: [{ coding: [disciplineCoding(input.discipline)] }],
    serviceType: [
      {
        coding: [
          {
            system: ODOS_VISIT_TYPE_SYSTEM,
            code: input.visitTypeCode,
            ...(input.visitTypeDisplay ? { display: input.visitTypeDisplay } : {}),
          },
        ],
        ...(input.visitTypeDisplay ? { text: input.visitTypeDisplay } : {}),
      },
    ],
    ...(input.description ? { description: input.description } : {}),
    ...(input.urgent ? { priority: 1 } : {}),
    start: input.start,
    end,
    minutesDuration: input.durationMinutes,
    ...(input.slotReferences && input.slotReferences.length > 0
      ? { slot: input.slotReferences.map((reference): Reference<Slot> => ({ reference })) }
      : {}),
    ...(input.created ? { created: input.created } : {}),
    ...(input.notes ? { comment: input.notes } : {}),
    participant: [
      ...(input.patient
        ? [
            {
              actor: {
                reference: input.patient.reference,
                ...(input.patient.display ? { display: input.patient.display } : {}),
              },
              status: "accepted" as const,
            },
          ]
        : []),
      ...input.resources.map((resource) => ({
        actor: {
          reference: resource.reference,
          ...(resource.display ? { display: resource.display } : {}),
        },
        status: "accepted" as const,
      })),
    ],
    extension: [
      appointmentConfirmationExtension(input.confirmation ?? "not-confirmed"),
      ...(input.visionCoverage
        ? [coverageExtension(ODOS_VISION_COVERAGE_EXTENSION_URL, input.visionCoverage)]
        : []),
      ...(input.medicalCoverage
        ? [coverageExtension(ODOS_MEDICAL_COVERAGE_EXTENSION_URL, input.medicalCoverage)]
        : []),
      ...(input.followUp ? [{ url: ODOS_FOLLOW_UP_EXTENSION_URL, valueBoolean: true }] : []),
    ],
  };
}

function coverageOf(appointment: Appointment, url: string): CoverageInput | undefined {
  const value = appointment.extension?.find((e) => e.url === url)?.valueReference;
  if (!value) {
    return undefined;
  }
  return {
    ...(value.reference ? { reference: value.reference } : {}),
    ...(value.display ? { display: value.display } : {}),
  };
}

/** Vision insurance on the block (undefined → the block shows "Vision: none"). */
export function visionCoverageOf(appointment: Appointment): CoverageInput | undefined {
  return coverageOf(appointment, ODOS_VISION_COVERAGE_EXTENSION_URL);
}

/** Medical insurance on the block (undefined → the block shows "Medical: none"). */
export function medicalCoverageOf(appointment: Appointment): CoverageInput | undefined {
  return coverageOf(appointment, ODOS_MEDICAL_COVERAGE_EXTENSION_URL);
}

/** Urgent badge — iCal priority 1 is highest. */
export function isUrgentAppointment(appointment: Appointment): boolean {
  return appointment.priority === 1;
}

/** Follow-up badge. */
export function isFollowUpAppointment(appointment: Appointment): boolean {
  return (
    appointment.extension?.find((e) => e.url === ODOS_FOLLOW_UP_EXTENSION_URL)?.valueBoolean ===
    true
  );
}

/** The visit-type catalog code driving color + duration lookups. */
export function appointmentVisitTypeCode(appointment: Appointment): string | undefined {
  return appointment.serviceType
    ?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.system === ODOS_VISIT_TYPE_SYSTEM)?.code;
}
