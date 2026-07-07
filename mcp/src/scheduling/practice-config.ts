import type { Basic } from "@medplum/fhirtypes";
import {
  BLOCKED_TIME_KINDS,
  type BlockedTime,
  type WeeklyHours,
} from "./availability.js";

/**
 * Persisted practice scheduling settings — scheduler Phase 4a (the seam the Phase-2 store
 * comment promised: "Persisted practice scheduling settings land here in a later slice").
 *
 * Design call (documented, swappable): the whole SchedulingPracticeConfig persists as ONE
 * coded singleton `Basic` resource carrying the config JSON in a registered osod extension.
 * Rationale: it is practice-owned configuration (not clinical data), it must be readable and
 * writable through the existing plain-fetch FHIR client under AccessPolicy (no new endpoint,
 * no SQL sidecar), and a criteria-scoped grant can expose exactly this one Basic to the front
 * desk. If a future slice wants Location-native offices or PractitionerRole.availableTime,
 * parse/build stay the seam — consumers never touch the wire shape directly.
 */

export const OSOD_SCHEDULING_CONFIG_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/scheduling-config";

export const OSOD_SCHEDULING_CONFIG_CODE = "osod-scheduling-config";

export const OSOD_SCHEDULING_CONFIG_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-scheduling-practice-config";

/** A stored block: the kernel BlockedTime plus optional per-schedule scoping (absent = global). */
export type PersistedBlockedTime = BlockedTime & { scheduleReferences?: string[] };

export interface SchedulingOffice {
  /** Stable practice-local office id ("main"). */
  id: string;
  /** Office selector display name. */
  name: string;
  /** Booking increment in minutes for this office (10/15/30/60). Falls back to the practice default. */
  slotMinutes?: number;
}

export interface PersistedSchedulingPracticeConfig {
  /** The practice's UTC offset ("±HH:MM"). */
  timezoneOffset: string;
  defaultWeeklyHours: WeeklyHours;
  /** Per-resource hours templates, keyed by Schedule reference. */
  weeklyHoursBySchedule: Record<string, WeeklyHours>;
  blocks: PersistedBlockedTime[];
  /** Practice offices as config data (Location-native modeling deferred until needed). */
  offices: SchedulingOffice[];
  /** Resource → office assignment, keyed by Schedule reference. */
  officeBySchedule: Record<string, string>;
  /** Practice-wide booking increment (minutes), used for "All Offices" and offices without an override. */
  defaultSlotMinutes?: number;
}

const OFFSET = /^[+-]\d{2}:\d{2}$/;
const TIME_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;

const KNOWN_BLOCK_KINDS = new Set<string>(BLOCKED_TIME_KINDS.map((kind) => kind.code));

function assertTime(value: string, context: string): void {
  if (!TIME_HHMM.test(value)) {
    throw new Error(`${context} must be an HH:MM 24-hour time, got "${value}".`);
  }
}

function assertWeeklyHours(hours: WeeklyHours, context: string): void {
  for (const [weekday, windows] of Object.entries(hours)) {
    for (const window of windows ?? []) {
      assertTime(window.start, `${context} ${weekday} start`);
      assertTime(window.end, `${context} ${weekday} end`);
      if (window.end <= window.start) {
        throw new Error(
          `${context} ${weekday} time window must end after it starts (${window.start}–${window.end}).`,
        );
      }
    }
  }
}

function assertConfig(config: PersistedSchedulingPracticeConfig): void {
  if (!OFFSET.test(config.timezoneOffset)) {
    throw new Error(`Timezone offset must be ±HH:MM, got "${config.timezoneOffset}".`);
  }
  assertWeeklyHours(config.defaultWeeklyHours, "Default weekly hours");
  for (const [scheduleReference, hours] of Object.entries(config.weeklyHoursBySchedule)) {
    assertWeeklyHours(hours, `Weekly hours for ${scheduleReference}`);
  }
  for (const block of config.blocks) {
    if (!KNOWN_BLOCK_KINDS.has(block.kind)) {
      throw new Error(
        `Unknown blocked-time kind "${block.kind}" — must be office-closed, staff-off, or custom.`,
      );
    }
    if (!block.date && (!block.weekdays || block.weekdays.length === 0)) {
      throw new Error("Blocked time must be anchored to a date or recurring weekdays.");
    }
    if (block.date && !DATE_YMD.test(block.date)) {
      throw new Error(`Blocked-time date must be YYYY-MM-DD, got "${block.date}".`);
    }
    if (block.start) {
      assertTime(block.start, "Blocked-time start");
    }
    if (block.end) {
      assertTime(block.end, "Blocked-time end");
    }
  }
  const officeIds = new Set(config.offices.map((office) => office.id));
  for (const [scheduleReference, officeId] of Object.entries(config.officeBySchedule)) {
    if (!officeIds.has(officeId)) {
      throw new Error(
        `Schedule ${scheduleReference} is assigned to office "${officeId}", which is not a declared office.`,
      );
    }
  }
}

/**
 * Build the singleton Basic carrying the practice scheduling config. Pass the existing
 * resource to preserve id + meta (update-in-place; the config is a singleton, never a second copy).
 */
export function buildSchedulingPracticeConfigResource(
  config: PersistedSchedulingPracticeConfig,
  existing?: Basic,
): Basic {
  assertConfig(config);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [
        {
          system: OSOD_SCHEDULING_CONFIG_SYSTEM,
          code: OSOD_SCHEDULING_CONFIG_CODE,
          display: "OSOD Scheduling Practice Config",
        },
      ],
      text: "OSOD Scheduling Practice Config",
    },
    extension: [
      { url: OSOD_SCHEDULING_CONFIG_EXTENSION_URL, valueString: JSON.stringify(config) },
    ],
  };
}

/**
 * Parse the stored config back out of the singleton Basic. Forward-compatible: only the known
 * top-level keys are read, so future config knobs written by a newer OSOD never break an older
 * reader. The parsed config is re-validated before it is returned.
 */
export function parseSchedulingPracticeConfig(basic: Basic): PersistedSchedulingPracticeConfig {
  const coding = basic.code?.coding?.find(
    (candidate) =>
      candidate.system === OSOD_SCHEDULING_CONFIG_SYSTEM &&
      candidate.code === OSOD_SCHEDULING_CONFIG_CODE,
  );
  if (!coding) {
    throw new Error("Basic resource is not the osod scheduling-config singleton.");
  }
  const raw = basic.extension?.find(
    (extension) => extension.url === OSOD_SCHEDULING_CONFIG_EXTENSION_URL,
  )?.valueString;
  if (!raw) {
    throw new Error("Scheduling-config singleton is missing its config extension.");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Scheduling-config JSON is malformed and cannot be parsed.");
  }
  const config: PersistedSchedulingPracticeConfig = {
    timezoneOffset: parsed.timezoneOffset as string,
    defaultWeeklyHours: (parsed.defaultWeeklyHours ?? {}) as WeeklyHours,
    weeklyHoursBySchedule: (parsed.weeklyHoursBySchedule ?? {}) as Record<string, WeeklyHours>,
    blocks: (parsed.blocks ?? []) as PersistedBlockedTime[],
    offices: (parsed.offices ?? []) as SchedulingOffice[],
    officeBySchedule: (parsed.officeBySchedule ?? {}) as Record<string, string>,
    ...(typeof parsed.defaultSlotMinutes === "number"
      ? { defaultSlotMinutes: parsed.defaultSlotMinutes }
      : {}),
  };
  assertConfig(config);
  return config;
}
