import type { Bundle, BundleEntry, Task } from "@medplum/fhirtypes";
import type { MedplumClient } from "./fhir-client.js";
import {
  assembleOpticalCashOrder,
  type AssembleOpticalCashOrderInput,
} from "./fhir/opticalOrderComposite.js";
import {
  ODOS_OPTICAL_ORDER_STATUS_SYSTEM,
  assertOpticalOrderStatus,
  opticalOrderStatusConcept,
  type OpticalOrderStatusCode,
} from "./fhir/opticalOrderStatus.js";

export interface CreatedOpticalCashOrderIds {
  deviceRequestId: string;
  taskId: string;
  chargeItemIds: string[];
  invoiceId: string;
}

export async function createOpticalCashOrder(
  fhir: Pick<MedplumClient, "executeTransaction">,
  input: AssembleOpticalCashOrderInput,
): Promise<CreatedOpticalCashOrderIds> {
  const requestBundle = assembleOpticalCashOrder(input);
  const responseBundle = await fhir.executeTransaction(requestBundle);
  const created = createdIdsByRequestResourceType(requestBundle, responseBundle);
  return {
    deviceRequestId: oneCreatedId(created, "DeviceRequest"),
    taskId: oneCreatedId(created, "Task"),
    chargeItemIds: created.get("ChargeItem") ?? [],
    invoiceId: oneCreatedId(created, "Invoice"),
  };
}

export function canTransitionOpticalOrderStatus(from: string, to: string): boolean {
  assertOpticalOrderStatus(from);
  assertOpticalOrderStatus(to);
  return from === to || from !== "cancelled";
}

export async function transitionOpticalOrderStatus(
  fhir: Pick<MedplumClient, "read" | "update">,
  taskId: string,
  toStatus: string,
): Promise<Task> {
  assertOpticalOrderStatus(toStatus);
  const current = await fhir.read<Task>("Task", taskId);
  const fromStatus = currentOpticalBusinessStatus(current);
  if (!canTransitionOpticalOrderStatus(fromStatus, toStatus)) {
    throw new Error(`Optical order status "${fromStatus}" is terminal; cannot transition to "${toStatus}".`);
  }
  return updateOpticalOrderTask(fhir, taskId, {
    ...current,
    businessStatus: opticalOrderStatusConcept(toStatus),
    status: fhirTaskStatusForOpticalStatus(toStatus),
  });
}

export async function updateOpticalOrderTask(
  fhir: Pick<MedplumClient, "read" | "update">,
  taskId: string,
  next: Task,
): Promise<Task> {
  const current = await fhir.read<Task>("Task", taskId);
  if (codeableConceptFingerprint(current.code) !== codeableConceptFingerprint(next.code)) {
    throw new Error("Order Type is immutable after create; Task.code cannot be changed.");
  }
  return fhir.update<Task>("Task", taskId, next);
}

function currentOpticalBusinessStatus(task: Task): OpticalOrderStatusCode {
  const code = task.businessStatus?.coding?.find(
    (coding) => coding.system === ODOS_OPTICAL_ORDER_STATUS_SYSTEM,
  )?.code;
  if (!code) {
    throw new Error("Optical order Task is missing a Task.businessStatus optical order status.");
  }
  assertOpticalOrderStatus(code);
  return code;
}

function fhirTaskStatusForOpticalStatus(status: OpticalOrderStatusCode): Task["status"] {
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "dispensed") {
    return "completed";
  }
  return "in-progress";
}

function createdIdsByRequestResourceType(
  requestBundle: Bundle,
  responseBundle: Bundle,
): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const requestEntries = requestBundle.entry ?? [];
  const responseEntries = responseBundle.entry ?? [];

  requestEntries.forEach((requestEntry, index) => {
    const resourceType = requestEntry.resource?.resourceType;
    const id = idFromTransactionResponseEntry(responseEntries[index]);
    if (!resourceType || !id) {
      return;
    }
    const ids = byType.get(resourceType) ?? [];
    ids.push(id);
    byType.set(resourceType, ids);
  });

  return byType;
}

function idFromTransactionResponseEntry(entry: BundleEntry | undefined): string | undefined {
  const location = entry?.response?.location;
  const match = location?.match(/^[A-Za-z]+\/([^/]+)/);
  return match?.[1];
}

function oneCreatedId(created: Map<string, string[]>, resourceType: string): string {
  const ids = created.get(resourceType) ?? [];
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one created ${resourceType}; got ${ids.length}.`);
  }
  return ids[0];
}

function codeableConceptFingerprint(value: Task["code"]): string {
  return JSON.stringify(value ?? null);
}
