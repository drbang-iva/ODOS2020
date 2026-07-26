import type { Appointment, Resource, Schedule } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";
import {
  parseRelativeFhirReference,
  type RelativeFhirReference,
} from "../fhir/reference.js";
import {
  buildSchedulingResource,
  resourceDisciplines,
  resourceKind,
  type SchedulingResourceInput,
} from "../fhir/schedulingResource.js";

const SCHEDULING_ACTOR_TYPES = new Set(["Practitioner", "Location", "Device"]);
const INTEGRITY_APPOINTMENT_MAX_ROWS = 100_000;
const FUTURE_APPOINTMENT_STATUSES = new Set<Appointment["status"]>([
  "proposed",
  "pending",
  "booked",
  "arrived",
  "checked-in",
  "waitlist",
]);

export type SchedulingResourceFhir = Pick<
  MedplumClient,
  "read" | "search" | "searchUrl" | "create" | "update"
>;

export interface SchedulingIntegrityIssue {
  sourceType: "Schedule" | "Appointment";
  sourceId?: string;
  display: string;
  actorDisplay?: string;
  problem: string;
}

export interface SchedulingResourceReadResult {
  resources: Schedule[];
  issues: SchedulingIntegrityIssue[];
}

export interface SchedulingResourceDeactivationResult {
  deactivated: boolean;
  futureAppointmentCount: number;
  schedule?: Schedule;
}

export class SchedulingResourceInputError extends Error {
  readonly status = 400;
}

export class SchedulingResourceNotFoundError extends Error {
  readonly status = 404;
}

export class SchedulingResourceConcurrentEditError extends Error {
  readonly status = 409;
}

export async function createSchedulingResource(
  fhir: SchedulingResourceFhir,
  input: SchedulingResourceInput,
): Promise<Schedule> {
  let schedule: Schedule;
  try {
    schedule = buildSchedulingResource(input);
  } catch (error) {
    throw new SchedulingResourceInputError(
      error instanceof Error ? error.message : "Schedule resource is invalid.",
    );
  }
  await assertScheduleActorExists(fhir, schedule);
  return fhir.create(schedule, { "X-ODOS-Source": "scheduler-resource-admin" });
}

export async function updateSchedulingResource(
  fhir: SchedulingResourceFhir,
  schedule: Schedule,
): Promise<Schedule> {
  if (!schedule.id) {
    throw new SchedulingResourceInputError("Schedule update requires an existing Schedule id.");
  }
  const existing = await fhir.read<Schedule>("Schedule", schedule.id);
  const kind = resourceKind(existing);
  if (!kind) {
    throw new SchedulingResourceInputError(
      "Existing Schedule must have a valid provider, room, or equipment actor.",
    );
  }
  try {
    buildSchedulingResource({
      kind,
      actorReference: schedule.actor?.[0]?.reference ?? "",
      ...(schedule.actor?.[0]?.display
        ? { actorDisplay: schedule.actor[0].display }
        : {}),
      disciplines: resourceDisciplines(schedule),
      ...(schedule.comment ? { comment: schedule.comment } : {}),
      ...(typeof schedule.active === "boolean" ? { active: schedule.active } : {}),
    });
  } catch (error) {
    throw new SchedulingResourceInputError(
      error instanceof Error ? error.message : "Schedule resource is invalid.",
    );
  }
  await assertScheduleActorExists(fhir, schedule);
  return persistSchedulingResourceUpdate(fhir, schedule);
}

async function persistSchedulingResourceUpdate(
  fhir: SchedulingResourceFhir,
  schedule: Schedule,
): Promise<Schedule> {
  if (!schedule.id) {
    throw new SchedulingResourceInputError("Schedule update requires an existing Schedule id.");
  }
  const versionId = schedule.meta?.versionId;
  if (!versionId) {
    throw new SchedulingResourceConcurrentEditError(
      "Schedule update requires its current FHIR version; reload and retry.",
    );
  }
  return fhir.update(
    "Schedule",
    schedule.id,
    schedule,
    { "If-Match": `W/"${versionId}"`, "X-ODOS-Source": "scheduler-resource-admin" },
  );
}

export async function listRenderableSchedulingResources(
  fhir: SchedulingResourceFhir,
): Promise<SchedulingResourceReadResult> {
  const schedules = await searchAll<Schedule>(fhir, "Schedule", { active: "true" });
  const resolutions = new Map<string, Promise<boolean>>();
  const resources: Schedule[] = [];
  const issues: SchedulingIntegrityIssue[] = [];
  for (const schedule of schedules) {
    const issue = await scheduleIntegrityIssue(fhir, schedule, resolutions);
    if (issue) {
      issues.push(issue);
    } else {
      resources.push(schedule);
    }
  }
  return { resources, issues };
}

export async function inspectSchedulingIntegrity(
  fhir: SchedulingResourceFhir,
): Promise<SchedulingIntegrityIssue[]> {
  const [schedules, appointments] = await Promise.all([
    searchAll<Schedule>(fhir, "Schedule"),
    searchAll<Appointment>(
      fhir,
      "Appointment",
      {},
      { maxRows: INTEGRITY_APPOINTMENT_MAX_ROWS },
    ),
  ]);
  const resolutions = new Map<string, Promise<boolean>>();
  const issues: SchedulingIntegrityIssue[] = [];
  for (const schedule of schedules) {
    const issue = await scheduleIntegrityIssue(fhir, schedule, resolutions);
    if (issue) issues.push(issue);
  }
  for (const appointment of appointments) {
    for (const participant of appointment.participant ?? []) {
      const actorReference = participant.actor?.reference;
      const parsed = parseRelativeFhirReference(actorReference);
      if (!parsed) {
        issues.push({
          sourceType: "Appointment",
          ...(appointment.id ? { sourceId: appointment.id } : {}),
          display: appointmentDisplay(appointment),
          ...(participant.actor?.display ? { actorDisplay: participant.actor.display } : {}),
          problem: "Participant is missing a valid Type/<id> actor link.",
        });
        continue;
      }
      if (!(await referenceResolves(fhir, parsed, resolutions))) {
        issues.push({
          sourceType: "Appointment",
          ...(appointment.id ? { sourceId: appointment.id } : {}),
          display: appointmentDisplay(appointment),
          ...(participant.actor?.display ? { actorDisplay: participant.actor.display } : {}),
          problem: `${parsed.resourceType} participant no longer resolves.`,
        });
      }
    }
  }
  return issues;
}

export async function deactivateSchedulingResource(
  fhir: SchedulingResourceFhir,
  scheduleId: string,
  input: { acknowledgeFutureAppointments: boolean; now?: string },
): Promise<SchedulingResourceDeactivationResult> {
  const parsedId = parseRelativeFhirReference(`Schedule/${scheduleId}`, "Schedule");
  if (!parsedId) {
    throw new SchedulingResourceInputError("Scheduler resource id must be a valid FHIR id.");
  }
  let schedule: Schedule;
  try {
    schedule = await fhir.read<Schedule>("Schedule", parsedId.id);
  } catch (error) {
    if (isNotFound(error)) {
      throw new SchedulingResourceNotFoundError("Scheduler resource was not found.");
    }
    throw error;
  }
  const actorReference = schedule.actor?.[0]?.reference;
  const now = input.now ?? new Date().toISOString();
  const appointments = await searchAll<Appointment>(fhir, "Appointment", { date: `ge${now}` });
  const futureAppointments = appointments.filter((appointment) =>
    Boolean(
      actorReference &&
      appointment.start &&
      Date.parse(appointment.start) >= Date.parse(now) &&
      FUTURE_APPOINTMENT_STATUSES.has(appointment.status) &&
      appointment.participant?.some((participant) => participant.actor?.reference === actorReference),
    ),
  );
  if (futureAppointments.length > 0 && !input.acknowledgeFutureAppointments) {
    return { deactivated: false, futureAppointmentCount: futureAppointments.length };
  }
  if (schedule.active === false) {
    return { deactivated: true, futureAppointmentCount: futureAppointments.length, schedule };
  }
  const updated = await persistSchedulingResourceUpdate(fhir, { ...schedule, active: false });
  return {
    deactivated: true,
    futureAppointmentCount: futureAppointments.length,
    schedule: updated,
  };
}

export function parseSchedulingResourceInput(body: unknown): SchedulingResourceInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SchedulingResourceInputError("Schedule resource body must be an object.");
  }
  const value = body as Record<string, unknown>;
  if (typeof value.kind !== "string" || typeof value.actorReference !== "string") {
    throw new SchedulingResourceInputError(
      "Schedule resource requires kind and actorReference strings.",
    );
  }
  if (!Array.isArray(value.disciplines) || !value.disciplines.every((entry) => typeof entry === "string")) {
    throw new SchedulingResourceInputError("Schedule resource disciplines must be a string array.");
  }
  return {
    kind: value.kind,
    actorReference: value.actorReference,
    disciplines: value.disciplines,
    ...(typeof value.actorDisplay === "string" ? { actorDisplay: value.actorDisplay } : {}),
    ...(typeof value.comment === "string" ? { comment: value.comment } : {}),
    ...(typeof value.active === "boolean" ? { active: value.active } : {}),
  };
}

async function assertScheduleActorExists(
  fhir: SchedulingResourceFhir,
  schedule: Schedule,
): Promise<void> {
  const parsed = scheduleActorReference(schedule);
  try {
    await fhir.read(parsed.resourceType as Resource["resourceType"], parsed.id);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    throw new SchedulingResourceInputError(
      `Schedule actor must reference an existing ${parsed.resourceType}.`,
    );
  }
}

function scheduleActorReference(schedule: Schedule): RelativeFhirReference {
  const reference = schedule.actor?.[0]?.reference;
  const parsed = parseRelativeFhirReference(reference);
  if (!parsed || !SCHEDULING_ACTOR_TYPES.has(parsed.resourceType)) {
    throw new SchedulingResourceInputError(
      "Schedule actor must be a valid Practitioner/<id>, Location/<id>, or Device/<id> reference.",
    );
  }
  return parsed;
}

async function scheduleIntegrityIssue(
  fhir: SchedulingResourceFhir,
  schedule: Schedule,
  resolutions: Map<string, Promise<boolean>>,
): Promise<SchedulingIntegrityIssue | undefined> {
  let parsed: RelativeFhirReference;
  try {
    parsed = scheduleActorReference(schedule);
  } catch {
    return {
      sourceType: "Schedule",
      ...(schedule.id ? { sourceId: schedule.id } : {}),
      display: scheduleDisplay(schedule),
      ...(schedule.actor?.[0]?.display ? { actorDisplay: schedule.actor[0].display } : {}),
      problem: "Resource is missing a valid provider, room, or equipment link.",
    };
  }
  if (await referenceResolves(fhir, parsed, resolutions)) return undefined;
  return {
    sourceType: "Schedule",
    ...(schedule.id ? { sourceId: schedule.id } : {}),
    display: scheduleDisplay(schedule),
    ...(schedule.actor?.[0]?.display ? { actorDisplay: schedule.actor[0].display } : {}),
    problem: `${parsed.resourceType} resource no longer resolves.`,
  };
}

function referenceResolves(
  fhir: SchedulingResourceFhir,
  parsed: RelativeFhirReference,
  resolutions: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const reference = `${parsed.resourceType}/${parsed.id}`;
  let resolution = resolutions.get(reference);
  if (!resolution) {
    resolution = fhir.read(parsed.resourceType as Resource["resourceType"], parsed.id)
      .then(() => true)
      .catch((error) => {
        if (isNotFound(error)) return false;
        throw error;
      });
    resolutions.set(reference, resolution);
  }
  return resolution;
}

function scheduleDisplay(schedule: Schedule): string {
  return schedule.actor?.[0]?.display?.trim() || schedule.comment?.trim() || "Scheduler resource";
}

function appointmentDisplay(appointment: Appointment): string {
  return appointment.description?.trim()
    || appointment.serviceType?.[0]?.text?.trim()
    || appointment.start
    || "Appointment";
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }
  return error.status === 404;
}
