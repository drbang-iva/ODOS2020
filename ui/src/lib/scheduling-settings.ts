import type { Schedule } from "@medplum/fhirtypes";
import {
  blocksForSchedule,
  scheduleReference,
  type BlockedTime,
  type SchedulingPracticeConfig,
  type Weekday,
} from "./scheduling";
import { buildSchedulingPracticeConfigResource } from "./scheduling-config";

const WEEKDAY_BY_UTC_DAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function addSchedulingOffice(
  config: SchedulingPracticeConfig,
  name: string,
): SchedulingPracticeConfig {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Office name is required.");
  }
  const id = uniqueOfficeId(trimmed, new Set(config.offices.map((office) => office.id)));
  return validated({ ...config, offices: [...config.offices, { id, name: trimmed }] });
}

export function renameSchedulingOffice(
  config: SchedulingPracticeConfig,
  officeId: string,
  name: string,
): SchedulingPracticeConfig {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Office name is required.");
  }
  return validated({
    ...config,
    offices: config.offices.map((office) =>
      office.id === officeId ? { ...office, name: trimmed } : office,
    ),
  });
}

export function removeSchedulingOffice(
  config: SchedulingPracticeConfig,
  officeId: string,
): SchedulingPracticeConfig {
  const assigned = Object.entries(config.officeBySchedule).filter(([, assignedOffice]) => assignedOffice === officeId);
  if (assigned.length > 0) {
    throw new Error(`Office "${officeId}" still has assigned resources.`);
  }
  return validated({
    ...config,
    offices: config.offices.filter((office) => office.id !== officeId),
  });
}

export function assignScheduleOffice(
  config: SchedulingPracticeConfig,
  scheduleRef: string,
  officeId: string,
): SchedulingPracticeConfig {
  const officeBySchedule = { ...config.officeBySchedule };
  if (officeId) {
    officeBySchedule[scheduleRef] = officeId;
  } else {
    delete officeBySchedule[scheduleRef];
  }
  return validated({ ...config, officeBySchedule });
}

export function copyWeeklyHoursBetweenSchedules(
  config: SchedulingPracticeConfig,
  sourceScheduleRef: string,
  targetScheduleRef: string,
): SchedulingPracticeConfig {
  const sourceHours = config.weeklyHoursBySchedule[sourceScheduleRef] ?? config.defaultWeeklyHours;
  return validated({
    ...config,
    weeklyHoursBySchedule: {
      ...config.weeklyHoursBySchedule,
      [targetScheduleRef]: clone(sourceHours),
    },
  });
}

export function replaceSchedulingBlock(
  config: SchedulingPracticeConfig,
  index: number,
  block: BlockedTime,
): SchedulingPracticeConfig {
  const blocks = [...config.blocks];
  blocks[index] = cleanBlock(block);
  return validated({ ...config, blocks });
}

export function deleteSchedulingBlock(
  config: SchedulingPracticeConfig,
  index: number,
): SchedulingPracticeConfig {
  return validated({ ...config, blocks: config.blocks.filter((_, candidateIndex) => candidateIndex !== index) });
}

export function editableBlockedTimeIndex(
  config: SchedulingPracticeConfig,
  schedule: Schedule,
  date: string,
  startMinutes: number,
  endMinutes: number,
): number | undefined {
  const applicable = new Set(blocksForSchedule(config, schedule));
  const weekday = WEEKDAY_BY_UTC_DAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
  const index = config.blocks.findIndex((block) => {
    if (block.kind !== "custom" || !applicable.has(block)) {
      return false;
    }
    if (block.date !== date && !(block.weekdays?.includes(weekday) ?? false)) {
      return false;
    }
    const blockStart = block.start ? minutesOfDay(block.start, "Blocked-time start") : 0;
    const blockEnd = block.end ? minutesOfDay(block.end, "Blocked-time end") : 24 * 60;
    return startMinutes < blockEnd && blockStart < endMinutes;
  });
  return index >= 0 ? index : undefined;
}

export function customBlockIndexForSchedule(
  config: SchedulingPracticeConfig,
  schedule: Schedule,
  block: BlockedTime,
): number | undefined {
  const reference = scheduleReference(schedule);
  const index = config.blocks.findIndex(
    (candidate) =>
      candidate === block &&
      candidate.kind === "custom" &&
      (!candidate.scheduleReferences ||
        candidate.scheduleReferences.length === 0 ||
        (reference !== undefined && candidate.scheduleReferences.includes(reference))),
  );
  return index >= 0 ? index : undefined;
}

function cleanBlock(block: BlockedTime): BlockedTime {
  return {
    kind: block.kind,
    ...(block.description?.trim() ? { description: block.description.trim() } : {}),
    ...(block.date ? { date: block.date } : {}),
    ...(block.weekdays?.length ? { weekdays: [...block.weekdays] } : {}),
    ...(block.start ? { start: block.start } : {}),
    ...(block.end ? { end: block.end } : {}),
    ...(block.scheduleReferences?.length ? { scheduleReferences: [...block.scheduleReferences] } : {}),
  };
}

function uniqueOfficeId(name: string, existingIds: Set<string>): string {
  const base = slug(name) || "office";
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validated(config: SchedulingPracticeConfig): SchedulingPracticeConfig {
  buildSchedulingPracticeConfigResource(config);
  return config;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function minutesOfDay(time: string, context: string): number {
  const match = TIME_HHMM.exec(time);
  if (!match) {
    throw new Error(`${context} must be an HH:MM 24-hour time, got "${time}".`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
