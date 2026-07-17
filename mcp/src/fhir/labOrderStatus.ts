import type { Task } from "@medplum/fhirtypes";
import {
  LAB_ORDER_FRAME_SOURCE_LABELS,
  assertLabOrderFrameSource,
  type LabOrderFrameOwnership,
  type LabOrderFrameSource,
} from "./opticalLabOrder.js";
import {
  assertLabTransportState,
  type LabTransportState,
} from "./labTransportState.js";

export const LAB_ORDER_STATUSES = [
  "patients-frame",
  "in-office-not-sent",
  "outbound",
  "at-lab",
  "lenses-on-order",
  "frame-on-order",
  "inbound",
  "received",
  "notified",
  "dispensed",
] as const;

export type LabOrderStatus = (typeof LAB_ORDER_STATUSES)[number];
export type LabOrderNotificationReason = "reached" | "left-message" | "unable";
export type LabOrderProblemReason = "lab-lost" | "lab-breakage-remake" | "cannot-locate" | "other";

export interface LabOrderStatusHistoryEntry {
  status: LabOrderStatus;
  enteredAt: string;
  setBy?: string;
  notificationReason?: LabOrderNotificationReason;
  resetReason?: "lab-breakage-remake";
}

export interface LabOrderProblemFlag {
  id: string;
  reason: LabOrderProblemReason;
  note: string;
  flaggedBy: string;
  flaggedAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface LabOrderStatusRecord {
  version: 1;
  currentStatus: LabOrderStatus;
  history: LabOrderStatusHistoryEntry[];
  problemFlags: LabOrderProblemFlag[];
}

export interface LabOrderAgingConfig {
  outboundDays: number;
  inboundDays: number;
  atLabDays: number;
  receivedNotifyHours: number;
  notifiedRetryDays: number;
  notifiedFollowUpDays: number;
}

export const DEFAULT_LAB_ORDER_AGING_CONFIG: LabOrderAgingConfig = {
  outboundDays: 3,
  inboundDays: 3,
  atLabDays: 5,
  receivedNotifyHours: 24,
  notifiedRetryDays: 2,
  notifiedFollowUpDays: 7,
};

export const ODOS_LAB_ORDER_TASK_INPUT_SYSTEM = "https://odos2020.com/fhir/CodeSystem/lab-order-task-input";
export const LAB_ORDER_EXPORT_INPUT_CODE = "lab-order-export";
export const LAB_ORDER_STATUS_INPUT_CODE = "lab-order-status";

const STATUS_LABELS: Record<LabOrderStatus, string> = {
  "patients-frame": "Patient's frame",
  "in-office-not-sent": "In office — not sent",
  outbound: "Outbound",
  "at-lab": "At lab",
  "lenses-on-order": "Lenses on order",
  "frame-on-order": "Frame on order",
  inbound: "Inbound",
  received: "Received",
  notified: "Notified",
  dispensed: "Dispensed",
};

const PROBLEM_LABELS: Record<LabOrderProblemReason, string> = {
  "lab-lost": "Lab lost it",
  "lab-breakage-remake": "Lab breakage/remake",
  "cannot-locate": "Can't locate in office",
  other: "Other",
};

export interface LabOrderBoardItem {
  reference: string;
  orderId: string;
  patientId?: string;
  patientName: string;
  lab: string;
  frame: string;
  lenses: string;
  frameSource?: LabOrderFrameSource;
  frameSourceLabel: string;
  frameOwnership?: LabOrderFrameOwnership;
  status: LabOrderStatus;
  statusLabel: string;
  notificationReason?: LabOrderNotificationReason;
  enteredAt: string;
  ageMinutes: number;
  warningMinutes?: number;
  limitMinutes?: number;
  needsAction: boolean;
  overdue: boolean;
  transportState: LabTransportState;
  transmissionFact: { kind: "oma" | "manual" | "error" | "none"; label: string };
  problemFlags: LabOrderProblemFlag[];
  openFlag?: LabOrderProblemFlag;
}

export interface LabOrderBoardSummary {
  items: LabOrderBoardItem[];
  counts: Record<LabOrderStatus, number>;
  activeCount: number;
  unprojectableCount: number;
  alarms: {
    flaggedProblems: number;
    atLabOverdue: number;
    transmissionFailures: number;
    receivedNotNotified: number;
  };
  rollups: {
    preLab: number;
    outbound: number;
    atLab: number;
    inbound: number;
    notified: number;
  };
  agingConfig: LabOrderAgingConfig;
}

export function assertLabOrderStatus(value: string): asserts value is LabOrderStatus {
  if (!(LAB_ORDER_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unknown lab-order status "${value}".`);
  }
}

export function assertLabOrderNotificationReason(value: string): asserts value is LabOrderNotificationReason {
  if (value !== "reached" && value !== "left-message" && value !== "unable") {
    throw new Error(`Unknown lab-order notification reason "${value}".`);
  }
}

export function assertLabOrderProblemReason(value: string): asserts value is LabOrderProblemReason {
  if (value !== "lab-lost" && value !== "lab-breakage-remake" && value !== "cannot-locate" && value !== "other") {
    throw new Error(`Unknown lab-order problem reason "${value}".`);
  }
}

export function labOrderStatusLabel(status: LabOrderStatus): string {
  return STATUS_LABELS[status];
}

export function labOrderProblemLabel(reason: LabOrderProblemReason): string {
  return PROBLEM_LABELS[reason];
}

export function labOrderStatusRecordFromTask(task: Task): LabOrderStatusRecord | undefined {
  const raw = task.input?.find((input) => input.type.coding?.some((coding) =>
    coding.system === ODOS_LAB_ORDER_TASK_INPUT_SYSTEM && coding.code === LAB_ORDER_STATUS_INPUT_CODE))?.valueString;
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Task/${task.id ?? "(missing-id)"} contains invalid lab-order status JSON.`);
  }
  if (!isLabOrderStatusRecord(parsed)) {
    throw new Error(`Task/${task.id ?? "(missing-id)"} contains an unsupported lab-order status record.`);
  }
  return parsed;
}

export function backfilledLabOrderStatusRecord(task: Task): LabOrderStatusRecord {
  const existing = labOrderStatusRecordFromTask(task);
  if (existing) return existing;
  const transportState = transportStateFromTask(task);
  const status = backfilledStatusForTransport(transportState);
  const enteredAt = task.lastModified ?? task.authoredOn ?? task.meta?.lastUpdated;
  if (!enteredAt || !Number.isFinite(Date.parse(enteredAt))) {
    throw new Error(`Task/${task.id ?? "(missing-id)"} has no usable timestamp for lab-order status backfill.`);
  }
  return { version: 1, currentStatus: status, history: [{ status, enteredAt }], problemFlags: [] };
}

export function backfilledStatusForTransport(state: LabTransportState): LabOrderStatus {
  if (state === "queued" || state === "error") return "in-office-not-sent";
  if (state === "shipped") return "inbound";
  if (state === "received") return "received";
  return "at-lab";
}

export function withLabOrderStatusRecord(task: Task, record: LabOrderStatusRecord): Task {
  const input = (task.input ?? []).filter((entry) => !entry.type.coding?.some((coding) =>
    coding.system === ODOS_LAB_ORDER_TASK_INPUT_SYSTEM && coding.code === LAB_ORDER_STATUS_INPUT_CODE));
  return {
    ...task,
    input: [...input, {
      type: {
        coding: [{
          system: ODOS_LAB_ORDER_TASK_INPUT_SYSTEM,
          code: LAB_ORDER_STATUS_INPUT_CODE,
          display: "Lab Order Status",
        }],
        text: "Lab Order Status",
      },
      valueString: JSON.stringify(record),
    }],
  };
}

export function setLabOrderStatus(
  task: Task,
  toStatus: LabOrderStatus,
  enteredAt: string,
  setBy: string,
  notificationReason?: LabOrderNotificationReason,
): Task {
  assertLabOrderStatus(toStatus);
  assertIsoInstant(enteredAt, "enteredAt");
  assertStaffReference(setBy);
  if (toStatus === "notified" && !notificationReason) {
    throw new Error("A notification reason is required when setting status to notified.");
  }
  if (toStatus !== "notified" && notificationReason) {
    throw new Error("A notification reason is only allowed when setting status to notified.");
  }
  const current = backfilledLabOrderStatusRecord(task);
  if (current.currentStatus === toStatus) {
    throw new Error(`Lab order is already in status "${toStatus}".`);
  }
  const entry: LabOrderStatusHistoryEntry = {
    status: toStatus,
    enteredAt,
    setBy,
    ...(notificationReason ? { notificationReason } : {}),
  };
  return {
    ...withLabOrderStatusRecord(task, {
      ...current,
      currentStatus: toStatus,
      history: [...current.history, entry],
    }),
    lastModified: enteredAt,
  };
}

export function flagLabOrderProblem(
  task: Task,
  input: { reason: LabOrderProblemReason; note: string; flaggedBy: string; flaggedAt: string },
): Task {
  assertLabOrderProblemReason(input.reason);
  assertStaffReference(input.flaggedBy);
  assertIsoInstant(input.flaggedAt, "flaggedAt");
  const note = input.note.trim();
  if (!note) throw new Error("A problem flag note is required.");
  const current = backfilledLabOrderStatusRecord(task);
  const flag: LabOrderProblemFlag = {
    id: `flag-${current.problemFlags.length + 1}`,
    reason: input.reason,
    note,
    flaggedBy: input.flaggedBy,
    flaggedAt: input.flaggedAt,
  };
  const history = input.reason === "lab-breakage-remake"
    ? [...current.history, { status: current.currentStatus, enteredAt: input.flaggedAt, setBy: input.flaggedBy, resetReason: input.reason } satisfies LabOrderStatusHistoryEntry]
    : current.history;
  return {
    ...withLabOrderStatusRecord(task, {
      ...current,
      history,
      problemFlags: [...current.problemFlags, flag],
    }),
    lastModified: input.flaggedAt,
  };
}

export function resolveLabOrderProblem(
  task: Task,
  input: { flagId: string; resolvedBy: string; resolvedAt: string },
): Task {
  assertStaffReference(input.resolvedBy);
  assertIsoInstant(input.resolvedAt, "resolvedAt");
  const current = backfilledLabOrderStatusRecord(task);
  const target = current.problemFlags.find((flag) => flag.id === input.flagId);
  if (!target) throw new Error(`Problem flag "${input.flagId}" was not found.`);
  if (target.resolvedAt) throw new Error(`Problem flag "${input.flagId}" is already resolved.`);
  return {
    ...withLabOrderStatusRecord(task, {
      ...current,
      problemFlags: current.problemFlags.map((flag) => flag.id === input.flagId
        ? { ...flag, resolvedBy: input.resolvedBy, resolvedAt: input.resolvedAt }
        : flag),
    }),
    lastModified: input.resolvedAt,
  };
}

export function projectLabOrderBoard(
  tasks: readonly Task[],
  now: string,
  agingConfig: LabOrderAgingConfig = DEFAULT_LAB_ORDER_AGING_CONFIG,
): LabOrderBoardSummary {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`Invalid board projection instant "${now}".`);
  const counts = Object.fromEntries(LAB_ORDER_STATUSES.map((status) => [status, 0])) as Record<LabOrderStatus, number>;
  let unprojectableCount = 0;
  const items = tasks.flatMap((task): LabOrderBoardItem[] => {
    try {
      if (!task.id) throw new Error("Lab-order transmission Task is missing its id.");
      const transportState = transportStateFromTask(task);
      if (transportState === "cancelled") return [];
      const record = backfilledLabOrderStatusRecord(task);
      if (record.currentStatus === "dispensed") {
        counts.dispensed += 1;
        return [];
      }
      const currentEntry = record.history[record.history.length - 1];
      const enteredMs = Date.parse(currentEntry.enteredAt);
      const ageMinutes = Math.max(0, Math.floor((nowMs - enteredMs) / 60_000));
      const thresholds = agingThresholds(record.currentStatus, agingConfig);
      const openFlag = [...record.problemFlags].reverse().find((flag) => !flag.resolvedAt);
      const stored = storedOrderFromTask(task);
      const frameSource = stored.frameSource;
      const warningReached = thresholds.warningMinutes !== undefined && ageMinutes >= thresholds.warningMinutes;
      const overdue = thresholds.limitMinutes !== undefined && ageMinutes >= thresholds.limitMinutes;
      const needsAction = Boolean(openFlag)
        || transportState === "error"
        || record.currentStatus === "received"
        || warningReached;
      const patientId = stored.header.patientRef?.match(/^Patient\/([^/]+)$/)?.[1];
      counts[record.currentStatus] += 1;
      return [{
        reference: `Task/${task.id}`,
        orderId: stored.header.orderId,
        ...(patientId ? { patientId } : {}),
        patientName: stored.header.patientName,
        lab: stored.header.lab,
        frame: [stored.frame?.brand, stored.frame?.model].filter(Boolean).join(" ") || "No frame",
        lenses: [stored.lensSpec.lensDesign, stored.lensSpec.lensMaterial].filter(Boolean).join(" · ") || "Lens specification unavailable",
        ...(frameSource !== undefined ? { frameSource } : {}),
        frameSourceLabel: frameSource === undefined ? "FSRC unavailable" : LAB_ORDER_FRAME_SOURCE_LABELS[frameSource],
        ...(stored.frameOwnership ? { frameOwnership: stored.frameOwnership } : {}),
        status: record.currentStatus,
        statusLabel: STATUS_LABELS[record.currentStatus],
        ...(currentEntry.notificationReason ? { notificationReason: currentEntry.notificationReason } : {}),
        enteredAt: currentEntry.enteredAt,
        ageMinutes,
        ...thresholds,
        needsAction,
        overdue,
        transportState,
        transmissionFact: transmissionFact(transportState),
        problemFlags: record.problemFlags,
        ...(openFlag ? { openFlag } : {}),
      }];
    } catch {
      unprojectableCount += 1;
      return [];
    }
  }).sort(compareBoardItems);
  const activeCount = items.length;
  return {
    items,
    counts,
    activeCount,
    unprojectableCount,
    alarms: {
      flaggedProblems: items.filter((item) => item.openFlag).length,
      atLabOverdue: items.filter((item) => isAtLabStatus(item.status) && item.overdue).length,
      transmissionFailures: items.filter((item) => item.transportState === "error").length,
      receivedNotNotified: items.filter((item) => item.status === "received").length,
    },
    rollups: {
      preLab: counts["patients-frame"] + counts["in-office-not-sent"],
      outbound: counts.outbound,
      atLab: counts["at-lab"] + counts["lenses-on-order"] + counts["frame-on-order"],
      inbound: counts.inbound + counts.received,
      notified: counts.notified,
    },
    agingConfig,
  };
}

function agingThresholds(status: LabOrderStatus, config: LabOrderAgingConfig): { warningMinutes?: number; limitMinutes?: number } {
  const day = 24 * 60;
  if (status === "outbound") return { limitMinutes: config.outboundDays * day };
  if (status === "inbound") return { limitMinutes: config.inboundDays * day };
  if (isAtLabStatus(status)) return { limitMinutes: config.atLabDays * day };
  if (status === "received") return { limitMinutes: config.receivedNotifyHours * 60 };
  if (status === "notified") return {
    warningMinutes: config.notifiedRetryDays * day,
    limitMinutes: config.notifiedFollowUpDays * day,
  };
  return {};
}

function compareBoardItems(left: LabOrderBoardItem, right: LabOrderBoardItem): number {
  const leftFlag = left.openFlag ? 0 : 1;
  const rightFlag = right.openFlag ? 0 : 1;
  if (leftFlag !== rightFlag) return leftFlag - rightFlag;
  const leftAction = left.needsAction ? 0 : 1;
  const rightAction = right.needsAction ? 0 : 1;
  return leftAction - rightAction || right.ageMinutes - left.ageMinutes || left.orderId.localeCompare(right.orderId);
}

function transmissionFact(state: LabTransportState): LabOrderBoardItem["transmissionFact"] {
  if (state === "error") return { kind: "error", label: "didn't reach lab" };
  if (state === "queued") return { kind: "none", label: "—" };
  if (state === "acknowledged" || state === "in-production" || state === "shipped") {
    return { kind: "oma", label: "OMA" };
  }
  return { kind: "manual", label: "print + mail" };
}

function storedOrderFromTask(task: Task): {
  header: { orderId: string; patientName: string; patientRef?: string; lab: string };
  lensSpec: { lensDesign?: string; lensMaterial?: string };
  frame?: { brand?: string; model?: string };
  frameSource?: LabOrderFrameSource;
  frameOwnership?: LabOrderFrameOwnership;
} {
  const raw = task.input?.find((input) => input.type.coding?.some((coding) =>
    coding.system === ODOS_LAB_ORDER_TASK_INPUT_SYSTEM && coding.code === LAB_ORDER_EXPORT_INPUT_CODE))?.valueString;
  if (!raw) throw new Error(`Task/${task.id ?? "(missing-id)"} is missing its stored lab-order export.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Task/${task.id ?? "(missing-id)"} contains invalid lab-order export JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Unsupported lab-order export envelope.");
  const envelope = parsed as { format?: unknown; version?: unknown; order?: unknown };
  if (envelope.format !== "odos-lab-order" || envelope.version !== "0" || typeof envelope.order !== "object" || envelope.order === null) {
    throw new Error("Unsupported lab-order export envelope.");
  }
  const order = envelope.order as ReturnType<typeof storedOrderFromTask>;
  if (typeof order.header?.orderId !== "string" || typeof order.header.patientName !== "string" || typeof order.header.lab !== "string") {
    throw new Error("Unsupported lab-order export payload.");
  }
  if (order.frameSource === undefined) {
    if (order.frameOwnership !== undefined) throw new Error("Unsupported lab-order export payload.");
  } else {
    assertLabOrderFrameSource(order.frameSource, order.frameOwnership);
  }
  return order;
}

function transportStateFromTask(task: Task): LabTransportState {
  const code = task.businessStatus?.coding?.find((coding) =>
    coding.system === "https://odos2020.com/fhir/CodeSystem/lab-transport-state")?.code;
  if (!code) throw new Error(`Task/${task.id ?? "(missing-id)"} is missing its lab transport state.`);
  assertLabTransportState(code);
  return code;
}

function isLabOrderStatusRecord(value: unknown): value is LabOrderStatusRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<LabOrderStatusRecord>;
  if (record.version !== 1 || typeof record.currentStatus !== "string" || !Array.isArray(record.history) || !Array.isArray(record.problemFlags)) return false;
  try {
    assertLabOrderStatus(record.currentStatus);
    for (const entry of record.history) {
      if (typeof entry !== "object" || entry === null || typeof entry.status !== "string" || typeof entry.enteredAt !== "string") return false;
      assertLabOrderStatus(entry.status);
      assertIsoInstant(entry.enteredAt, "enteredAt");
      if (entry.setBy !== undefined) {
        if (typeof entry.setBy !== "string") return false;
        assertStaffReference(entry.setBy);
      }
      if (entry.notificationReason !== undefined) {
        if (typeof entry.notificationReason !== "string" || entry.status !== "notified") return false;
        assertLabOrderNotificationReason(entry.notificationReason);
      } else if (entry.status === "notified") return false;
      if (entry.resetReason !== undefined && entry.resetReason !== "lab-breakage-remake") return false;
    }
    for (const flag of record.problemFlags) {
      if (typeof flag !== "object" || flag === null
        || typeof flag.id !== "string" || !/^flag-[A-Za-z0-9.-]+$/.test(flag.id)
        || typeof flag.reason !== "string" || typeof flag.note !== "string" || !flag.note.trim()
        || typeof flag.flaggedBy !== "string" || typeof flag.flaggedAt !== "string") return false;
      assertLabOrderProblemReason(flag.reason);
      assertStaffReference(flag.flaggedBy);
      assertIsoInstant(flag.flaggedAt, "flaggedAt");
      if ((flag.resolvedBy === undefined) !== (flag.resolvedAt === undefined)) return false;
      if (flag.resolvedBy !== undefined && flag.resolvedAt !== undefined) {
        if (typeof flag.resolvedBy !== "string" || typeof flag.resolvedAt !== "string") return false;
        assertStaffReference(flag.resolvedBy);
        assertIsoInstant(flag.resolvedAt, "resolvedAt");
      }
    }
    return record.history.length > 0 && record.history[record.history.length - 1].status === record.currentStatus;
  } catch {
    return false;
  }
}

function isAtLabStatus(status: LabOrderStatus): boolean {
  return status === "at-lab" || status === "lenses-on-order" || status === "frame-on-order";
}

function assertStaffReference(reference: string): void {
  if (!/^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]+$/.test(reference)) {
    throw new Error(`Staff reference must be a local Practitioner or PractitionerRole reference; got "${reference}".`);
  }
}

function assertIsoInstant(value: string, field: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be a valid instant.`);
}
