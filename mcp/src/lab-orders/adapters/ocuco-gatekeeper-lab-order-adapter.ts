import type { Bundle, Resource, Task } from "@medplum/fhirtypes";
import {
  buildOdosAuditEventRow,
  type OdosAuditEventRecord,
} from "../../authz/odosAudit.js";
import {
  assertLabTransportState,
  canTransitionLabTransportState,
  isTerminalLabTransportState,
  labTransportStateConcept,
  type LabTransportState,
} from "../../fhir/labTransportState.js";
import { labOrderToExport } from "../../fhir/opticalLabOrder.js";
import {
  LAB_ORDER_EXPORT_INPUT_CODE,
  ODOS_LAB_ORDER_TASK_INPUT_SYSTEM,
  withLabOrderStatusRecord,
  type LabOrderStatus,
} from "../../fhir/labOrderStatus.js";
import {
  isOcucoGatekeeperConfigured,
  type OcucoGatekeeperConfig,
} from "../../integrations/ocuco-gatekeeper/config.js";
import {
  labOrderCancellationToHashref,
  labOrderToHashref,
} from "../../integrations/ocuco-gatekeeper/hashrefSerializer.js";
import type { OcucoGatekeeperClient } from "../../integrations/ocuco-gatekeeper/ocucoGatekeeperClient.js";
import type {
  AdvanceLabTransportRequest,
  LabOrderAdapter,
  LabOrderSubmissionResult,
  SubmitLabOrderRequest,
} from "../lab-order-adapter.js";
import {
  LAB_ORDER_TRANSMISSION_TASK_CODE,
  ODOS_LAB_ORDER_TASK_CODE_SYSTEM,
  isLabOrderTransmissionTask,
  storedLabOrderExport,
  taskStatusForLabTransportState,
  transportStateFromTask,
  type LabOrderFhirClient,
} from "./manual-lab-order-adapter.js";

export const ODOS_OCUCO_ORDER_ID_SYSTEM = "https://odos2020.com/fhir/NamingSystem/ocuco-order-id";

export interface OcucoGatekeeperLabOrderAdapterOptions {
  now?: () => string;
  recordAudit: ((row: OdosAuditEventRecord) => Promise<void>) | undefined;
}

export function createOcucoGatekeeperLabOrderAdapter(
  fhir: LabOrderFhirClient,
  config: OcucoGatekeeperConfig,
  client: OcucoGatekeeperClient,
  options: OcucoGatekeeperLabOrderAdapterOptions,
): LabOrderAdapter {
  if (!options?.recordAudit) {
    throw new Error("Ocuco lab-order adapter recordAudit is required.");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const recordAudit = options.recordAudit;

  async function emitAudit(input: {
    eventType: "create" | "update";
    at: string;
    staffReference: string;
    targetReference: string;
    reason: string;
  }): Promise<void> {
    const row = buildOdosAuditEventRow({
      eventType: input.eventType,
      eventTime: input.at,
      actorReference: input.staffReference,
      targetReference: input.targetReference,
      actionOutcome: "granted",
      actionReason: input.reason,
    });
    await recordAudit(row);
  }

  async function updateState(
    req: AdvanceLabTransportRequest,
    allowCancellation = false,
  ): Promise<LabTransportState> {
    const taskId = taskIdFromReference(req.labOrderReference, "labOrderReference");
    assertStaffReference(req.staffReference);
    assertLabTransportState(req.toState);
    const current = await fhir.read<Task>("Task", taskId);
    assertTransmissionTask(current, req.labOrderReference);
    const from = transportStateFromTask(current);
    if (isTerminalLabTransportState(from)) {
      throw new Error(`Lab transport state "${from}" is terminal; cannot advance to "${req.toState}".`);
    }
    const cancellable = allowCancellation && req.toState === "cancelled";
    if (!cancellable && !canTransitionLabTransportState(from, req.toState)) {
      throw new Error(`Cannot advance Ocuco lab transport from "${from}" to "${req.toState}"; illegal transition.`);
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
    vendorId: "ocuco-gatekeeper",
    name: "Ocuco Gatekeeper (BP Digital Labs)",
    vendorApiRequired: true,

    async submit(req: SubmitLabOrderRequest): Promise<LabOrderSubmissionResult> {
      assertConfigured(config);
      const orderTaskId = taskIdFromReference(req.orderTaskReference, "orderTaskReference");
      assertStaffReference(req.staffReference);
      if (!req.lab.trim()) throw new Error("Ocuco lab order submission requires a non-empty lab.");
      const clinicalOrder = await fhir.read<Task>("Task", orderTaskId);
      const existing = await fhir.search<Task>("Task", {
        "based-on": req.orderTaskReference,
        code: `${ODOS_LAB_ORDER_TASK_CODE_SYSTEM}|${LAB_ORDER_TRANSMISSION_TASK_CODE}`,
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

      const session = await client.authenticate(config);
      const contract = await client.getContract(session.authToken, config);
      const hashrefBody = labOrderToHashref(req.order, contract);
      await client.pushOrderToLab(session.authToken, {
        hashRoutingKey: contract.hashRoutingKey,
        hashrefBody,
      }, config);

      const submittedAt = now();
      const initialStatus: LabOrderStatus = req.order.frameSource === 0 || req.order.frameSource === 1
        ? "at-lab"
        : "in-office-not-sent";
      const transmission = await fhir.create<Task>(withLabOrderStatusRecord({
        resourceType: "Task",
        status: taskStatusForLabTransportState("sent"),
        intent: "order",
        code: {
          coding: [{
            system: ODOS_LAB_ORDER_TASK_CODE_SYSTEM,
            code: LAB_ORDER_TRANSMISSION_TASK_CODE,
            display: "Lab Order Transmission",
          }],
          text: "Lab Order Transmission",
        },
        businessStatus: labTransportStateConcept("sent"),
        identifier: [{ system: ODOS_OCUCO_ORDER_ID_SYSTEM, value: req.order.header.orderId }],
        basedOn: [{ reference: req.orderTaskReference }],
        ...(clinicalOrder.for ? { for: clinicalOrder.for } : {}),
        description: `Ocuco Gatekeeper lab order to ${req.lab.trim()}`,
        authoredOn: submittedAt,
        lastModified: submittedAt,
        input: [{
          type: {
            coding: [{
              system: ODOS_LAB_ORDER_TASK_INPUT_SYSTEM,
              code: LAB_ORDER_EXPORT_INPUT_CODE,
              display: "Lab Order Export",
            }],
            text: "Lab Order Export",
          },
          valueString: JSON.stringify(labOrderToExport(req.order)),
        }],
      }, {
        version: 1,
        currentStatus: initialStatus,
        history: [{ status: initialStatus, enteredAt: submittedAt, setBy: req.staffReference }],
        problemFlags: [],
      }));
      if (!transmission.id) throw new Error("FHIR create returned a lab transmission Task without an id.");
      const labOrderReference = `Task/${transmission.id}`;
      await emitAudit({
        eventType: "create",
        at: submittedAt,
        staffReference: req.staffReference,
        targetReference: labOrderReference,
        reason: `lab-order.submit:ocuco-gatekeeper:${req.lab.trim()}`,
      });
      return {
        labOrderReference,
        transportState: "sent",
        transmittedVia: "api",
        submittedAt,
      };
    },

    async getTransportState(labOrderReference: string): Promise<LabTransportState> {
      const id = taskIdFromReference(labOrderReference, "labOrderReference");
      const task = await fhir.read<Task>("Task", id);
      assertTransmissionTask(task, labOrderReference);
      return transportStateFromTask(task);
    },

    async advanceTransportState(req: AdvanceLabTransportRequest): Promise<LabTransportState> {
      if (req.toState === "cancelled") {
        throw new Error("Ocuco cancellation must use cancel() to notify Ocuco before updating the local Task.");
      }
      return updateState(req);
    },

    async cancel(labOrderReference: string, staffReference: string): Promise<void> {
      assertConfigured(config);
      const taskId = taskIdFromReference(labOrderReference, "labOrderReference");
      assertStaffReference(staffReference);
      const task = await fhir.read<Task>("Task", taskId);
      const stored = storedLabOrderExport(task);
      const originalOrderId = stored.order.header?.orderId;
      if (typeof originalOrderId !== "string" || !originalOrderId.trim()) {
        throw new Error("Ocuco cancellation cannot recover the original order_id from the stored transmission Task.");
      }
      const session = await client.authenticate(config);
      const contract = await client.getContract(session.authToken, config);
      await client.pushOrderToLab(session.authToken, {
        hashRoutingKey: contract.hashRoutingKey,
        hashrefBody: labOrderCancellationToHashref(stored.order, contract, originalOrderId),
      }, config);
      await updateState({ labOrderReference, staffReference, toState: "cancelled" }, true);
    },
  };
}

function assertConfigured(config: OcucoGatekeeperConfig): void {
  if (!isOcucoGatekeeperConfigured(config)) {
    throw new Error("Ocuco Gatekeeper is not configured — see OCUCO_GATEKEEPER_* env vars");
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

function assertTransmissionTask(task: Task, reference: string): void {
  if (!isLabOrderTransmissionTask(task)) throw new Error(`${reference} is not a lab-order transmission Task.`);
}

function resources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}
