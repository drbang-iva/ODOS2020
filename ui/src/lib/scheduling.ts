import type { Appointment, HealthcareService, Schedule, Slot } from "@medplum/fhirtypes";

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

export interface CoverageDisplay {
  reference?: string;
  display?: string;
}

export interface SchedulingPracticeConfig {
  timezoneOffset: string;
  defaultWeeklyHours: WeeklyHours;
  weeklyHoursBySchedule: Record<string, WeeklyHours>;
  blocks: BlockedTime[];
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

export function scheduleReference(schedule: Schedule): string | undefined {
  return schedule.id ? `Schedule/${schedule.id}` : undefined;
}

export function resourceActorReference(schedule: Schedule): string | undefined {
  return schedule.actor?.[0]?.reference;
}

export function resourceDisplay(schedule: Schedule): string {
  return schedule.actor?.[0]?.display ?? schedule.actor?.[0]?.reference ?? schedule.comment ?? "Unassigned";
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
  const reference = scheduleReference(schedule);
  return config.blocks.filter(
    (block) =>
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
  for (const block of input.blocks.filter((candidate) => blockAppliesToDate(candidate, input.date, weekday))) {
    const startMinutes = block.start ? minutesOfDay(block.start, "Blocked-time start") : 0;
    const endMinutes = block.end ? minutesOfDay(block.end, "Blocked-time end") : 24 * 60;
    const clamped = clampWindow({ startMinutes, endMinutes }, input.axisStartMinutes, input.axisEndMinutes);
    if (!clamped) {
      continue;
    }
    blocked.push({
      ...region("blocked", clamped.startMinutes, clamped.endMinutes, input),
      blockedKind: block.kind,
      blockedKindDisplay: BLOCKED_KIND_BY_CODE.get(block.kind)?.display,
      ...(block.description ? { description: block.description } : {}),
    });
  }

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

function weekdayOfDate(date: string): Weekday {
  return WEEKDAY_BY_UTC_DAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

function minutesOfDay(time: string, context: string): number {
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

function timezoneOffsetMinutes(timezoneOffset: string): number {
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

function appointmentActorReferences(appointment: Appointment): string[] {
  return appointment.participant
    .map((participant) => participant.actor?.reference)
    .filter((reference): reference is string => Boolean(reference));
}

function appointmentDurationMinutes(appointment: Appointment): number | undefined {
  if (typeof appointment.minutesDuration === "number" && appointment.minutesDuration > 0) {
    return appointment.minutesDuration;
  }
  if (appointment.start && appointment.end) {
    const duration = Math.round((Date.parse(appointment.end) - Date.parse(appointment.start)) / 60_000);
    return duration > 0 ? duration : undefined;
  }
  return undefined;
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
