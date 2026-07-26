import type { Appointment, HealthcareService, Resource, Schedule, Slot } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import {
  type CoverageInput,
  buildSchedulingAppointment,
} from "../fhir/schedulingAppointment.js";
import { isResourceVisibleInMode, resourceDisciplines } from "../fhir/schedulingResource.js";
import { parseRelativeFhirReference } from "../fhir/reference.js";
import {
  visitTypeCode,
  visitTypeDiscipline,
  visitTypeDurationMinutes,
  visitTypeEligibleResourceReferences,
} from "../fhir/schedulingVisitType.js";
import { type SlotGenerationInput, generateSlots } from "./availability.js";
import { type ClinicMode, assertClinicMode, isDisciplineVisible } from "./clinic-mode.js";

/**
 * The scheduling service layer — ALL scheduling logic lives here, with zero UI/layout coupling
 * (brief §5 data/view split): the traditional day-grid and the Pass-2 exploded front-desk view are
 * both renderers over this seam. Mirrors the payments-slice service idiom: a narrow Pick of the
 * plain-fetch FHIR client plus injected deps, so tests run against an in-memory fake and the
 * MCP/HTTP surface stays a thin adapter.
 *
 * Clinic mode is enforced at every operation — a single-discipline practice cannot list, see, or
 * book the other discipline (brief §1: modularity by construction, not a bolted-on toggle).
 */

export type SchedulingFhirClient = Pick<MedplumClient, "read" | "search" | "create">;

export interface SchedulingServiceDeps {
  fhir: SchedulingFhirClient;
  clinicMode: ClinicMode | string;
  /** Injected clock for created stamps (payments idiom); defaults to the wall clock. */
  now?: () => string;
}

export interface BookAppointmentInput {
  /** Absent for non-patient appointments (then description is required). */
  patient?: { reference: string; display?: string };
  description?: string;
  visitTypeCode: string;
  /** The resource column(s) to book ("Schedule/…"); at least one. */
  resourceScheduleReferences: string[];
  /** ISO dateTime with timezone offset. */
  start: string;
  /** Defaults to the catalog entry's duration. */
  durationMinutes?: number;
  status?: string;
  confirmation?: string;
  visionCoverage?: CoverageInput;
  medicalCoverage?: CoverageInput;
  notes?: string;
  urgent?: boolean;
  followUp?: boolean;
  /** Front-desk explicit overbook — skips the double-booking guard. */
  allowDoubleBook?: boolean;
}

export interface AvailabilityQuery extends Omit<SlotGenerationInput, "scheduleReference"> {
  scheduleReference: string;
}

export interface SchedulingService {
  clinicMode(): ClinicMode;
  /** The active visit-type catalog visible under the practice's clinic mode. */
  listVisitTypes(): Promise<HealthcareService[]>;
  /** The resource columns (provider/room/equipment Schedules) visible under the clinic mode. */
  listResources(): Promise<Schedule[]>;
  /** The slot grid for one resource: free / busy (booked) / busy-unavailable (blocked). */
  getAvailability(query: AvailabilityQuery): Promise<Slot[]>;
  /** Validate against catalog + mode + conflicts, then create the Appointment. */
  bookAppointment(input: BookAppointmentInput): Promise<Appointment>;
}

/** Appointment statuses that do not occupy the calendar. */
const NON_BLOCKING_STATUSES = new Set<Appointment["status"]>(["cancelled", "entered-in-error"]);

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function appointmentWindow(appointment: Appointment): { start: number; end: number } | undefined {
  if (!appointment.start || !appointment.end) {
    return undefined;
  }
  return { start: Date.parse(appointment.start), end: Date.parse(appointment.end) };
}

function appointmentActors(appointment: Appointment): string[] {
  return appointment.participant
    .map((p) => p.actor?.reference)
    .filter((reference): reference is string => Boolean(reference));
}

function isNotFound(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null && "status" in error && error.status === 404) ||
    (error instanceof Error && /not found|FHIR 404/i.test(error.message))
  );
}

export function createSchedulingService(deps: SchedulingServiceDeps): SchedulingService {
  assertClinicMode(deps.clinicMode);
  const mode = deps.clinicMode;
  const now = deps.now ?? (() => new Date().toISOString());

  async function searchAll<T extends HealthcareService | Schedule | Appointment>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<T[]> {
    const bundle = await deps.fhir.search<T>(resourceType, params);
    return (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((resource): resource is T => Boolean(resource));
  }

  async function readScheduleByReference(reference: string): Promise<Schedule> {
    const [resourceType, id] = reference.split("/");
    if (resourceType !== "Schedule" || !id) {
      throw new Error(`Resource reference must be a Schedule/… reference, got "${reference}".`);
    }
    return deps.fhir.read<Schedule>("Schedule", id);
  }

  async function blockingAppointmentsFor(actorReference: string): Promise<Appointment[]> {
    const appointments = await searchAll<Appointment>("Appointment", {
      actor: actorReference,
    });
    return appointments.filter(
      (appointment) =>
        !NON_BLOCKING_STATUSES.has(appointment.status) &&
        appointmentActors(appointment).includes(actorReference),
    );
  }

  async function scheduleActorResolves(schedule: Schedule): Promise<boolean> {
    const reference = schedule.actor?.[0]?.reference;
    const parsed = parseRelativeFhirReference(reference);
    if (!parsed || !["Practitioner", "Location", "Device"].includes(parsed.resourceType)) {
      return false;
    }
    try {
      await deps.fhir.read(parsed.resourceType as Resource["resourceType"], parsed.id);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  return {
    clinicMode() {
      return mode;
    },

    async listVisitTypes(): Promise<HealthcareService[]> {
      const catalog = await searchAll<HealthcareService>("HealthcareService");
      return catalog.filter((hs) => {
        if (hs.active === false || !visitTypeCode(hs)) {
          return false;
        }
        const discipline = visitTypeDiscipline(hs);
        return discipline !== undefined && isDisciplineVisible(discipline, mode);
      });
    },

    async listResources(): Promise<Schedule[]> {
      const schedules = await searchAll<Schedule>("Schedule");
      const candidates = schedules.filter(
        (schedule) =>
          schedule.active !== false &&
          resourceDisciplines(schedule).length > 0 &&
          isResourceVisibleInMode(schedule, mode),
      );
      const resolutions = await Promise.all(candidates.map(scheduleActorResolves));
      return candidates.filter((_, index) => resolutions[index]);
    },

    async getAvailability(query: AvailabilityQuery): Promise<Slot[]> {
      const schedule = await readScheduleByReference(query.scheduleReference);
      const actorReference = schedule.actor?.[0]?.reference;
      const slots = generateSlots(query);
      if (!actorReference) {
        return slots;
      }
      const booked = (await blockingAppointmentsFor(actorReference))
        .map(appointmentWindow)
        .filter((window): window is { start: number; end: number } => Boolean(window));
      if (booked.length === 0) {
        return slots;
      }
      return slots.map((slot) => {
        if (slot.status !== "free") {
          return slot;
        }
        const slotStart = Date.parse(slot.start);
        const slotEnd = Date.parse(slot.end);
        const isBooked = booked.some((w) => overlaps(slotStart, slotEnd, w.start, w.end));
        return isBooked ? { ...slot, status: "busy" as const } : slot;
      });
    },

    async bookAppointment(input: BookAppointmentInput): Promise<Appointment> {
      // 1. Resolve the visit type from the catalog (data, not code).
      const catalog = await searchAll<HealthcareService>("HealthcareService");
      const entry = catalog.find(
        (hs) => visitTypeCode(hs) === input.visitTypeCode && hs.active !== false,
      );
      if (!entry) {
        throw new Error(`Unknown visit type "${input.visitTypeCode}" — not in the active catalog.`);
      }
      const discipline = visitTypeDiscipline(entry);
      if (!discipline) {
        throw new Error(`Visit type "${input.visitTypeCode}" has no discipline category.`);
      }
      // 2. Modularity guard: the practice's clinic mode gates what is bookable (brief §1).
      if (!isDisciplineVisible(discipline, mode)) {
        throw new Error(
          `Visit type "${input.visitTypeCode}" is not available under this practice's clinic mode ("${mode}").`,
        );
      }
      const durationMinutes = input.durationMinutes ?? visitTypeDurationMinutes(entry);
      if (!durationMinutes) {
        throw new Error(
          `Visit type "${input.visitTypeCode}" has no duration and none was supplied.`,
        );
      }

      // 3. Resolve resource columns → actors, enforcing mode + eligibility.
      if (!input.resourceScheduleReferences || input.resourceScheduleReferences.length === 0) {
        throw new Error("Booking requires at least one resource (provider/room/equipment).");
      }
      const eligible = visitTypeEligibleResourceReferences(entry);
      const resources: { reference: string; display?: string }[] = [];
      for (const scheduleReference of input.resourceScheduleReferences) {
        const schedule = await readScheduleByReference(scheduleReference);
        if (!isResourceVisibleInMode(schedule, mode)) {
          throw new Error(
            `Resource ${scheduleReference} is not visible under this practice's clinic mode ("${mode}").`,
          );
        }
        const actor = schedule.actor?.[0];
        if (!actor?.reference || !(await scheduleActorResolves(schedule))) {
          throw new Error(`Resource ${scheduleReference} does not resolve to a bookable provider, room, or equipment actor.`);
        }
        if (eligible.length > 0 && !eligible.includes(actor.reference)) {
          throw new Error(
            `Resource ${actor.reference} is not eligible for visit type "${input.visitTypeCode}".`,
          );
        }
        resources.push({
          reference: actor.reference,
          ...(actor.display ? { display: actor.display } : {}),
        });
      }

      // 4. Build first (validates start format & patient/description rule), then conflict-check.
      const appointment = buildSchedulingAppointment({
        ...(input.patient ? { patient: input.patient } : {}),
        ...(input.description ? { description: input.description } : {}),
        visitTypeCode: input.visitTypeCode,
        ...(entry.name ? { visitTypeDisplay: entry.name } : {}),
        discipline,
        resources,
        start: input.start,
        durationMinutes,
        ...(input.status ? { status: input.status } : {}),
        ...(input.confirmation ? { confirmation: input.confirmation } : {}),
        ...(input.visionCoverage ? { visionCoverage: input.visionCoverage } : {}),
        ...(input.medicalCoverage ? { medicalCoverage: input.medicalCoverage } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.urgent ? { urgent: input.urgent } : {}),
        ...(input.followUp ? { followUp: input.followUp } : {}),
        created: now(),
      });

      if (!input.allowDoubleBook) {
        const newStart = Date.parse(appointment.start!);
        const newEnd = Date.parse(appointment.end!);
        for (const resource of resources) {
          const existing = await blockingAppointmentsFor(resource.reference);
          const conflict = existing.find((candidate) => {
            const window = appointmentWindow(candidate);
            return window && overlaps(newStart, newEnd, window.start, window.end);
          });
          if (conflict) {
            throw new Error(
              `Resource ${resource.reference} is already booked over ${input.start} ` +
                `(conflict with Appointment/${conflict.id ?? "?"}). Pass allowDoubleBook to overbook.`,
            );
          }
        }
      }

      return deps.fhir.create<Appointment>(appointment);
    },
  };
}
