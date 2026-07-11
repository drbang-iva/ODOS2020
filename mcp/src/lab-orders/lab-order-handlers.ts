import type { Bundle, Resource, Task } from "@medplum/fhirtypes";
import type { OsodActorRole } from "../authz/osodAudit.js";
import { assertLabTransportState, type LabTransportState } from "../fhir/labTransportState.js";
import { renderLabOrderSheet, type LabOrder } from "../fhir/opticalLabOrder.js";
import { StaffRoleServiceUnavailableError } from "../payments/payment-endpoint.js";
import {
  LAB_ORDER_TRANSMISSION_TASK_CODE,
  OSOD_LAB_ORDER_TASK_CODE_SYSTEM,
  isLabOrderTransmissionTask,
  storedLabOrderExport,
  transportStateFromTask,
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
  let state: LabTransportState | undefined;
  if (input.state !== undefined) {
    if (typeof input.state !== "string") return badRequest("Lab transport state filter must be a string.");
    try {
      assertLabTransportState(input.state);
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
    const items = resources(bundle)
      .filter(isLabOrderTransmissionTask)
      .filter((task) => state === undefined || transportStateFromTask(task) === state);
    return { status: 200, body: { items } };
  } catch (error) {
    return badRequest(messageOf(error));
  }
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
  return typeof order.header?.orderId === "string"
    && typeof order.header.lab === "string"
    && typeof order.header.patientName === "string"
    && typeof order.rx === "object"
    && typeof order.lensSpec === "object";
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
