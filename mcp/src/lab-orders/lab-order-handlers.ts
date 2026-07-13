import type { Bundle, Resource, Task } from "@medplum/fhirtypes";
import type { OsodActorRole } from "../authz/osodAudit.js";
import { assertLabTransportState, type LabTransportState } from "../fhir/labTransportState.js";
import { assertLabOrderFrameSource, renderLabOrderSheet, type LabOrder } from "../fhir/opticalLabOrder.js";
import {
  assertLabOrderNotificationReason,
  assertLabOrderProblemReason,
  assertLabOrderStatus,
  backfilledLabOrderStatusRecord,
  flagLabOrderProblem,
  projectLabOrderBoard,
  resolveLabOrderProblem,
  setLabOrderStatus,
  type LabOrderAgingConfig,
  type LabOrderNotificationReason,
} from "../fhir/labOrderStatus.js";
import { StaffRoleServiceUnavailableError } from "../payments/payment-endpoint.js";
import {
  LAB_ORDER_TRANSMISSION_TASK_CODE,
  OSOD_LAB_ORDER_TASK_CODE_SYSTEM,
  isLabOrderTransmissionTask,
  storedLabOrderExport,
  type LabOrderFhirClient,
} from "./adapters/manual-lab-order-adapter.js";
import {
  isLabOrderVendorId,
  type LabOrderDispatch,
  type LabOrderRoutingDefaults,
  type LabOrderVendorId,
} from "./lab-order-dispatch.js";

export interface AuthenticatedLabOrderStaff {
  staffReference: string;
  actorRole: OsodActorRole;
  fhir: LabOrderFhirClient;
}

export interface LabOrderHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedLabOrderStaff | null>;
  dispatch: LabOrderDispatch;
  routingDefaults?: LabOrderRoutingDefaults;
  now?: () => string;
  agingConfig?: LabOrderAgingConfig;
}

export interface LabOrderHandlerResult {
  status: number;
  body: unknown;
}

export async function handleSubmitLabOrderRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  const body = objectBody(input.body);
  if ("error" in body) return badRequest(body.error);
  if (!isLabOrder(body.value.order)) return badRequest("A valid LabOrder payload is required.");
  if (!localTaskReference(body.value.orderTaskReference)) {
    return badRequest('orderTaskReference must be a local "Task/<id>" reference.');
  }
  const lab = stringValue(body.value.lab);
  if (!lab) return badRequest("A non-empty lab is required.");
  const vendor = requestedVendor(body.value.vendor, deps.routingDefaults);
  if ("error" in vendor) return badRequest(vendor.error);

  try {
    const adapter = deps.dispatch.getAdapter(vendor.value, authenticated.staff.fhir);
    const result = await adapter.submit({
      order: body.value.order,
      orderTaskReference: body.value.orderTaskReference as string,
      staffReference: authenticated.staff.staffReference,
      lab,
    });
    return { status: 200, body: result };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export async function handleAdvanceLabOrderRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; labOrderReference: string; body: unknown },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  const body = objectBody(input.body);
  if ("error" in body) return badRequest(body.error);
  if (!localTaskReference(input.labOrderReference)) return badRequest('Lab order reference must be a local "Task/<id>" reference.');
  if (typeof body.value.toState !== "string") return badRequest("A lab transport toState is required.");
  try {
    assertLabTransportState(body.value.toState);
  } catch (error) {
    return badRequest(messageOf(error));
  }
  const vendor = requestedVendor(body.value.vendor, deps.routingDefaults);
  if ("error" in vendor) return badRequest(vendor.error);
  try {
    const state = await deps.dispatch.getAdapter(vendor.value, authenticated.staff.fhir).advanceTransportState({
      labOrderReference: input.labOrderReference,
      toState: body.value.toState,
      staffReference: authenticated.staff.staffReference,
      ...(stringValue(body.value.note) ? { note: stringValue(body.value.note)! } : {}),
    });
    return { status: 200, body: { transportState: state } };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export async function handleCancelLabOrderRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; labOrderReference: string; body: unknown },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  const body = objectBody(input.body);
  if ("error" in body) return badRequest(body.error);
  if (!localTaskReference(input.labOrderReference)) return badRequest('Lab order reference must be a local "Task/<id>" reference.');
  const vendor = requestedVendor(body.value.vendor, deps.routingDefaults);
  if ("error" in vendor) return badRequest(vendor.error);
  try {
    await deps.dispatch.getAdapter(vendor.value, authenticated.staff.fhir)
      .cancel(input.labOrderReference, authenticated.staff.staffReference);
    return { status: 200, body: { transportState: "cancelled" } };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export async function handleSetLabOrderStatusRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; labOrderReference: string; body: unknown },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  const taskId = localTaskReference(input.labOrderReference);
  if (!taskId) return badRequest('Lab order reference must be a local "Task/<id>" reference.');
  const body = objectBody(input.body);
  if ("error" in body) return badRequest(body.error);
  if (typeof body.value.status !== "string") return badRequest("A lab-order status is required.");
  try {
    const status = body.value.status;
    assertLabOrderStatus(status);
    let notificationReason: LabOrderNotificationReason | undefined;
    if (body.value.notificationReason !== undefined) {
      if (typeof body.value.notificationReason !== "string") return badRequest("Notification reason must be a string.");
      assertLabOrderNotificationReason(body.value.notificationReason);
      notificationReason = body.value.notificationReason;
    }
    const enteredAt = now(deps);
    await updateLabOrderWithRetry(
      authenticated.staff.fhir,
      taskId,
      input.labOrderReference,
      (task) => setLabOrderStatus(
        task,
        status,
        enteredAt,
        authenticated.staff.staffReference,
        notificationReason,
      ),
    );
    return { status: 200, body: { status, enteredAt, ...(notificationReason ? { notificationReason } : {}) } };
  } catch (error) {
    if (error instanceof LabOrderVersionConflictError) return conflict(error.message);
    return badRequest(messageOf(error));
  }
}

export async function handleFlagLabOrderProblemRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; labOrderReference: string; body: unknown },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  const taskId = localTaskReference(input.labOrderReference);
  if (!taskId) return badRequest('Lab order reference must be a local "Task/<id>" reference.');
  const body = objectBody(input.body);
  if ("error" in body) return badRequest(body.error);
  if (typeof body.value.reason !== "string") return badRequest("A problem reason is required.");
  const note = stringValue(body.value.note);
  if (!note) return badRequest("A problem note is required.");
  try {
    const reason = body.value.reason;
    assertLabOrderProblemReason(reason);
    const flaggedAt = now(deps);
    const updated = await updateLabOrderWithRetry(
      authenticated.staff.fhir,
      taskId,
      input.labOrderReference,
      (task) => flagLabOrderProblem(task, {
        reason,
        note,
        flaggedBy: authenticated.staff.staffReference,
        flaggedAt,
      }),
    );
    const record = backfilledLabOrderStatusRecord(updated);
    return { status: 200, body: { flag: record.problemFlags[record.problemFlags.length - 1] } };
  } catch (error) {
    if (error instanceof LabOrderVersionConflictError) return conflict(error.message);
    return badRequest(messageOf(error));
  }
}

export async function handleResolveLabOrderProblemRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; labOrderReference: string; flagId: string },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  const taskId = localTaskReference(input.labOrderReference);
  if (!taskId) return badRequest('Lab order reference must be a local "Task/<id>" reference.');
  if (!/^flag-[A-Za-z0-9.-]+$/.test(input.flagId)) return badRequest("A valid problem flag id is required.");
  try {
    const resolvedAt = now(deps);
    await updateLabOrderWithRetry(
      authenticated.staff.fhir,
      taskId,
      input.labOrderReference,
      (task) => resolveLabOrderProblem(task, {
        flagId: input.flagId,
        resolvedBy: authenticated.staff.staffReference,
        resolvedAt,
      }),
    );
    return { status: 200, body: { flagId: input.flagId, resolvedAt } };
  } catch (error) {
    if (error instanceof LabOrderVersionConflictError) return conflict(error.message);
    return badRequest(messageOf(error));
  }
}

export async function handleLabOrderStateRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; labOrderReference: string; vendor?: unknown },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  if (!localTaskReference(input.labOrderReference)) return badRequest('Lab order reference must be a local "Task/<id>" reference.');
  const vendor = requestedVendor(input.vendor, deps.routingDefaults);
  if ("error" in vendor) return badRequest(vendor.error);
  try {
    const state = await deps.dispatch.getAdapter(vendor.value, authenticated.staff.fhir)
      .getTransportState(input.labOrderReference);
    return { status: 200, body: { transportState: state } };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export async function handleLabOrderSheetRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; labOrderReference: string },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  const id = localTaskReference(input.labOrderReference);
  if (!id) return badRequest('Lab order reference must be a local "Task/<id>" reference.');
  try {
    const task = await authenticated.staff.fhir.read<Task>("Task", id);
    const stored = storedLabOrderExport(task);
    return {
      status: 200,
      body: { kind: "html-sheet", content: renderLabOrderSheet(stored.order) },
    };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

export async function handleLabOrderWorklistRequest(
  deps: LabOrderHandlerDeps,
  input: { authHeader: string | undefined; state?: unknown },
): Promise<LabOrderHandlerResult> {
  const authenticated = await authenticate(deps, input.authHeader);
  if ("result" in authenticated) return authenticated.result;
  let state: string | undefined;
  if (input.state !== undefined) {
    if (typeof input.state !== "string") return badRequest("Lab-order status filter must be a string.");
    try {
      assertLabOrderStatus(input.state);
      state = input.state;
    } catch (error) {
      return badRequest(messageOf(error));
    }
  }
  try {
    const bundle = await authenticated.staff.fhir.search<Task>("Task", {
      code: `${OSOD_LAB_ORDER_TASK_CODE_SYSTEM}|${LAB_ORDER_TRANSMISSION_TASK_CODE}`,
      _count: "1000",
      _sort: "-authored-on",
    });
    if (bundle.link?.some((link) => link.relation === "next")) {
      return badRequest("Lab-order worklist exceeded one FHIR page; no partial worklist was returned.");
    }
    const tasks = resources(bundle).filter(isLabOrderTransmissionTask);
    const board = projectLabOrderBoard(tasks, now(deps), deps.agingConfig);
    return {
      status: 200,
      body: state === undefined ? board : { ...board, items: board.items.filter((item) => item.status === state) },
    };
  } catch (error) {
    return badRequest(messageOf(error));
  }
}

class LabOrderVersionConflictError extends Error {}

async function updateLabOrderWithRetry(
  fhir: LabOrderFhirClient,
  taskId: string,
  labOrderReference: string,
  mutate: (task: Task) => Task,
): Promise<Task> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const task = await fhir.read<Task>("Task", taskId);
    if (!isLabOrderTransmissionTask(task)) {
      throw new Error(`${labOrderReference} is not a lab-order transmission Task.`);
    }
    const versionId = task.meta?.versionId;
    if (!versionId) {
      throw new LabOrderVersionConflictError(`${labOrderReference} has no FHIR version; reload and retry.`);
    }
    const updated = mutate(task);
    try {
      return await fhir.update<Task>(
        "Task",
        taskId,
        updated,
        { "If-Match": `W/"${versionId}"` },
      );
    } catch (error) {
      if (!isVersionConflict(error)) throw error;
      if (attempt === 1) {
        throw new LabOrderVersionConflictError(`${labOrderReference} was modified concurrently; reload and retry.`);
      }
    }
  }
  throw new LabOrderVersionConflictError(`${labOrderReference} was modified concurrently; reload and retry.`);
}

async function authenticate(
  deps: LabOrderHandlerDeps,
  authHeader: string | undefined,
): Promise<{ staff: AuthenticatedLabOrderStaff } | { result: LabOrderHandlerResult }> {
  try {
    const staff = await deps.authenticate(authHeader);
    if (!staff) return { result: { status: 401, body: { error: "Authentication required to manage lab orders." } } };
    return { staff };
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { result: { status: 503, body: { error: "Lab-order service temporarily unavailable." } } };
    }
    throw error;
  }
}

function requestedVendor(
  value: unknown,
  defaults: LabOrderRoutingDefaults = {},
): { value: LabOrderVendorId } | { error: string } {
  const candidate = value ?? defaults.vendor ?? "manual";
  return isLabOrderVendorId(candidate)
    ? { value: candidate }
    : { error: `Lab-order vendor must be ${defaults.vendor ?? "manual"}.` };
}

function objectBody(value: unknown): { value: Record<string, unknown> } | { error: string } {
  return typeof value === "object" && value !== null
    ? { value: value as Record<string, unknown> }
    : { error: "Request body must be a JSON object." };
}

function isLabOrder(value: unknown): value is LabOrder {
  if (typeof value !== "object" || value === null) return false;
  const order = value as Partial<LabOrder>;
  if (!(typeof order.header?.orderId === "string"
    && typeof order.header.lab === "string"
    && typeof order.header.patientName === "string"
    && typeof order.rx === "object"
    && typeof order.lensSpec === "object"
    && typeof order.frameSource === "number")) return false;
  try {
    assertLabOrderFrameSource(order.frameSource, order.frameOwnership);
    return true;
  } catch {
    return false;
  }
}

function localTaskReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.match(/^Task\/([A-Za-z0-9.-]+)$/)?.[1];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function badRequest(error: string): LabOrderHandlerResult {
  return { status: 400, body: { error } };
}

function conflict(error: string): LabOrderHandlerResult {
  return { status: 409, body: { error } };
}

function isVersionConflict(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 409 || status === 412 || /FHIR (409|412)\b/.test(messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(deps: LabOrderHandlerDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}
