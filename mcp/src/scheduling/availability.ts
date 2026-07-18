import type { Slot } from "@medplum/fhirtypes";

/**
 * Availability — operating hours + blocked time → FHIR Slots (brief §6, §8 step 1).
 *
 * Pure and deterministic: weekly-hours templates (the AestheticsPro staff-scheduling model —
 * per-resource hours, reusable as saved templates) expand into `free` Slots at grid granularity;
 * blocked time (the AestheticsPro trio: Office Closed / Staff Member Off / Custom, one-date or
 * weekly-recurring) turns overlapped slots `busy-unavailable`, carrying its kind + description so
 * any renderer can label the region. Days with no configured hours emit nothing — the Eyefinity
 * outside-hours gray is a view concern, not data.
 *
 * No wall clock, no timezone database: the practice's UTC offset is explicit config, so the same
 * inputs always generate the same slots (mirrors the payments-slice injected-clock discipline).
 */

export const ODOS_BLOCKED_TIME_KIND_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-blocked-time-kind";

export const ODOS_BLOCKED_TIME_KIND_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/blocked-time-kind";

export const BLOCKED_TIME_KINDS = [
  { code: "office-closed", display: "Office Closed" },
  { code: "staff-off", display: "Staff Member Off" },
  { code: "custom", display: "Custom" },
] as const;

export type BlockedTimeKind = (typeof BLOCKED_TIME_KINDS)[number]["code"];

const KIND_BY_CODE = new Map<string, (typeof BLOCKED_TIME_KINDS)[number]>(
  BLOCKED_TIME_KINDS.map((kind) => [kind.code, kind]),
);

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const WEEKDAY_BY_UTC_DAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface DayHours {
  /** "HH:MM" 24h. */
  start: string;
  end: string;
}

/** Per-weekday operating hours; a missing/empty day is closed. Reusable as a saved template. */
export type WeeklyHours = Partial<Record<Weekday, DayHours[]>>;

export interface BlockedTime {
  kind: BlockedTimeKind;
  /** Label for custom blocks ("Rep lunch"); rides on the blocked slots as comment. */
  description?: string;
  /** One-off block on a single date ("2026-07-08"). */
  date?: string;
  /** Weekly-recurring block on these weekdays. */
  weekdays?: Weekday[];
  /** "HH:MM" window; omit both for an all-day block. */
  start?: string;
  end?: string;
}

export interface SlotGenerationInput {
  /** The resource's Schedule ("Schedule/…"). */
  scheduleReference: string;
  weeklyHours: WeeklyHours;
  /** Grid granularity in minutes (Eyefinity ships 30). */
  slotMinutes: number;
  /** Inclusive date range ("YYYY-MM-DD"). */
  from: string;
  to: string;
  /** The practice's UTC offset ("−05:00" style or "Z"). */
  timezoneOffset: string;
  /** Blocks applicable to this schedule (the service layer filters applicability). */
  blocks?: BlockedTime[];
}

const TIME_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET = /^(Z|[+-]\d{2}:\d{2})$/;
const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;

function minutesOfDay(time: string, context: string): number {
  const match = TIME_HHMM.exec(time);
  if (!match) {
    throw new Error(`${context} must be an HH:MM 24-hour time, got "${time}".`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function assertDate(date: string, context: string): void {
  if (!DATE_YMD.test(date)) {
    throw new Error(`${context} must be a YYYY-MM-DD date, got "${date}".`);
  }
}

function isoAt(date: string, minutes: number, offset: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00${offset}`;
}

interface BlockWindow {
  startMinutes: number;
  endMinutes: number;
  block: BlockedTime;
}

/** The block windows applying to one calendar date. */
function blockWindowsFor(date: string, weekday: Weekday, blocks: BlockedTime[]): BlockWindow[] {
  const windows: BlockWindow[] = [];
  for (const block of blocks) {
    const applies = block.date === date || (block.weekdays?.includes(weekday) ?? false);
    if (!applies) {
      continue;
    }
    const startMinutes = block.start ? minutesOfDay(block.start, "Blocked-time start") : 0;
    const endMinutes = block.end ? minutesOfDay(block.end, "Blocked-time end") : 24 * 60;
    windows.push({ startMinutes, endMinutes, block });
  }
  return windows;
}

/** Expand operating hours + blocked time into the schedule's Slots for a date range. */
export function generateSlots(input: SlotGenerationInput): Slot[] {
  if (!Number.isInteger(input.slotMinutes) || input.slotMinutes <= 0) {
    throw new Error("Slot granularity (slotMinutes) must be a positive integer.");
  }
  if (!OFFSET.test(input.timezoneOffset)) {
    throw new Error(
      `Timezone offset must be "±HH:MM" or "Z", got "${input.timezoneOffset}".`,
    );
  }
  assertDate(input.from, "Range start (from)");
  assertDate(input.to, "Range end (to)");
  if (input.from > input.to) {
    throw new Error(`Date range is inverted: from "${input.from}" is after to "${input.to}".`);
  }
  for (const block of input.blocks ?? []) {
    if (!KIND_BY_CODE.has(block.kind)) {
      throw new Error(
        `Unknown blocked-time kind "${block.kind}" — must be office-closed, staff-off, or custom.`,
      );
    }
    if (!block.date && (!block.weekdays || block.weekdays.length === 0)) {
      throw new Error("Blocked time must be anchored to a date or recurring weekdays.");
    }
    if (block.date) {
      assertDate(block.date, "Blocked-time date");
    }
  }

  const slots: Slot[] = [];
  const cursor = new Date(`${input.from}T00:00:00Z`);
  const last = new Date(`${input.to}T00:00:00Z`);

  while (cursor.getTime() <= last.getTime()) {
    const date = cursor.toISOString().slice(0, 10);
    const weekday = WEEKDAY_BY_UTC_DAY[cursor.getUTCDay()]!;
    const windows = blockWindowsFor(date, weekday, input.blocks ?? []);

    for (const hours of input.weeklyHours[weekday] ?? []) {
      const open = minutesOfDay(hours.start, "Operating-hours start");
      const close = minutesOfDay(hours.end, "Operating-hours end");
      if (close <= open) {
        throw new Error(
          `Operating-hours window must end after it starts (${hours.start}–${hours.end}).`,
        );
      }
      for (let at = open; at + input.slotMinutes <= close; at += input.slotMinutes) {
        const slotEnd = at + input.slotMinutes;
        const blocking = windows.find(
          (w) => at < w.endMinutes && w.startMinutes < slotEnd,
        );
        slots.push({
          resourceType: "Slot",
          schedule: { reference: input.scheduleReference },
          status: blocking ? "busy-unavailable" : "free",
          start: isoAt(date, at, input.timezoneOffset),
          end: isoAt(date, slotEnd, input.timezoneOffset),
          ...(blocking
            ? {
                ...(blocking.block.description ? { comment: blocking.block.description } : {}),
                extension: [
                  {
                    url: ODOS_BLOCKED_TIME_KIND_EXTENSION_URL,
                    valueCodeableConcept: {
                      coding: [
                        {
                          system: ODOS_BLOCKED_TIME_KIND_SYSTEM,
                          code: blocking.block.kind,
                          display: KIND_BY_CODE.get(blocking.block.kind)!.display,
                        },
                      ],
                    },
                  },
                ],
              }
            : {}),
        });
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return slots;
}

/** The blocked-time kind on a busy-unavailable slot (undefined on free slots). */
export function blockedTimeKindOf(slot: Slot): BlockedTimeKind | undefined {
  const coding = slot.extension
    ?.find((e) => e.url === ODOS_BLOCKED_TIME_KIND_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.find((c) => c.system === ODOS_BLOCKED_TIME_KIND_SYSTEM);
  return coding?.code as BlockedTimeKind | undefined;
}
