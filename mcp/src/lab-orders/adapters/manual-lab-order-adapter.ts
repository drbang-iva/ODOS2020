import type { AuditEvent, Bundle, Resource, Task } from "@medplum/fhirtypes";
import {
  buildAuditEventProjection,
  buildOsodAuditEventRow,
  type OsodAuditEventRecord,
} from "../../authz/osodAudit.js";
import {
  OSOD_LAB_TRANSPORT_STATE_SYSTEM,
  assertLabTransportState,
  canTransitionLabTransportState,
  isTerminalLabTransportState,
  labTransportStateConcept,
  type LabTransportState,
} from "../../fhir/labTransportState.js";
import { labOrderToExport, renderLabOrderSheet } from "../../fhir/opticalLabOrder.js";
import type {
  AdvanceLabTransportRequest,
  LabOrderAdapter,
  LabOrderSubmissionResult,
  SubmitLabOrderRequest,
} from "../lab-order-adapter.js";

export const OSOD_LAB_ORDER_TASK_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/task-type";
export const LAB_ORDER_TRANSMISSION_TASK_CODE = "lab-order-transmission";
export const OSOD_LAB_ORDER_TASK_INPUT_SYSTEM = "https://osod.dev/fhir/CodeSystem/lab-order-task-input";
export const LAB_ORDER_EXPORT_INPUT_CODE = "lab-order-export";

export type LabOrderFhirClient = {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T): Promise<T>;
  update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T>;
};

export interface ManualLabOrderAdapterOptions {
  now?: () => string;
  recordAudit?(row: OsodAuditEventRecord): Promise<void>;
}

const VENDOR_ONLY_STATES: readonly LabTransportState[] = ["acknowledged", "in-production", "shipped"];

export function createManualLabOrderAdapter(
  fhir: LabOrderFhirClient,
  options: ManualLabOrderAdapterOptions = {},
): LabOrderAdapter {
  const now = options.now ?? (() => new Date().toISOString());

  async function emitAudit(input: {
    eventType: "create" | "update";
    at: string;
    staffReference: string;
    targetReference: string;
    reason: string;
  }): Promise<void> {
    const row = buildOsodAuditEventRow({
      eventType: input.eventType,
      eventTime: input.at,
      actorReference: input.staffReference,
      targetReference: input.targetReference,
      actionOutcome: "granted",
      actionReason: input.reason,
    });
    if (options.recordAudit) {
      await options.recordAudit(row);
      return;
    }
    await fhir.create<AuditEvent>(buildAuditEventProjection(row));
  }

  async function updateState(
    req: AdvanceLabTransportRequest,
    allowNonTerminalCancellation = false,
  ): Promise<LabTransportState> {
    const taskId = taskIdFromReference(req.labOrderReference, "labOrderReference");
    assertStaffReference(req.staffReference);
    assertLabTransportState(req.toState);
    if (VENDOR_ONLY_STATES.includes(req.toState)) {
      throw new Error(`Lab transport state "${req.toState}" is not applicable in manual mode.`);
    }
    const current = await fhir.read<Task>("Task", taskId);
    assertLabOrderTransmissionTask(current, req.labOrderReference);
    const from = transportStateFromTask(current);
    if (isTerminalLabTransportState(from)) {
      throw new Error(`Lab transport state "${from}" is terminal; cannot advance to "${req.toState}".`);
    }
    const cancellable = allowNonTerminalCancellation && req.toState === "cancelled";
    if (!cancellable && !canTransitionLabTransportState(from, req.toState)) {
      throw new Error(`Cannot advance manual lab transport from "${from}" to "${req.toState}"; illegal transition.`);
    }

    const changedAt = now();
    const updated: Task = {
      ...current,
      status: taskStatusForLabTransportState(req.toState),
      businessStatus: labTransportStateConcept(req.toState),
      lastModified: changedAt,
      ...(req.note ? { note: [...(current.note ?? []), { text: req.note, time: changedAt }] } : {}),
    };
    await fhir.update<Task>("Task", taskId, updated);
    await emitAudit({
      eventType: "update",
      at: changedAt,
      staffReference: req.staffReference,
      targetReference: req.labOrderReference,
      reason: `lab-order.transport:${from}->${req.toState}`,
    });
    return req.toState;
  }

  return {
    vendorId: "manual",
    name: "manual-lab-order",
    vendorApiRequired: false,

    async submit(req: SubmitLabOrderRequest): Promise<LabOrderSubmissionResult> {
      const orderTaskId = taskIdFromReference(req.orderTaskReference, "orderTaskReference");
      assertStaffReference(req.staffReference);
      if (!req.lab.trim()) {
        throw new Error("Manual lab order submission requires a non-empty lab.");
      }
      const clinicalOrder = await fhir.read<Task>("Task", orderTaskId);
      const existing = await fhir.search<Task>("Task", {
        "based-on": req.orderTaskReference,
        code: `${OSOD_LAB_ORDER_TASK_CODE_SYSTEM}|${LAB_ORDER_TRANSMISSION_TASK_CODE}`,
        _count: "1000",
      });
      if (existing.link?.some((link) => link.relation === "next")) {
        throw new Error("Lab transmission search exceeded one FHIR page; cannot safely enforce the double-submit guard.");
      }
      const alreadyActive = resources(existing).some((task) =>
        isLabOrderTransmissionTask(task)
        && task.basedOn?.some((reference) => reference.reference === req.orderTaskReference)
        && !isTerminalLabTransportState(transportStateFromTask(task)));
      if (alreadyActive) {
        throw new Error(`${req.orderTaskReference} is already transmitted through an active lab transmission Task.`);
      }

      const submittedAt = now();
      const transmission = await fhir.create<Task>({
        resourceType: "Task",
        status: taskStatusForLabTransportState("sent"),
        intent: "order",
        code: {
          coding: [{
            system: OSOD_LAB_ORDER_TASK_CODE_SYSTEM,
            code: LAB_ORDER_TRANSMISSION_TASK_CODE,
            display: "Lab Order Transmission",
          }],
          text: "Lab Order Transmission",
        },
        businessStatus: labTransportStateConcept("sent"),
        basedOn: [{ reference: req.orderTaskReference }],
        ...(clinicalOrder.for ? { for: clinicalOrder.for } : {}),
        description: `Manual lab order to ${req.lab.trim()}`,
        authoredOn: submittedAt,
        lastModified: submittedAt,
        input: [{
          type: {
            coding: [{
              system: OSOD_LAB_ORDER_TASK_INPUT_SYSTEM,
              code: LAB_ORDER_EXPORT_INPUT_CODE,
              display: "Lab Order Export",
            }],
            text: "Lab Order Export",
          },
          valueString: JSON.stringify(labOrderToExport(req.order)),
        }],
      });
      if (!transmission.id) {
        throw new Error("FHIR create returned a lab transmission Task without an id.");
      }
      const labOrderReference = `Task/${transmission.id}`;
      await emitAudit({
        eventType: "create",
        at: submittedAt,
        staffReference: req.staffReference,
        targetReference: labOrderReference,
        reason: `lab-order.submit:manual:${req.lab.trim()}`,
      });
      return {
        labOrderReference,
        transportState: "sent",
        transmittedVia: "manual",
        artifact: { kind: "html-sheet", content: renderLabOrderSheet(req.order) },
        submittedAt,
      };
    },

    async getTransportState(labOrderReference: string): Promise<LabTransportState> {
      const id = taskIdFromReference(labOrderReference, "labOrderReference");
      const task = await fhir.read<Task>("Task", id);
      assertLabOrderTransmissionTask(task, labOrderReference);
      return transportStateFromTask(task);
    },

    advanceTransportState(req: AdvanceLabTransportRequest): Promise<LabTransportState> {
      return updateState(req);
    },

    async cancel(labOrderReference: string, staffReference: string): Promise<void> {
      await updateState({ labOrderReference, staffReference, toState: "cancelled" }, true);
    },
  };
}

export function storedLabOrderExport(task: Task): ReturnType<typeof labOrderToExport> {
  assertLabOrderTransmissionTask(task, task.id ? `Task/${task.id}` : "Task/(missing-id)");
  const value = task.input?.find((input) => input.type.coding?.some((coding) =>
    coding.system === OSOD_LAB_ORDER_TASK_INPUT_SYSTEM && coding.code === LAB_ORDER_EXPORT_INPUT_CODE))?.valueString;
  if (!value) throw new Error("Lab transmission Task is missing its stored lab-order export.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Lab transmission Task contains invalid lab-order export JSON.");
  }
  if (!isStoredLabOrderExport(parsed)) {
    throw new Error("Lab transmission Task contains an unsupported lab-order export envelope.");
  }
  return parsed;
}

export function isLabOrderTransmissionTask(task: Task): boolean {
  return task.code?.coding?.some((coding) =>
    coding.system === OSOD_LAB_ORDER_TASK_CODE_SYSTEM && coding.code === LAB_ORDER_TRANSMISSION_TASK_CODE) ?? false;
}

export function transportStateFromTask(task: Task): LabTransportState {
  const code = task.businessStatus?.coding?.find((coding) =>
    coding.system === OSOD_LAB_TRANSPORT_STATE_SYSTEM)?.code;
  if (!code) throw new Error("Lab transmission Task is missing its lab transport businessStatus.");
  assertLabTransportState(code);
  return code;
}

function assertLabOrderTransmissionTask(task: Task, reference: string): void {
  if (!isLabOrderTransmissionTask(task)) {
    throw new Error(`${reference} is not a lab-order transmission Task.`);
  }
}

export function taskStatusForLabTransportState(state: LabTransportState): Task["status"] {
  switch (state) {
    case "queued": return "requested";
    case "received": return "completed";
    case "cancelled": return "cancelled";
    case "error": return "failed";
    default: return "in-progress";
  }
}

function taskIdFromReference(reference: string, field: string): string {
  const match = reference?.match(/^Task\/([A-Za-z0-9.-]+)$/);
  if (!match) throw new Error(`${field} must be a local "Task/<id>" reference; got "${reference}".`);
  return match[1];
}

function assertStaffReference(reference: string): void {
  if (!/^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]+$/.test(reference ?? "")) {
    throw new Error(`staffReference must be a local "Practitioner/<id>" or "PractitionerRole/<id>" reference; got "${reference}".`);
  }
}

function resources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function isStoredLabOrderExport(value: unknown): value is ReturnType<typeof labOrderToExport> {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return envelope.format === "osod-lab-order"
    && envelope.version === "0"
    && typeof envelope.order === "object"
    && envelope.order !== null;
}
