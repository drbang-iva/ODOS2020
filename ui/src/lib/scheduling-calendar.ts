import type { Appointment, HealthcareService, Schedule } from "@medplum/fhirtypes";
import {
  addDaysYmd,
  appointmentActorReferences,
  buildAppointmentBlockContent,
  isNonBlockingAppointmentStatus,
  minutesFromIsoDateTime,
  scheduleReference,
  visibleAppointmentsForMode,
  visibleSchedulingResourcesForOffice,
  weekdayOfDate,
  ymdFromIsoDateTime,
  type ClinicMode,
  type SchedulingPracticeConfig,
} from "./scheduling";
import {
  defaultAppointmentModalDraft,
  type AppointmentModalDraft,
} from "./scheduler-appointment-ui";

export type SchedulerView = "day" | "week" | "month";

export interface SchedulerWindow {
  fromYmd: string;
  toYmdExclusive: string;
}

export interface MonthCalendarCell {
  date: string;
  inCurrentMonth: boolean;
}

export interface MonthCalendarGrid {
  monthStart: string;
  fromYmd: string;
  toYmdExclusive: string;
  cells: MonthCalendarCell[];
}

export interface MonthAppointmentChip {
  appointmentId?: string;
  time: string;
  patientLastName: string;
  color: string;
}

export interface MonthAppointmentSummary {
  chips: MonthAppointmentChip[];
  hiddenCount: number;
}

const DATE_LABEL_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function weekStartYmd(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDaysYmd(date, mondayOffset);
}

export function weekDays(date: string): string[] {
  const start = weekStartYmd(date);
  return Array.from({ length: 7 }, (_, index) => addDaysYmd(start, index));
}

export function monthCalendarGrid(anchorDate: string): MonthCalendarGrid {
  const monthStart = monthStartYmd(anchorDate);
  const nextMonthStart = addMonthsClamped(monthStart, 1);
  const fromYmd = weekStartYmd(monthStart);
  const daysFromGridStartToNextMonth = daysBetweenYmd(fromYmd, nextMonthStart);
  const rows = Math.max(5, Math.ceil(daysFromGridStartToNextMonth / 7));
  const cellCount = rows * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const date = addDaysYmd(fromYmd, index);
    return {
      date,
      inCurrentMonth: date >= monthStart && date < nextMonthStart,
    };
  });
  return {
    monthStart,
    fromYmd,
    toYmdExclusive: addDaysYmd(fromYmd, cellCount),
    cells,
  };
}

export function schedulerWindowForView(date: string, view: SchedulerView): SchedulerWindow {
  if (view === "day") {
    return { fromYmd: date, toYmdExclusive: addDaysYmd(date, 1) };
  }
  if (view === "week") {
    const fromYmd = weekStartYmd(date);
    return { fromYmd, toYmdExclusive: addDaysYmd(fromYmd, 7) };
  }
  const grid = monthCalendarGrid(date);
  return { fromYmd: grid.fromYmd, toYmdExclusive: grid.toYmdExclusive };
}

export function addMonthsClamped(date: string, months: number): string {
  const { year, month, day } = ymdParts(date);
  const targetMonthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12 + 12) % 12 + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${targetYear}-${pad2(targetMonth)}-${pad2(targetDay)}`;
}

export function shiftSchedulerDate(date: string, view: SchedulerView, direction: number): string {
  if (view === "month") {
    return addMonthsClamped(date, direction);
  }
  if (view === "week") {
    return addDaysYmd(date, direction * 7);
  }
  return addDaysYmd(date, direction);
}

export function formatSchedulerDateLabel(date: string, view: SchedulerView): string {
  if (view === "month") {
    return MONTH_LABEL_FORMAT.format(utcNoon(date));
  }
  if (view === "week") {
    const start = weekStartYmd(date);
    const end = addDaysYmd(start, 6);
    const startYear = start.slice(0, 4);
    const endYear = end.slice(0, 4);
    if (startYear === endYear) {
      return `${MONTH_DAY_FORMAT.format(utcNoon(start))} \u2013 ${MONTH_DAY_FORMAT.format(utcNoon(end))}, ${endYear}`;
    }
    return `${DATE_LABEL_FORMAT.format(utcNoon(start))} \u2013 ${DATE_LABEL_FORMAT.format(utcNoon(end))}`;
  }
  return DATE_LABEL_FORMAT.format(utcNoon(date));
}

export function bucketAppointmentsByPracticeDay(
  appointments: Appointment[],
  timezoneOffset: string,
): Record<string, Appointment[]> {
  const byDay: Record<string, Appointment[]> = {};
  for (const appointment of appointments) {
    if (!appointment.start) {
      continue;
    }
    const day = ymdFromIsoDateTime(appointment.start, timezoneOffset);
    byDay[day] = [...(byDay[day] ?? []), appointment];
  }
  return byDay;
}

export function appointmentDraftForSchedulerCell(input: {
  date: string;
  startMinutes: number;
  timezoneOffset: string;
  resources: Schedule[];
  visitTypes: HealthcareService[];
  clinicMode: ClinicMode | string;
  resource: Schedule;
  status?: "scheduled" | "walk-in";
}): AppointmentModalDraft {
  return defaultAppointmentModalDraft(input);
}

export function monthAppointmentSummaries(input: {
  appointments: Appointment[];
  resources: Schedule[];
  visitTypes: HealthcareService[];
  config: SchedulingPracticeConfig;
  clinicMode: ClinicMode | string;
  officeId: string | "all";
  timezoneOffset: string;
  chipLimit?: number;
}): Record<string, MonthAppointmentSummary> {
  const chipLimit = input.chipLimit ?? 3;
  const visibleActorReferences = new Set(
    visibleSchedulingResourcesForOffice(
      input.resources,
      input.clinicMode,
      input.config,
      input.officeId,
    )
      .flatMap((resource) => resource.actor?.[0]?.reference ?? [])
      .filter(Boolean),
  );
  const summaries: Record<string, MonthAppointmentSummary> = {};
  const candidates = visibleAppointmentsForMode(input.appointments, input.clinicMode)
    .filter((appointment) => {
      if (!appointment.start || isNonBlockingAppointmentStatus(appointment.status)) {
        return false;
      }
      return appointmentActorReferences(appointment).some((reference) =>
        visibleActorReferences.has(reference),
      );
    })
    .sort((a, b) => Date.parse(a.start ?? "") - Date.parse(b.start ?? ""));

  for (const appointment of candidates) {
    if (!appointment.start) {
      continue;
    }
    const date = ymdFromIsoDateTime(appointment.start, input.timezoneOffset);
    const summary = summaries[date] ?? { chips: [], hiddenCount: 0 };
    if (summary.chips.length < chipLimit) {
      const content = buildAppointmentBlockContent(appointment, input.visitTypes);
      summary.chips.push({
        ...(appointment.id ? { appointmentId: appointment.id } : {}),
        time: formatMinutes(minutesFromIsoDateTime(appointment.start, input.timezoneOffset)),
        patientLastName: patientLastName(content.patientDisplay),
        color: content.color,
      });
    } else {
      summary.hiddenCount += 1;
    }
    summaries[date] = summary;
  }

  return summaries;
}

export function isDefaultClosedDay(date: string, config: SchedulingPracticeConfig): boolean {
  return (config.defaultWeeklyHours[weekdayOfDate(date)] ?? []).length === 0;
}

export function reconcileWeekResourceReference(input: {
  currentReference?: string;
  resources: Schedule[];
  clinicMode: ClinicMode | string;
  config: SchedulingPracticeConfig;
  officeId: string | "all";
}): string | undefined {
  const visible = visibleSchedulingResourcesForOffice(
    input.resources,
    input.clinicMode,
    input.config,
    input.officeId,
  );
  const references = visible.map((resource) => scheduleReference(resource)).filter(Boolean);
  if (input.currentReference && references.includes(input.currentReference)) {
    return input.currentReference;
  }
  return references[0];
}

function monthStartYmd(date: string): string {
  return `${date.slice(0, 8)}01`;
}

function ymdParts(date: string): { year: number; month: number; day: number } {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function daysBetweenYmd(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function utcNoon(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatMinutes(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function patientLastName(display: string): string {
  const trimmed = display.trim();
  if (!trimmed) {
    return "Unknown";
  }
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex > 0) {
    return trimmed.slice(0, commaIndex).trim();
  }
  const parts = trimmed.split(/\s+/);
  return parts.at(-1) ?? trimmed;
}
