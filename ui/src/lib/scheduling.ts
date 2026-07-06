import type { Appointment, Extension, HealthcareService, Reference, Schedule, Slot } from "@medplum/fhirtypes";

export const CLINIC_MODES = [
  { code: "eyecare", display: "Eyecare Only" },
  { code: "aesthetics", display: "Aesthetics Only" },
  { code: "both", display: "Eyecare + Aesthetics" },
] as const;

export type ClinicMode = (typeof CLINIC_MODES)[number]["code"];

export const SCHEDULING_DISCIPLINES = [
  { code: "eyecare", display: "Eyecare" },
  { code: "aesthetics", display: "Aesthetics" },
] as const;

export type SchedulingDiscipline = (typeof SCHEDULING_DISCIPLINES)[number]["code"];

export const OSOD_DISCIPLINE_SYSTEM = "https://osod.dev/fhir/CodeSystem/scheduling-discipline";
export const OSOD_VISIT_TYPE_SYSTEM = "https://osod.dev/fhir/CodeSystem/visit-type";
export const OSOD_VISIT_DURATION_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-visit-duration";
export const OSOD_DISPLAY_COLOR_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-display-color";
export const OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-eligible-resource";
export const OSOD_INTAKE_FORM_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-intake-form";

export const SCHEDULER_PALETTE = {
  surfaceBase: "#060610",
  mutedLine: "#666678",
  mutedLineLight: "#9999aa",
  lightSurface: "#ccccdd",
  lightSurfaceBright: "#eeeef2",
  newExamBlue: "#4a7dff",
  newExamBlueAlt: "#4488ff",
  establishedTeal: "#44ddaa",
  specialTestingPurple: "#cc88ff",
  officeVisitOrange: "#ff8844",
  officeVisitOrangeAlt: "#ff9944",
  nonPatientGold: "#ffcc44",
  urgentRed: "#ff5555",
  aestheticsCyan: "#22aabb",
  aestheticsRose: "#ee6699",
  aestheticsSky: "#66ccdd",
} as const;

export const DISCIPLINE_COLOR_BANDS: Record<SchedulingDiscipline, readonly string[]> = {
  eyecare: [
    SCHEDULER_PALETTE.newExamBlue,
    SCHEDULER_PALETTE.newExamBlueAlt,
    SCHEDULER_PALETTE.establishedTeal,
    SCHEDULER_PALETTE.specialTestingPurple,
    SCHEDULER_PALETTE.officeVisitOrange,
    SCHEDULER_PALETTE.officeVisitOrangeAlt,
    SCHEDULER_PALETTE.nonPatientGold,
    SCHEDULER_PALETTE.lightSurfaceBright,
  ],
  aesthetics: [
    SCHEDULER_PALETTE.aestheticsCyan,
    SCHEDULER_PALETTE.aestheticsRose,
    SCHEDULER_PALETTE.aestheticsSky,
  ],
};

export const RESOURCE_KINDS = [
  { code: "provider", display: "Provider", actorType: "Practitioner" },
  { code: "room", display: "Room", actorType: "Location" },
  { code: "equipment", display: "Equipment", actorType: "Device" },
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number]["code"];

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

export const V2_0276_APPOINTMENT_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v2-0276";

export const OSOD_APPOINTMENT_STATUSES = [
  { code: "scheduled", display: "Scheduled", fhirStatus: "booked" },
  { code: "checked-in", display: "Checked In", fhirStatus: "checked-in" },
  { code: "checked-out", display: "Checked Out", fhirStatus: "fulfilled" },
  { code: "no-show", display: "No Show", fhirStatus: "noshow" },
  { code: "walk-in", display: "Walk In", fhirStatus: "arrived", appointmentTypeCode: "WALKIN" },
  { code: "cancelled", display: "Cancelled", fhirStatus: "cancelled" },
] as const;

export type OsodAppointmentStatus = (typeof OSOD_APPOINTMENT_STATUSES)[number]["code"];

export const OSOD_VISION_COVERAGE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-vision-coverage";
export const OSOD_MEDICAL_COVERAGE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-medical-coverage";
export const OSOD_FOLLOW_UP_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-appointment-follow-up";

export const OSOD_BLOCKED_TIME_KIND_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-blocked-time-kind";
export const OSOD_BLOCKED_TIME_KIND_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/blocked-time-kind";

export const BLOCKED_TIME_KINDS = [
  { code: "office-closed", display: "Office Closed" },
  { code: "staff-off", display: "Staff Member Off" },
  { code: "custom", display: "Custom" },
] as const;

export type BlockedTimeKind = (typeof BLOCKED_TIME_KINDS)[number]["code"];
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface DayHours {
  start: string;
  end: string;
}

export type WeeklyHours = Partial<Record<Weekday, DayHours[]>>;

export interface BlockedTime {
  kind: BlockedTimeKind;
  description?: string;
  date?: string;
  weekdays?: Weekday[];
  start?: string;
  end?: string;
  scheduleReferences?: string[];
}

export interface SchedulingOffice {
  id: string;
  name: string;
}

export interface CoverageDisplay {
  reference?: string;
  display?: string;
}

export type CoverageInput = CoverageDisplay;

export interface SchedulingAppointmentInput {
  patient?: { reference: string; display?: string };
  description?: string;
  visitTypeCode: string;
  visitTypeDisplay?: string;
  discipline: string;
  resources: { reference: string; display?: string }[];
  start: string;
  durationMinutes: number;
  status?: string;
  confirmation?: string;
  visionCoverage?: CoverageInput;
  medicalCoverage?: CoverageInput;
  notes?: string;
  urgent?: boolean;
  followUp?: boolean;
  slotReferences?: string[];
  created?: string;
}

export interface BookSchedulingAppointmentInput {
  patient?: { reference: string; display?: string };
  description?: string;
  visitTypeCode: string;
  resourceScheduleReferences: string[];
  start: string;
  durationMinutes?: number;
  status?: OsodAppointmentStatus;
  confirmation?: AppointmentConfirmationStatus;
  visionCoverage?: CoverageInput;
  medicalCoverage?: CoverageInput;
  notes?: string;
  urgent?: boolean;
  followUp?: boolean;
  allowDoubleBook?: boolean;
  created?: string;
}

export interface ValidateSchedulingAppointmentInput {
  clinicMode: ClinicMode | string;
  visitTypes: HealthcareService[];
  resources: Schedule[];
  appointments: Appointment[];
  input: BookSchedulingAppointmentInput;
  now?: () => string;
  ignoreAppointmentId?: string;
}

export interface SchedulingPracticeConfig {
  timezoneOffset: string;
  defaultWeeklyHours: WeeklyHours;
  weeklyHoursBySchedule: Record<string, WeeklyHours>;
  blocks: BlockedTime[];
  offices: SchedulingOffice[];
  officeBySchedule: Record<string, string>;
}

export interface SchedulingOpening {
  start: string;
  scheduleReference: string;
  actorDisplay?: string;
}

export const FIND_OPEN_DEFAULT_LIMIT = 5;
export const FIND_OPEN_HORIZON_DAYS = 60;

export interface FindNextOpeningsInput {
  visitTypeCode: string;
  visitTypes: HealthcareService[];
  resources: Schedule[];
  config: SchedulingPracticeConfig;
  from: string;
  slotMinutes: number;
  limit: number;
  horizonDays?: number;
  now?: () => string;
  appointmentsByDay?: Record<string, Appointment[]> | Map<string, Appointment[]>;
  loadAppointmentsForDay?: (date: string, actorReferences?: string[]) => Promise<Appointment[]>;
}

export interface TimeAxisRow {
  startMinutes: number;
  endMinutes: number;
  label: string;
}

export interface TimeAxis {
  startMinutes: number;
  endMinutes: number;
  rows: TimeAxisRow[];
}

export interface AppointmentGeometry {
  columnIndex: number;
  rowStart: number;
  rowSpan: number;
}

export interface AvailabilityRegion {
  kind: "outside-hours" | "in-hours" | "blocked";
  startMinutes: number;
  endMinutes: number;
  rowStart: number;
  rowSpan: number;
  blockIndex?: number;
  blockedKind?: BlockedTimeKind;
  blockedKindDisplay?: string;
  description?: string;
}

export type AppointmentBlockBadgeCode = "urgent" | "follow-up" | "walk-in" | "non-patient";

export interface AppointmentBlockBadge {
  code: AppointmentBlockBadgeCode;
  display: string;
}

export interface AppointmentBlockContent {
  patientDisplay: string;
  visitTypeDisplay: string;
  visitTypeCode?: string;
  color: string;
  status?: OsodAppointmentStatus;
  statusDisplay: string;
  confirmation?: AppointmentConfirmationStatus;
  confirmationDisplay: string;
  insuranceLine: string;
  badges: AppointmentBlockBadge[];
  isNonPatient: boolean;
}

export const NON_BLOCKING_APPOINTMENT_STATUSES = ["cancelled", "entered-in-error"] as const satisfies readonly Appointment["status"][];

const MODE_BY_CODE = new Map<string, (typeof CLINIC_MODES)[number]>(
  CLINIC_MODES.map((mode) => [mode.code, mode]),
);
const DISCIPLINE_BY_CODE = new Map<string, (typeof SCHEDULING_DISCIPLINES)[number]>(
  SCHEDULING_DISCIPLINES.map((discipline) => [discipline.code, discipline]),
);
const KIND_BY_ACTOR_TYPE = new Map<string, ResourceKind>(
  RESOURCE_KINDS.map((kind) => [kind.actorType, kind.code]),
);
const CONFIRMATION_BY_CODE = new Map<
  string,
  (typeof APPOINTMENT_CONFIRMATION_STATUSES)[number]
>(APPOINTMENT_CONFIRMATION_STATUSES.map((status) => [status.code, status]));
const STATUS_BY_CODE = new Map<string, (typeof OSOD_APPOINTMENT_STATUSES)[number]>(
  OSOD_APPOINTMENT_STATUSES.map((status) => [status.code, status]),
);
const BLOCKED_KIND_BY_CODE = new Map<string, (typeof BLOCKED_TIME_KINDS)[number]>(
  BLOCKED_TIME_KINDS.map((kind) => [kind.code, kind]),
);
const NON_BLOCKING_STATUS_SET = new Set<Appointment["status"]>(NON_BLOCKING_APPOINTMENT_STATUSES);
const DEFAULT_COLOR_BY_DISCIPLINE: Record<SchedulingDiscipline, string> = {
  eyecare: SCHEDULER_PALETTE.newExamBlue,
  aesthetics: SCHEDULER_PALETTE.aestheticsCyan,
};
const WEEKDAY_BY_UTC_DAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

export function assertClinicMode(code: string): asserts code is ClinicMode {
  if (!MODE_BY_CODE.has(code)) {
    throw new Error(
      `Unknown clinic mode "${code}" — must be one of eyecare, aesthetics, or both (brief §1).`,
    );
  }
}

export function assertDiscipline(code: string): asserts code is SchedulingDiscipline {
  if (!DISCIPLINE_BY_CODE.has(code)) {
    throw new Error(
      `Unknown scheduling discipline "${code}" — must be eyecare or aesthetics.`,
    );
  }
}

export function assertConfirmationStatus(
  code: string,
): asserts code is AppointmentConfirmationStatus {
  if (!CONFIRMATION_BY_CODE.has(code)) {
    throw new Error(
      `Unknown confirmation status "${code}" — must be one of the four Eyefinity confirmation values.`,
    );
  }
}

export function assertOsodAppointmentStatus(
  code: string,
): asserts code is OsodAppointmentStatus {
  if (!STATUS_BY_CODE.has(code)) {
    throw new Error(
      `Unknown appointment status "${code}" — must be one of the six front-desk lifecycle values.`,
    );
  }
}

export function toFhirAppointmentStatus(code: string): {
  status: Appointment["status"];
  appointmentTypeCode?: string;
} {
  assertOsodAppointmentStatus(code);
  const status = STATUS_BY_CODE.get(code)!;
  return {
    status: status.fhirStatus,
    ...("appointmentTypeCode" in status ? { appointmentTypeCode: status.appointmentTypeCode } : {}),
  };
}

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
            system: OSOD_VISIT_TYPE_SYSTEM,
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
        ? [coverageExtension(OSOD_VISION_COVERAGE_EXTENSION_URL, input.visionCoverage)]
        : []),
      ...(input.medicalCoverage
        ? [coverageExtension(OSOD_MEDICAL_COVERAGE_EXTENSION_URL, input.medicalCoverage)]
        : []),
      ...(input.followUp ? [{ url: OSOD_FOLLOW_UP_EXTENSION_URL, valueBoolean: true }] : []),
    ],
  };
}

export function validateAndBuildSchedulingAppointment(
  deps: ValidateSchedulingAppointmentInput,
): Appointment {
  assertClinicMode(deps.clinicMode);
  const mode = deps.clinicMode;
  const input = deps.input;
  const entry = deps.visitTypes.find(
    (hs) => visitTypeCode(hs) === input.visitTypeCode && hs.active !== false,
  );
  if (!entry) {
    throw new Error(`Unknown visit type "${input.visitTypeCode}" — not in the active catalog.`);
  }
  const discipline = visitTypeDiscipline(entry);
  if (!discipline) {
    throw new Error(`Visit type "${input.visitTypeCode}" has no discipline category.`);
  }
  if (!isDisciplineVisible(discipline, mode)) {
    throw new Error(
      `Visit type "${input.visitTypeCode}" is not available under this practice's clinic mode ("${mode}").`,
    );
  }
  const durationMinutes = input.durationMinutes ?? visitTypeDurationMinutes(entry);
  if (!durationMinutes) {
    throw new Error(`Visit type "${input.visitTypeCode}" has no duration and none was supplied.`);
  }
  if (!input.resourceScheduleReferences || input.resourceScheduleReferences.length === 0) {
    throw new Error("Booking requires at least one resource (provider/room/equipment).");
  }

  const eligible = visitTypeEligibleResourceReferences(entry);
  const resolvedResources: { reference: string; display?: string }[] = [];
  for (const reference of input.resourceScheduleReferences) {
    const schedule = deps.resources.find((resource) => scheduleReference(resource) === reference);
    if (!schedule) {
      throw new Error(`${reference} not found in the loaded scheduler resources.`);
    }
    if (!isResourceVisibleInMode(schedule, mode)) {
      throw new Error(
        `Resource ${reference} is not visible under this practice's clinic mode ("${mode}").`,
      );
    }
    const actor = schedule.actor?.[0];
    if (!actor?.reference) {
      throw new Error(`Resource ${reference} has no actor reference.`);
    }
    if (eligible.length > 0 && !eligible.includes(actor.reference)) {
      throw new Error(
        `Resource ${actor.reference} is not eligible for visit type "${input.visitTypeCode}".`,
      );
    }
    resolvedResources.push({
      reference: actor.reference,
      ...(actor.display ? { display: actor.display } : {}),
    });
  }

  const appointment = buildSchedulingAppointment({
    ...(input.patient ? { patient: input.patient } : {}),
    ...(input.description ? { description: input.description } : {}),
    visitTypeCode: input.visitTypeCode,
    ...(entry.name ? { visitTypeDisplay: entry.name } : {}),
    discipline,
    resources: resolvedResources,
    start: input.start,
    durationMinutes,
    ...(input.status ? { status: input.status } : {}),
    ...(input.confirmation ? { confirmation: input.confirmation } : {}),
    ...(input.visionCoverage ? { visionCoverage: input.visionCoverage } : {}),
    ...(input.medicalCoverage ? { medicalCoverage: input.medicalCoverage } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.urgent ? { urgent: input.urgent } : {}),
    ...(input.followUp ? { followUp: input.followUp } : {}),
    created: input.created ?? deps.now?.() ?? new Date().toISOString(),
  });

  if (!input.allowDoubleBook && !NON_BLOCKING_STATUS_SET.has(appointment.status)) {
    const newStart = Date.parse(appointment.start!);
    const newEnd = Date.parse(appointment.end!);
    for (const resource of resolvedResources) {
      const conflict = deps.appointments.find((candidate) => {
        if (candidate.id && candidate.id === deps.ignoreAppointmentId) {
          return false;
        }
        if (NON_BLOCKING_STATUS_SET.has(candidate.status)) {
          return false;
        }
        if (!appointmentActorReferences(candidate).includes(resource.reference)) {
          return false;
        }
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

  return appointment;
}

export function disciplinesForMode(mode: string): SchedulingDiscipline[] {
  assertClinicMode(mode);
  return mode === "both" ? SCHEDULING_DISCIPLINES.map((discipline) => discipline.code) : [mode];
}

export function isDisciplineVisible(discipline: string, mode: string): boolean {
  assertDiscipline(discipline);
  return disciplinesForMode(mode).includes(discipline);
}

export function visitTypeCode(hs: HealthcareService): string | undefined {
  return hs.type?.[0]?.coding?.find((coding) => coding.system === OSOD_VISIT_TYPE_SYSTEM)?.code;
}

export function visitTypeDiscipline(hs: HealthcareService): SchedulingDiscipline | undefined {
  const code = hs.category
    ?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.system === OSOD_DISCIPLINE_SYSTEM)?.code;
  return code as SchedulingDiscipline | undefined;
}

export function visitTypeDurationMinutes(hs: HealthcareService): number | undefined {
  return hs.extension?.find((extension) => extension.url === OSOD_VISIT_DURATION_EXTENSION_URL)
    ?.valuePositiveInt;
}

export function visitTypeColor(hs: HealthcareService): string | undefined {
  return hs.extension?.find((extension) => extension.url === OSOD_DISPLAY_COLOR_EXTENSION_URL)
    ?.valueString;
}

export function visitTypeEligibleResourceReferences(hs: HealthcareService): string[] {
  return (hs.extension ?? [])
    .filter((extension) => extension.url === OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL)
    .map((extension) => extension.valueReference?.reference)
    .filter((reference): reference is string => Boolean(reference));
}

export function resourceDisciplines(schedule: Schedule): SchedulingDiscipline[] {
  return (schedule.serviceCategory ?? [])
    .flatMap((concept) => concept.coding ?? [])
    .filter((coding) => coding.system === OSOD_DISCIPLINE_SYSTEM)
    .map((coding) => coding.code as SchedulingDiscipline);
}

export function resourceKind(schedule: Schedule): ResourceKind | undefined {
  const actorType = schedule.actor?.[0]?.reference?.split("/")[0];
  return actorType ? KIND_BY_ACTOR_TYPE.get(actorType) : undefined;
}

export function isResourceVisibleInMode(schedule: Schedule, mode: ClinicMode | string): boolean {
  const visible = new Set<string>(disciplinesForMode(mode));
  return resourceDisciplines(schedule).some((discipline) => visible.has(discipline));
}

export function confirmationStatusOf(
  appointment: Appointment,
): AppointmentConfirmationStatus | undefined {
  const coding = appointment.extension
    ?.find((extension) => extension.url === OSOD_APPOINTMENT_CONFIRMATION_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.find(
      (candidate) => candidate.system === OSOD_APPOINTMENT_CONFIRMATION_SYSTEM,
    );
  return coding?.code as AppointmentConfirmationStatus | undefined;
}

export function osodAppointmentStatusOf(appointment: {
  status: Appointment["status"];
  appointmentType?: Appointment["appointmentType"];
}): OsodAppointmentStatus | undefined {
  if (appointment.status === "arrived") {
    const isWalkIn = appointment.appointmentType?.coding?.some(
      (coding) => coding.system === V2_0276_APPOINTMENT_TYPE_SYSTEM && coding.code === "WALKIN",
    );
    return isWalkIn ? "walk-in" : "checked-in";
  }
  const match = OSOD_APPOINTMENT_STATUSES.find(
    (status) => status.fhirStatus === appointment.status && !("appointmentTypeCode" in status),
  );
  return match?.code;
}

export function appointmentVisitTypeCode(appointment: Appointment): string | undefined {
  return appointment.serviceType
    ?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.system === OSOD_VISIT_TYPE_SYSTEM)?.code;
}

export function visionCoverageOf(appointment: Appointment): CoverageDisplay | undefined {
  return coverageOf(appointment, OSOD_VISION_COVERAGE_EXTENSION_URL);
}

export function medicalCoverageOf(appointment: Appointment): CoverageDisplay | undefined {
  return coverageOf(appointment, OSOD_MEDICAL_COVERAGE_EXTENSION_URL);
}

export function isUrgentAppointment(appointment: Appointment): boolean {
  return appointment.priority === 1;
}

export function isFollowUpAppointment(appointment: Appointment): boolean {
  return (
    appointment.extension?.find((extension) => extension.url === OSOD_FOLLOW_UP_EXTENSION_URL)
      ?.valueBoolean === true
  );
}

export function blockedTimeKindOf(slot: Slot): BlockedTimeKind | undefined {
  const coding = slot.extension
    ?.find((extension) => extension.url === OSOD_BLOCKED_TIME_KIND_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.find(
      (candidate) => candidate.system === OSOD_BLOCKED_TIME_KIND_SYSTEM,
    );
  return coding?.code as BlockedTimeKind | undefined;
}

export function visibleSchedulingResources(resources: Schedule[], mode: ClinicMode | string): Schedule[] {
  return resources.filter(
    (schedule) =>
      schedule.active !== false &&
      resourceDisciplines(schedule).length > 0 &&
      isResourceVisibleInMode(schedule, mode),
  );
}

export function visibleSchedulingResourcesForOffice(
  resources: Schedule[],
  mode: ClinicMode | string,
  config: SchedulingPracticeConfig,
  officeId: string | "all",
): Schedule[] {
  const visible = visibleSchedulingResources(resources, mode);
  if (officeId === "all") {
    return visible;
  }
  return visible.filter((resource) => {
    const reference = scheduleReference(resource);
    const assignedOffice = reference ? config.officeBySchedule[reference] : undefined;
    // Unassigned resources remain visible in every office until the practice assigns them.
    return assignedOffice === undefined || assignedOffice === officeId;
  });
}

export function visibleSchedulingVisitTypes(
  visitTypes: HealthcareService[],
  mode: ClinicMode | string,
): HealthcareService[] {
  return visitTypes.filter((visitType) => {
    if (visitType.active === false || !visitTypeCode(visitType)) {
      return false;
    }
    const discipline = visitTypeDiscipline(visitType);
    return discipline !== undefined && isDisciplineVisible(discipline, mode);
  });
}

export function visibleAppointmentsForMode(
  appointments: Appointment[],
  mode: ClinicMode | string,
): Appointment[] {
  return appointments.filter((appointment) => {
    if (NON_BLOCKING_STATUS_SET.has(appointment.status)) {
      return false;
    }
    const discipline = appointmentDiscipline(appointment);
    return discipline === undefined || isDisciplineVisible(discipline, mode);
  });
}

export async function findNextOpenings(input: FindNextOpeningsInput): Promise<SchedulingOpening[]> {
  if (!Number.isInteger(input.slotMinutes) || input.slotMinutes <= 0) {
    throw new Error("Slot granularity (slotMinutes) must be a positive integer.");
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    return [];
  }
  const visitType = input.visitTypes.find(
    (candidate) => candidate.active !== false && visitTypeCode(candidate) === input.visitTypeCode,
  );
  if (!visitType) {
    throw new Error(`Unknown visit type "${input.visitTypeCode}" — not in the active catalog.`);
  }
  const durationMinutes = visitTypeDurationMinutes(visitType);
  if (!durationMinutes) {
    throw new Error(`Visit type "${input.visitTypeCode}" has no duration and none was supplied.`);
  }
  const eligible = new Set(visitTypeEligibleResourceReferences(visitType));
  const candidateResources = input.resources
    .map((resource, resourceIndex) => ({
      resource,
      resourceIndex,
      scheduleReference: scheduleReference(resource),
      actorReference: resourceActorReference(resource),
      actorDisplay: resourceDisplay(resource),
    }))
    .filter(
      (entry): entry is {
        resource: Schedule;
        resourceIndex: number;
        scheduleReference: string;
        actorReference: string;
        actorDisplay: string;
      } =>
        Boolean(entry.scheduleReference) &&
        Boolean(entry.actorReference) &&
        (eligible.size === 0 || eligible.has(entry.actorReference!)),
    );
  if (candidateResources.length === 0) {
    return [];
  }

  const searchStart = openingSearchStart(input);
  const fromDate = searchStart.date;
  const fromMinutes = searchStart.minutes;
  const horizonDays = input.horizonDays ?? FIND_OPEN_HORIZON_DAYS;
  const openings: SchedulingOpening[] = [];

  for (let dayOffset = 0; dayOffset < horizonDays && openings.length < input.limit; dayOffset += 1) {
    const date = addDaysYmd(fromDate, dayOffset);
    const earliestStart = dayOffset === 0 ? alignToSlot(fromMinutes, input.slotMinutes) : 0;
    const potentialCandidates: Array<
      SchedulingOpening & { actorReference: string; startMinutes: number; endMinutes: number; resourceIndex: number }
    > = [];

    for (const entry of candidateResources) {
      const regions = availabilityShadingForColumn({
        date,
        axisStartMinutes: 0,
        axisEndMinutes: 24 * 60,
        slotMinutes: input.slotMinutes,
        weeklyHours: weeklyHoursForSchedule(input.config, entry.resource),
        blocks: blocksForSchedule(input.config, entry.resource),
      });
      const blocked = regions.filter((region) => region.kind === "blocked");
      for (const hours of regions.filter((region) => region.kind === "in-hours")) {
        for (
          let at = Math.max(hours.startMinutes, earliestStart);
          at + durationMinutes <= hours.endMinutes;
          at += input.slotMinutes
        ) {
          const end = at + durationMinutes;
          if (blocked.some((region) => overlaps(at, end, region.startMinutes, region.endMinutes))) {
            continue;
          }
          potentialCandidates.push({
            start: isoFromDateAndMinutes(date, at, input.config.timezoneOffset),
            scheduleReference: entry.scheduleReference,
            actorDisplay: entry.actorDisplay,
            actorReference: entry.actorReference,
            startMinutes: at,
            endMinutes: end,
            resourceIndex: entry.resourceIndex,
          });
        }
      }
    }

    if (potentialCandidates.length === 0) {
      continue;
    }
    const actorReferences = [...new Set(potentialCandidates.map((candidate) => candidate.actorReference))];
    const appointments = await appointmentsForOpeningDate(input, date, actorReferences);
    const appointmentsByActor = appointmentWindowsByActor(appointments);
    const seen = new Set<string>();
    const dayCandidates: Array<SchedulingOpening & { startMinutes: number; resourceIndex: number }> = [];
    for (const candidate of potentialCandidates) {
      const key = `${candidate.scheduleReference}|${candidate.start}`;
      if (seen.has(key)) {
        continue;
      }
      const startMs = Date.parse(candidate.start);
      const endMs = Date.parse(isoFromDateAndMinutes(date, candidate.endMinutes, input.config.timezoneOffset));
      const conflicts = appointmentsByActor
        .get(candidate.actorReference)
        ?.some((window) => overlaps(startMs, endMs, window.startMs, window.endMs));
      if (conflicts) {
        continue;
      }
      seen.add(key);
      dayCandidates.push({
        start: candidate.start,
        scheduleReference: candidate.scheduleReference,
        actorDisplay: candidate.actorDisplay,
        startMinutes: candidate.startMinutes,
        resourceIndex: candidate.resourceIndex,
      });
    }

    dayCandidates.sort((a, b) => a.startMinutes - b.startMinutes || a.resourceIndex - b.resourceIndex);
    for (const candidate of dayCandidates) {
      openings.push({
        start: candidate.start,
        scheduleReference: candidate.scheduleReference,
        actorDisplay: candidate.actorDisplay,
      });
      if (openings.length >= input.limit) {
        break;
      }
    }
  }

  return openings;
}

export function findOpenSearchScopeKey(input: {
  clinicMode: ClinicMode;
  resources: Schedule[];
}): string {
  return [
    input.clinicMode,
    ...input.resources.map((resource) => scheduleReference(resource) ?? resource.actor?.[0]?.reference ?? ""),
  ].join("|");
}

export function scheduleReference(schedule: Schedule): string | undefined {
  return schedule.id ? `Schedule/${schedule.id}` : undefined;
}

export function resourceActorReference(schedule: Schedule): string | undefined {
  return schedule.actor?.[0]?.reference;
}

export function resourceDisplay(schedule: Schedule): string {
  return schedule.actor?.[0]?.display ?? schedule.actor?.[0]?.reference ?? schedule.comment ?? "Unassigned";
}

export function scheduleReferenceForActor(
  resources: Schedule[],
  actorReference: string,
): string | undefined {
  const schedule = resources.find((resource) => resourceActorReference(resource) === actorReference);
  return schedule ? scheduleReference(schedule) : undefined;
}

export function weeklyHoursForSchedule(
  config: SchedulingPracticeConfig,
  schedule: Schedule,
): WeeklyHours {
  const reference = scheduleReference(schedule);
  return reference ? config.weeklyHoursBySchedule[reference] ?? config.defaultWeeklyHours : config.defaultWeeklyHours;
}

export function blocksForSchedule(
  config: SchedulingPracticeConfig,
  schedule: Schedule,
): BlockedTime[] {
  return blocksForScheduleWithIndex(config, schedule).map((entry) => entry.block);
}

export function blocksForScheduleWithIndex(
  config: SchedulingPracticeConfig,
  schedule: Schedule,
): Array<{ block: BlockedTime; blockIndex: number }> {
  const reference = scheduleReference(schedule);
  return config.blocks
    .map((block, blockIndex) => ({ block, blockIndex }))
    .filter(
      ({ block }) =>
      !block.scheduleReferences ||
      block.scheduleReferences.length === 0 ||
      (reference !== undefined && block.scheduleReferences.includes(reference)),
    );
}

export function buildTimeAxis(input: {
  date: string;
  resources: Schedule[];
  config: SchedulingPracticeConfig;
  slotMinutes: number;
}): TimeAxis {
  const windows = input.resources.flatMap((resource) =>
    windowsForDate(input.date, weeklyHoursForSchedule(input.config, resource)),
  );
  if (windows.length === 0) {
    return { startMinutes: 0, endMinutes: 0, rows: [] };
  }
  const startMinutes = Math.floor(Math.min(...windows.map((window) => window.startMinutes)) / 60) * 60;
  const endMinutes = Math.ceil(Math.max(...windows.map((window) => window.endMinutes)) / 60) * 60;
  const rows: TimeAxisRow[] = [];
  for (let at = startMinutes; at < endMinutes; at += input.slotMinutes) {
    rows.push({
      startMinutes: at,
      endMinutes: Math.min(at + input.slotMinutes, endMinutes),
      label: formatTimeLabel(at),
    });
  }
  return { startMinutes, endMinutes, rows };
}

export function appointmentGeometry(input: {
  appointment: Appointment;
  resources: Schedule[];
  axisStartMinutes: number;
  slotMinutes: number;
  timezoneOffset: string;
}): AppointmentGeometry[] {
  if (!input.appointment.start) {
    return [];
  }
  const actorReferences = appointmentActorReferences(input.appointment);
  const columnIndexes = input.resources.flatMap((resource, columnIndex) => {
    const actorReference = resourceActorReference(resource);
    return actorReference && actorReferences.includes(actorReference) ? [columnIndex] : [];
  });
  if (columnIndexes.length === 0) {
    return [];
  }
  const startMinutes = minutesFromIsoDateTime(input.appointment.start, input.timezoneOffset);
  const durationMinutes = appointmentDurationMinutes(input.appointment);
  if (!durationMinutes) {
    return [];
  }
  return columnIndexes.map((columnIndex) => ({
    columnIndex,
    rowStart: (startMinutes - input.axisStartMinutes) / input.slotMinutes,
    rowSpan: Math.max(durationMinutes / input.slotMinutes, 1),
  }));
}

export function availabilityShadingForColumn(input: {
  date: string;
  axisStartMinutes: number;
  axisEndMinutes: number;
  slotMinutes: number;
  weeklyHours: WeeklyHours;
  blocks: BlockedTime[];
  blockIndexes?: number[];
}): AvailabilityRegion[] {
  if (input.axisEndMinutes <= input.axisStartMinutes) {
    return [];
  }
  const regions: AvailabilityRegion[] = [];
  const windows = windowsForDate(input.date, input.weeklyHours)
    .map((window) => clampWindow(window, input.axisStartMinutes, input.axisEndMinutes))
    .filter((window): window is MinutesWindow => Boolean(window))
    .sort((a, b) => a.startMinutes - b.startMinutes);

  let cursor = input.axisStartMinutes;
  for (const window of windows) {
    if (cursor < window.startMinutes) {
      regions.push(region("outside-hours", cursor, window.startMinutes, input));
    }
    regions.push(region("in-hours", window.startMinutes, window.endMinutes, input));
    cursor = Math.max(cursor, window.endMinutes);
  }
  if (cursor < input.axisEndMinutes) {
    regions.push(region("outside-hours", cursor, input.axisEndMinutes, input));
  }

  const weekday = weekdayOfDate(input.date);
  const blocked: AvailabilityRegion[] = [];
  input.blocks.forEach((block, index) => {
    if (!blockAppliesToDate(block, input.date, weekday)) {
      return;
    }
    const startMinutes = block.start ? minutesOfDay(block.start, "Blocked-time start") : 0;
    const endMinutes = block.end ? minutesOfDay(block.end, "Blocked-time end") : 24 * 60;
    const clamped = clampWindow({ startMinutes, endMinutes }, input.axisStartMinutes, input.axisEndMinutes);
    if (!clamped) {
      return;
    }
    blocked.push({
      ...region("blocked", clamped.startMinutes, clamped.endMinutes, input),
      blockIndex: input.blockIndexes?.[index] ?? index,
      blockedKind: block.kind,
      blockedKindDisplay: BLOCKED_KIND_BY_CODE.get(block.kind)?.display,
      ...(block.description ? { description: block.description } : {}),
    });
  });

  return [...regions, ...blocked];
}

export function buildAppointmentBlockContent(
  appointment: Appointment,
  visitTypes: HealthcareService[],
): AppointmentBlockContent {
  const patient = patientParticipant(appointment);
  const isNonPatient = !patient;
  const code = appointmentVisitTypeCode(appointment);
  const visitType = code ? visitTypes.find((candidate) => visitTypeCode(candidate) === code) : undefined;
  const discipline = (visitType && visitTypeDiscipline(visitType)) ?? appointmentDiscipline(appointment);
  const status = osodAppointmentStatusOf(appointment);
  const confirmation = confirmationStatusOf(appointment) ?? "not-confirmed";
  const badges = appointmentBadges(appointment, isNonPatient, status);

  return {
    patientDisplay: patient?.actor?.display ?? appointment.description ?? "Non-patient",
    visitTypeDisplay: visitTypeDisplay(appointment, visitType, code),
    ...(code ? { visitTypeCode: code } : {}),
    color: isNonPatient ? SCHEDULER_PALETTE.nonPatientGold : visitTypeDisplayColor(visitType, discipline),
    ...(status ? { status } : {}),
    statusDisplay: status ? STATUS_BY_CODE.get(status)?.display ?? status : "Unknown",
    confirmation,
    confirmationDisplay: CONFIRMATION_BY_CODE.get(confirmation)?.display ?? confirmation,
    insuranceLine: insuranceLine(appointment),
    badges,
    isNonPatient,
  };
}

export function visitTypeDisplayColor(
  visitType: HealthcareService | undefined,
  discipline?: SchedulingDiscipline,
): string {
  const resolvedDiscipline = discipline ?? (visitType ? visitTypeDiscipline(visitType) : undefined);
  return (
    (visitType ? visitTypeColor(visitType) : undefined) ??
    (resolvedDiscipline ? DEFAULT_COLOR_BY_DISCIPLINE[resolvedDiscipline] : SCHEDULER_PALETTE.newExamBlue)
  );
}

function coverageOf(appointment: Appointment, url: string): CoverageDisplay | undefined {
  const value = appointment.extension?.find((extension) => extension.url === url)?.valueReference;
  if (!value) {
    return undefined;
  }
  return {
    ...(value.reference ? { reference: value.reference } : {}),
    ...(value.display ? { display: value.display } : {}),
  };
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

function disciplineCoding(discipline: string) {
  assertDiscipline(discipline);
  return {
    system: OSOD_DISCIPLINE_SYSTEM,
    code: discipline,
    display: DISCIPLINE_BY_CODE.get(discipline)?.display,
  };
}

interface MinutesWindow {
  startMinutes: number;
  endMinutes: number;
}

function windowsForDate(date: string, weeklyHours: WeeklyHours): MinutesWindow[] {
  const weekday = weekdayOfDate(date);
  return (weeklyHours[weekday] ?? []).map((hours) => ({
    startMinutes: minutesOfDay(hours.start, "Operating-hours start"),
    endMinutes: minutesOfDay(hours.end, "Operating-hours end"),
  }));
}

export function weekdayOfDate(date: string): Weekday {
  return WEEKDAY_BY_UTC_DAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

export function minutesOfDay(time: string, context: string): number {
  const match = TIME_HHMM.exec(time);
  if (!match) {
    throw new Error(`${context} must be an HH:MM 24-hour time, got "${time}".`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesFromIsoDateTime(dateTime: string, timezoneOffset: string): number {
  const timestamp = Date.parse(dateTime);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Expected an ISO dateTime, got "${dateTime}".`);
  }
  const local = new Date(timestamp + timezoneOffsetMinutes(timezoneOffset) * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

export function ymdFromIsoDateTime(dateTime: string, timezoneOffset: string): string {
  const timestamp = Date.parse(dateTime);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Expected an ISO dateTime, got "${dateTime}".`);
  }
  return new Date(timestamp + timezoneOffsetMinutes(timezoneOffset) * 60_000)
    .toISOString()
    .slice(0, 10);
}

export function addDaysYmd(date: string, days: number): string {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

export function isoFromDateAndMinutes(date: string, minutes: number, timezoneOffset: string): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${timezoneOffset}`;
}

export function appointmentDayBoundsParams(date: string, timezoneOffset: string): URLSearchParams {
  return new URLSearchParams([
    ["date", `ge${date}T00:00:00${timezoneOffset}`],
    ["date", `lt${addDaysYmd(date, 1)}T00:00:00${timezoneOffset}`],
  ]);
}

function alignToSlot(minutes: number, slotMinutes: number): number {
  return Math.ceil(minutes / slotMinutes) * slotMinutes;
}

async function appointmentsForOpeningDate(
  input: FindNextOpeningsInput,
  date: string,
  actorReferences: string[],
): Promise<Appointment[]> {
  if (input.appointmentsByDay instanceof Map) {
    return input.appointmentsByDay.get(date) ?? [];
  }
  if (input.appointmentsByDay) {
    return input.appointmentsByDay[date] ?? [];
  }
  if (input.loadAppointmentsForDay) {
    return input.loadAppointmentsForDay(date, actorReferences);
  }
  return [];
}

function appointmentWindowsByActor(appointments: Appointment[]): Map<string, Array<{ startMs: number; endMs: number }>> {
  const byActor = new Map<string, Array<{ startMs: number; endMs: number }>>();
  for (const appointment of appointments) {
    if (NON_BLOCKING_STATUS_SET.has(appointment.status) || !appointment.start || !appointment.end) {
      continue;
    }
    const startMs = Date.parse(appointment.start);
    const endMs = Date.parse(appointment.end);
    for (const actorReference of appointmentActorReferences(appointment)) {
      const windows = byActor.get(actorReference) ?? [];
      windows.push({ startMs, endMs });
      byActor.set(actorReference, windows);
    }
  }
  return byActor;
}

function openingSearchStart(input: FindNextOpeningsInput): { date: string; minutes: number } {
  const fromDate = ymdFromIsoDateTime(input.from, input.config.timezoneOffset);
  const fromMinutes = minutesFromIsoDateTime(input.from, input.config.timezoneOffset);
  const nowIso = input.now?.();
  if (!nowIso) {
    return { date: fromDate, minutes: fromMinutes };
  }
  const nowDate = ymdFromIsoDateTime(nowIso, input.config.timezoneOffset);
  const nowMinutes = alignToSlot(minutesFromIsoDateTime(nowIso, input.config.timezoneOffset), input.slotMinutes);
  if (fromDate < nowDate) {
    return { date: nowDate, minutes: nowMinutes };
  }
  if (fromDate === nowDate) {
    return { date: fromDate, minutes: Math.max(fromMinutes, nowMinutes) };
  }
  return { date: fromDate, minutes: fromMinutes };
}

export function timezoneOffsetMinutes(timezoneOffset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezoneOffset);
  if (!match) {
    throw new Error(`Timezone offset must be ±HH:MM, got "${timezoneOffset}".`);
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function formatTimeLabel(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function clampWindow(
  window: MinutesWindow,
  axisStartMinutes: number,
  axisEndMinutes: number,
): MinutesWindow | undefined {
  const startMinutes = Math.max(window.startMinutes, axisStartMinutes);
  const endMinutes = Math.min(window.endMinutes, axisEndMinutes);
  return startMinutes < endMinutes ? { startMinutes, endMinutes } : undefined;
}

function region(
  kind: AvailabilityRegion["kind"],
  startMinutes: number,
  endMinutes: number,
  input: { axisStartMinutes: number; slotMinutes: number },
): AvailabilityRegion {
  return {
    kind,
    startMinutes,
    endMinutes,
    rowStart: (startMinutes - input.axisStartMinutes) / input.slotMinutes,
    rowSpan: (endMinutes - startMinutes) / input.slotMinutes,
  };
}

function blockAppliesToDate(block: BlockedTime, date: string, weekday: Weekday): boolean {
  return block.date === date || (block.weekdays?.includes(weekday) ?? false);
}

export function appointmentActorReferences(appointment: Appointment): string[] {
  return appointment.participant
    .map((participant) => participant.actor?.reference)
    .filter((reference): reference is string => Boolean(reference));
}

export function isNonBlockingAppointmentStatus(status: Appointment["status"]): boolean {
  return NON_BLOCKING_STATUS_SET.has(status);
}

export function appointmentDurationMinutes(appointment: Appointment): number | undefined {
  if (typeof appointment.minutesDuration === "number" && appointment.minutesDuration > 0) {
    return appointment.minutesDuration;
  }
  if (appointment.start && appointment.end) {
    const duration = Math.round((Date.parse(appointment.end) - Date.parse(appointment.start)) / 60_000);
    return duration > 0 ? duration : undefined;
  }
  return undefined;
}

function appointmentWindow(appointment: Appointment): { start: number; end: number } | undefined {
  if (!appointment.start || !appointment.end) {
    return undefined;
  }
  return { start: Date.parse(appointment.start), end: Date.parse(appointment.end) };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function patientParticipant(appointment: Appointment) {
  return appointment.participant.find((participant) => participant.actor?.reference?.startsWith("Patient/"));
}

function appointmentDiscipline(appointment: Appointment): SchedulingDiscipline | undefined {
  const code = appointment.serviceCategory
    ?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.system === OSOD_DISCIPLINE_SYSTEM)?.code;
  return code as SchedulingDiscipline | undefined;
}

function visitTypeDisplay(
  appointment: Appointment,
  visitType: HealthcareService | undefined,
  code: string | undefined,
): string {
  return (
    visitType?.name ??
    appointment.serviceType?.[0]?.text ??
    appointment.serviceType?.[0]?.coding?.find((coding) => coding.system === OSOD_VISIT_TYPE_SYSTEM)
      ?.display ??
    code ??
    "Appointment"
  );
}

function insuranceLine(appointment: Appointment): string {
  return `Vision: ${coverageLabel(visionCoverageOf(appointment))} · Medical: ${coverageLabel(
    medicalCoverageOf(appointment),
  )}`;
}

function coverageLabel(coverage: CoverageDisplay | undefined): string {
  return coverage?.display ?? coverage?.reference ?? "none";
}

function appointmentBadges(
  appointment: Appointment,
  isNonPatient: boolean,
  status: OsodAppointmentStatus | undefined,
): AppointmentBlockBadge[] {
  const badges: AppointmentBlockBadge[] = [];
  if (isUrgentAppointment(appointment)) {
    badges.push({ code: "urgent", display: "Urgent" });
  }
  if (isFollowUpAppointment(appointment)) {
    badges.push({ code: "follow-up", display: "Follow-up" });
  }
  if (status === "walk-in") {
    badges.push({ code: "walk-in", display: "Walk-in" });
  }
  if (isNonPatient) {
    badges.push({ code: "non-patient", display: "Non-patient" });
  }
  return badges;
}
