import type { Schedule } from "@medplum/fhirtypes";
import {
  OSOD_DISCIPLINE_SYSTEM,
  type ClinicMode,
  type SchedulingDiscipline,
  assertDiscipline,
  disciplineCoding,
  disciplinesForMode,
} from "../scheduling/clinic-mode.js";

/**
 * Scheduler resources — the columns of the day grid. Provider / room / equipment are the three
 * parallel calendar types (AestheticsPro model, brief §3.3); each is one FHIR Schedule whose
 * `actor` is the concrete Practitioner / Location / Device. Discipline(s) ride in
 * `serviceCategory` so clinic-mode filtering (brief §1) works the same way as the visit-type
 * catalog. A resource may serve BOTH disciplines (a shared provider or treatment room) — one
 * Schedule, one column, multiple serviceCategory codings.
 */

export const RESOURCE_KINDS = [
  { code: "provider", display: "Provider", actorType: "Practitioner" },
  { code: "room", display: "Room", actorType: "Location" },
  { code: "equipment", display: "Equipment", actorType: "Device" },
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number]["code"];

const KIND_BY_CODE = new Map<string, (typeof RESOURCE_KINDS)[number]>(
  RESOURCE_KINDS.map((kind) => [kind.code, kind]),
);

const KIND_BY_ACTOR_TYPE = new Map<string, ResourceKind>(
  RESOURCE_KINDS.map((kind) => [kind.actorType, kind.code]),
);

export function assertResourceKind(code: string): asserts code is ResourceKind {
  if (!KIND_BY_CODE.has(code)) {
    throw new Error(
      `Unknown resource kind "${code}" — must be one of provider, room, or equipment.`,
    );
  }
}

export interface SchedulingResourceInput {
  kind: string;
  /** The actor reference — Practitioner/… for provider, Location/… for room, Device/… for equipment. */
  actorReference: string;
  /** Column header text (e.g. "Bang, Eric"). */
  actorDisplay?: string;
  /** The discipline(s) this resource serves; at least one. */
  disciplines: string[];
  comment?: string;
  active?: boolean;
}

/** Build the Schedule that makes a provider/room/equipment a bookable scheduler resource. */
export function buildSchedulingResource(input: SchedulingResourceInput): Schedule {
  assertResourceKind(input.kind);
  const kind = KIND_BY_CODE.get(input.kind)!;
  if (!input.actorReference.startsWith(`${kind.actorType}/`)) {
    throw new Error(
      `A ${kind.code} resource actor must be a ${kind.actorType} reference, got "${input.actorReference}".`,
    );
  }
  if (!input.disciplines || input.disciplines.length === 0) {
    throw new Error("A scheduling resource requires at least one discipline.");
  }
  for (const discipline of input.disciplines) {
    assertDiscipline(discipline);
  }

  return {
    resourceType: "Schedule",
    active: input.active ?? true,
    actor: [
      {
        reference: input.actorReference,
        ...(input.actorDisplay ? { display: input.actorDisplay } : {}),
      },
    ],
    serviceCategory: input.disciplines.map((discipline) => ({
      coding: [disciplineCoding(discipline)],
    })),
    ...(input.comment ? { comment: input.comment } : {}),
  };
}

/** The discipline(s) a resource serves, in the order they were configured. */
export function resourceDisciplines(schedule: Schedule): SchedulingDiscipline[] {
  return (schedule.serviceCategory ?? [])
    .flatMap((concept) => concept.coding ?? [])
    .filter((coding) => coding.system === OSOD_DISCIPLINE_SYSTEM)
    .map((coding) => coding.code as SchedulingDiscipline);
}

/** provider / room / equipment, derived from the actor reference type. */
export function resourceKind(schedule: Schedule): ResourceKind | undefined {
  const reference = schedule.actor?.[0]?.reference;
  const actorType = reference?.split("/")[0];
  return actorType ? KIND_BY_ACTOR_TYPE.get(actorType) : undefined;
}

/** Whether this resource appears as a column under a clinic mode (any-discipline match). */
export function isResourceVisibleInMode(schedule: Schedule, mode: ClinicMode | string): boolean {
  const visible = new Set<string>(disciplinesForMode(mode));
  return resourceDisciplines(schedule).some((discipline) => visible.has(discipline));
}
