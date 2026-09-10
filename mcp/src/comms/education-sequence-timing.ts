import type { EducationSequenceStep } from "./education-sequence.js";
export type PredecessorTimingEvidence = { kind: "accepted" | "clinician-skip"; at: string } | { kind: "unknown" };
export interface EducationBusinessCalendar {
  id: string;
  version: number;
  /** Sunday = 0, Saturday = 6; supplied by the pinned calendar, never inferred. */
  workingWeekdays: readonly number[];
  holidays: readonly string[];
}
export type EducationBusinessCalendarResolver = (pin: NonNullable<EducationSequenceStep["calendar"]>) => EducationBusinessCalendar | undefined;
export type EducationSequenceTime = { status: "ready"; effectiveAt: string } | { status: "held"; reason: "predecessor-anchor-unavailable" | "business-calendar-unavailable" };
const DAY = 86_400_000;
function localClock(instant: number, formatter: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(p => [p.type, p.value]));
  const clock = new Date(0);
  clock.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  clock.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), new Date(instant).getUTCMilliseconds());
  return clock.getTime();
}
function clockFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}
function instantForLocal(clock: number, formatter: Intl.DateTimeFormat): number {
  const offsets = new Set<number>();
  for (let sample = clock - 2 * DAY; sample <= clock + 2 * DAY; sample += 3_600_000)
    offsets.add(localClock(sample, formatter) - sample);
  const candidates = [...offsets].map(offset => clock - offset).sort((a, b) => a - b);
  const matching = candidates.filter(instant => localClock(instant, formatter) === clock);
  if (matching.length) return matching[0];
  // A gap brackets a forward transition: find its first representable millisecond.
  let low = candidates[0];
  let high = candidates[candidates.length - 1];
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localClock(middle, formatter) < clock) low = middle;
    else high = middle;
  }
  return high;
}
export function calculateEducationSequenceTime(row: EducationSequenceStep, predecessor?: PredecessorTimingEvidence, resolveCalendar?: EducationBusinessCalendarResolver): EducationSequenceTime {
  if (row.anchor === "stage-entry")
    return { status: "ready", effectiveAt: new Date(row.notBefore).toISOString() };
  if (!predecessor || predecessor.kind === "unknown" || !Number.isFinite(Date.parse(predecessor.at)))
    return { status: "held", reason: "predecessor-anchor-unavailable" };
  let calendar: EducationBusinessCalendar | undefined;
  if (row.dayInterpretation === "business") {
    calendar = row.calendar && resolveCalendar?.(row.calendar);
    if (!calendar || calendar.id !== row.calendar?.id || calendar.version !== row.calendar.version ||
      !calendar.workingWeekdays.length || calendar.workingWeekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))
      return { status: "held", reason: "business-calendar-unavailable" };
  }
  const formatter = clockFormatter(row.timezone);
  let target = localClock(Date.parse(predecessor.at), formatter);
  if (!calendar) target += row.offsetDays * DAY;
  else {
    const holidays = new Set(calendar.holidays);
    let remaining = row.offsetDays;
    while (remaining > 0) {
      target += DAY;
      const day = new Date(target);
      if (calendar.workingWeekdays.includes(day.getUTCDay()) && !holidays.has(day.toISOString().slice(0, 10))) remaining--;
    }
  }
  return { status: "ready", effectiveAt: new Date(instantForLocal(target, formatter)).toISOString() };
}
export function educationLocalDay(instant: string, timezone: string): string {
  return new Date(localClock(Date.parse(instant), clockFormatter(timezone))).toISOString().slice(0, 10);
}
