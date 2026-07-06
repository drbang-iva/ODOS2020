import {
  type BlockedTime,
  type DayHours,
  type SchedulingPracticeConfig,
  type Weekday,
} from "./scheduling";
import { minutesOfDay } from "./scheduling";
import { buildSchedulingPracticeConfigResource } from "./scheduling-config";

const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const RESERVED_OFFICE_IDS = new Set(["all"]);

export interface BlockScopeState {
  mode: "all" | "selected";
  scheduleReferences: string[];
}

export function addSchedulingOffice(
  config: SchedulingPracticeConfig,
  name: string,
): SchedulingPracticeConfig {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Office name is required.");
  }
  const id = uniqueOfficeId(trimmed, new Set([...config.offices.map((office) => office.id), ...RESERVED_OFFICE_IDS]));
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
  assertPersistableBlockScope(block);
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

export function blockScopeState(block: BlockedTime): BlockScopeState {
  return block.scheduleReferences?.length
    ? { mode: "selected", scheduleReferences: [...block.scheduleReferences] }
    : { mode: "all", scheduleReferences: [] };
}

export function validateBlockScope(scope: BlockScopeState): void {
  if (scope.mode === "selected" && scope.scheduleReferences.length === 0) {
    throw new Error("Selected resources scope requires at least one selected resource.");
  }
}

export function applyBlockScope(block: BlockedTime, scope: BlockScopeState): BlockedTime {
  validateBlockScope(scope);
  if (scope.mode === "all") {
    const { scheduleReferences, ...rest } = block;
    void scheduleReferences;
    return rest;
  }
  return { ...block, scheduleReferences: [...scope.scheduleReferences] };
}

export function validateSchedulingPracticeSettings(config: SchedulingPracticeConfig): void {
  for (const office of config.offices) {
    if (!office.name.trim()) {
      throw new Error("Office name is required.");
    }
    if (RESERVED_OFFICE_IDS.has(office.id)) {
      throw new Error(`Office id "${office.id}" is reserved for the All Offices selector.`);
    }
  }
  buildSchedulingPracticeConfigResource(config);
  assertSortedNonOverlappingHours(config.defaultWeeklyHours, "Default weekly hours");
  for (const [scheduleReference, hours] of Object.entries(config.weeklyHoursBySchedule)) {
    assertSortedNonOverlappingHours(hours, `Weekly hours for ${scheduleReference}`);
  }
  for (const block of config.blocks) {
    assertPersistableBlockScope(block);
  }
}

export function nextAvailableHoursWindow(windows: DayHours[]): DayHours | undefined {
  if (windows.length === 0) {
    return { start: "09:00", end: "17:00" };
  }
  const lastEnd = windows.reduce(
    (latest, window) => Math.max(latest, minutesOfDay(window.end, "Operating-hours end")),
    0,
  );
  if (lastEnd >= 23 * 60) {
    return undefined;
  }
  const end = Math.min(lastEnd + 60, 23 * 60 + 59);
  return { start: formatMinutes(lastEnd), end: formatMinutes(end) };
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
  validateSchedulingPracticeSettings(config);
  return config;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertSortedNonOverlappingHours(hours: SchedulingPracticeConfig["defaultWeeklyHours"], context: string): void {
  for (const weekday of WEEKDAYS) {
    let previousEnd = -1;
    for (const window of hours[weekday] ?? []) {
      const start = minutesOfDay(window.start, `${context} ${weekday} start`);
      const end = minutesOfDay(window.end, `${context} ${weekday} end`);
      if (start < previousEnd) {
        throw new Error(`${context} ${weekday} windows must be sorted and non-overlapping.`);
      }
      previousEnd = end;
    }
  }
}

function assertPersistableBlockScope(block: BlockedTime): void {
  if (block.scheduleReferences && block.scheduleReferences.length === 0) {
    validateBlockScope({ mode: "selected", scheduleReferences: [] });
  }
}

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
