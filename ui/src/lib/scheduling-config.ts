import type { Basic } from "@medplum/fhirtypes";
import {
  BLOCKED_TIME_KINDS,
  type BlockedTime,
  type SchedulingOffice,
  type SchedulingPracticeConfig,
  type WeeklyHours,
} from "./scheduling";

export const ODOS_SCHEDULING_CONFIG_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/scheduling-config";

export const ODOS_SCHEDULING_CONFIG_CODE = "odos-scheduling-config";

export const ODOS_SCHEDULING_CONFIG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-scheduling-practice-config";

export type PersistedBlockedTime = BlockedTime & { scheduleReferences?: string[] };

export type { SchedulingOffice };
export type PersistedSchedulingPracticeConfig = SchedulingPracticeConfig;

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
          system: ODOS_SCHEDULING_CONFIG_SYSTEM,
          code: ODOS_SCHEDULING_CONFIG_CODE,
          display: "ODOS Scheduling Practice Config",
        },
      ],
      text: "ODOS Scheduling Practice Config",
    },
    extension: [
      { url: ODOS_SCHEDULING_CONFIG_EXTENSION_URL, valueString: JSON.stringify(config) },
    ],
  };
}

export function parseSchedulingPracticeConfig(basic: Basic): PersistedSchedulingPracticeConfig {
  const coding = basic.code?.coding?.find(
    (candidate) =>
      candidate.system === ODOS_SCHEDULING_CONFIG_SYSTEM &&
      candidate.code === ODOS_SCHEDULING_CONFIG_CODE,
  );
  if (!coding) {
    throw new Error("Basic resource is not the odos scheduling-config singleton.");
  }
  const raw = basic.extension?.find(
    (extension) => extension.url === ODOS_SCHEDULING_CONFIG_EXTENSION_URL,
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
