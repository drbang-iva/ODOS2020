import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Basic, Bundle, Resource, Task } from "@medplum/fhirtypes";
import express from "express";
import { labTransportStateConcept, type LabTransportState } from "../src/fhir/labTransportState.js";
import { labOrderToExport, type LabOrder } from "../src/fhir/opticalLabOrder.js";
import { backfilledLabOrderStatusRecord, flagLabOrderProblem } from "../src/fhir/labOrderStatus.js";
import {
  LAB_ORDER_EXPORT_INPUT_CODE,
  LAB_ORDER_TRANSMISSION_TASK_CODE,
  ODOS_LAB_ORDER_TASK_INPUT_SYSTEM,
  ODOS_LAB_ORDER_TASK_CODE_SYSTEM,
} from "../src/lab-orders/adapters/manual-lab-order-adapter.js";
import type { LabOrderAdapter } from "../src/lab-orders/lab-order-adapter.js";
import { createLabOrderDispatch } from "../src/lab-orders/lab-order-dispatch.js";
import {
  handleFlagLabOrderProblemRequest,
  handleLabOrderSheetRequest,
  handleResolveLabOrderProblemRequest,
  handleSetLabOrderStatusRequest,
  handleLabOrderWorklistRequest,
  handleSubmitLabOrderRequest,
  type LabOrderHandlerDeps,
} from "../src/lab-orders/lab-order-handlers.js";
import { registerLabOrderRoutes } from "../src/lab-orders/lab-order-routes.js";

const ORDER: LabOrder = {
  header: {
    orderId: "ORD-HANDLER",
    orderDate: "2026-07-11",
    lab: "Cherry Optical Lab",
    patientName: "Test Patient",
  },
  rx: { od: { sphere: -1 }, os: { sphere: -1.25 } },
  lensSpec: {
    jobType: "Complete",
    lensDesign: "Single Vision",
    lensMaterial: "Polycarbonate",
    treatments: [],
  },
  frameSource: 4,
  frameOwnership: "in-house",
  frame: { inventoryId: "inventory-1", brand: "Modo", model: "7008", source: "stock" },
};

function transmission(id: string, state: LabTransportState, order: LabOrder = ORDER): Task {
  return {
    resourceType: "Task",
    id,
    status: state === "received" ? "completed" : "in-progress",
    intent: "order",
    code: {
      coding: [{
        system: ODOS_LAB_ORDER_TASK_CODE_SYSTEM,
        code: LAB_ORDER_TRANSMISSION_TASK_CODE,
      }],
    },
    meta: { versionId: "1" },
    basedOn: [{ reference: "Task/order-1" }],
    businessStatus: labTransportStateConcept(state),
    authoredOn: "2026-07-11T12:00:00.000Z",
    input: [{
      type: {
        coding: [{ system: ODOS_LAB_ORDER_TASK_INPUT_SYSTEM, code: LAB_ORDER_EXPORT_INPUT_CODE }],
        text: "Lab order export",
      },
      valueString: JSON.stringify(labOrderToExport(order)),
    }],
  };
}

function setup() {
  const tasks = new Map<string, Task>([
    ["lab-queued", transmission("lab-queued", "queued")],
    ["lab-sent", transmission("lab-sent", "sent")],
    ["lab-received", transmission("lab-received", "received")],
  ]);
  const calls: Array<{ operation: string; staff?: string; reference?: string }> = [];
  const missingInventoryIds = new Set<string>();
  const inventoryUnit: Basic = {
    resourceType: "Basic",
    id: "inventory-1",
    code: {
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/basic-kind",
        code: "practice-frame-inventory-unit",
      }],
    },
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/unit-status",
      valueString: "at_lab",
    }],
  };
  const updates: Array<{ id: string; headers?: Record<string, string> }> = [];
  const updateControls: {
    before?: (input: { id: string; current: Task }) => void;
    alwaysConflict?: boolean;
  } = {};
  const fhir = {
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      if (resourceType === "Basic" && missingInventoryIds.has(id)) {
        throw Object.assign(new Error(`Basic/${id} not found`), { status: 404 });
      }
      if (resourceType === "Basic" && id === inventoryUnit.id) {
        return structuredClone(inventoryUnit) as T;
      }
      const task = tasks.get(id);
      if (!task) throw new Error(`Task/${id} not found`);
      return structuredClone(task) as T;
    },
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [...tasks.values()].map((resource) => ({ resource: structuredClone(resource) as T })),
    }),
    update: async <T extends Resource>(
      _rt: T["resourceType"],
      id: string,
      resource: T,
      headers?: Record<string, string>,
    ): Promise<T> => {
      updates.push({ id, headers });
      let current = tasks.get(id);
      if (!current) throw new Error(`Task/${id} not found`);
      if (updateControls.before) {
        const before = updateControls.before;
        updateControls.before = undefined;
        before({ id, current: structuredClone(current) });
        current = tasks.get(id);
      }
      const version = headers?.["If-Match"]?.match(/"(.+)"/)?.[1];
      if (updateControls.alwaysConflict || !version || version !== current?.meta?.versionId) {
        throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
      }
      const persisted = {
        ...resource,
        meta: { ...(resource.meta ?? {}), versionId: String(Number(version) + 1) },
      } as T;
      if (resource.resourceType === "Task") tasks.set(id, structuredClone(persisted as Task));
      return structuredClone(persisted);
    },
    create: async <T extends Resource>(resource: T): Promise<T> => resource,
  };
  const adapter: LabOrderAdapter = {
    vendorId: "manual",
    name: "manual-lab-order",
    vendorApiRequired: false,
    submit: async (request) => {
      calls.push({ operation: "submit", staff: request.staffReference });
      return {
        labOrderReference: "Task/lab-sent",
        transportState: "sent",
        transmittedVia: "manual",
        submittedAt: "2026-07-11T14:00:00.000Z",
      };
    },
    getTransportState: async (reference) => {
      calls.push({ operation: "state", reference });
      return "sent";
    },
    advanceTransportState: async (request) => {
      calls.push({ operation: "advance", staff: request.staffReference, reference: request.labOrderReference });
      return request.toState;
    },
    cancel: async (reference, staffReference) => {
      calls.push({ operation: "cancel", staff: staffReference, reference });
    },
  };
  const dispatch = createLabOrderDispatch([{ vendor: "manual" }]);
  const deps: LabOrderHandlerDeps = {
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/verified-staff", actorRole: "staff", fhir }
      : null,
    dispatch: {
      ...dispatch,
      getAdapter: () => adapter,
    },
    now: () => "2026-07-11T14:00:00.000Z",
  };
  return { adapter, calls, deps, fhir, missingInventoryIds, tasks, updates, updateControls };
}

test("submit handler authenticates, uses the verified staff identity, and defaults routing to manual", async () => {
  const fixture = setup();
  assert.deepEqual(await handleSubmitLabOrderRequest(fixture.deps, {
    authHeader: undefined,
    body: {},
  }), { status: 401, body: { error: "Authentication required to manage lab orders." } });

  const result = await handleSubmitLabOrderRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      order: ORDER,
      orderTaskReference: "Task/order-1",
      lab: "Cherry Optical Lab",
      staffReference: "Practitioner/spoofed",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(fixture.calls[0].operation, "submit");
  assert.equal(fixture.calls[0].staff, "Practitioner/verified-staff");
});

test("submit handler rejects an inventoryId outside FSRC 4 + in-house", async () => {
  const fixture = setup();
  const invalidOrder = {
    ...ORDER,
    frameOwnership: "patients-own",
  };
  const result = await handleSubmitLabOrderRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      order: invalidOrder,
      orderTaskReference: "Task/order-1",
      lab: "Cherry Optical Lab",
    },
  });
  assert.equal(result.status, 400);
  assert.deepEqual(fixture.calls, []);
});

test("sheet handler renders stored export and board GET computes legacy statuses without writes", async () => {
  const fixture = setup();
  const sheet = await handleLabOrderSheetRequest(fixture.deps, {
    authHeader: "Bearer good",
    labOrderReference: "Task/lab-sent",
  });
  assert.equal(sheet.status, 200);
  assert.match(String((sheet.body as { content: string }).content), /ORD-HANDLER/);

  const board = await handleLabOrderWorklistRequest(fixture.deps, {
    authHeader: "Bearer good",
  });
  assert.equal(board.status, 200);
  assert.deepEqual(Object.fromEntries((board.body as { items: Array<{ reference: string; status: string }> }).items
    .map((item) => [item.reference, item.status])), {
    "Task/lab-received": "received",
    "Task/lab-queued": "in-office-not-sent",
    "Task/lab-sent": "at-lab",
  });
  assert.equal((board.body as { unprojectableCount: number }).unprojectableCount, 0);
  assert.ok((board.body as { items: Array<{ inventoryStatusLabel?: string }> }).items
    .every((item) => item.inventoryStatusLabel === "At Lab"));
  assert.equal(fixture.updates.length, 0);

  const worklist = await handleLabOrderWorklistRequest(fixture.deps, {
    authHeader: "Bearer good",
    state: "received",
  });
  assert.equal(worklist.status, 200);
  assert.deepEqual((worklist.body as { items: Array<{ reference: string }> }).items.map(({ reference }) => reference), ["Task/lab-received"]);

  const invalid = await handleLabOrderWorklistRequest(fixture.deps, {
    authHeader: "Bearer good",
    state: "sent",
  });
  assert.equal(invalid.status, 400);
  assert.match(String((invalid.body as { error: string }).error), /status/i);
  assert.equal(fixture.updates.length, 0);
});

test("worklist skips a missing inventory unit, counts it, and keeps valid orders visible", async () => {
  const fixture = setup();
  const missingOrder: LabOrder = {
    ...ORDER,
    header: { ...ORDER.header, orderId: "ORD-MISSING" },
    frame: { ...ORDER.frame!, inventoryId: "inventory-missing" },
  };
  fixture.tasks.set("lab-missing", transmission("lab-missing", "sent", missingOrder));
  fixture.missingInventoryIds.add("inventory-missing");

  const result = await handleLabOrderWorklistRequest(fixture.deps, {
    authHeader: "Bearer good",
  });

  assert.equal(result.status, 200);
  const board = result.body as {
    items: Array<{ reference: string; inventoryStatus?: string }>;
    skippedInventoryUnitCount: number;
  };
  assert.equal(board.skippedInventoryUnitCount, 1);
  assert.ok(board.items.some((item) => item.reference === "Task/lab-missing"));
  assert.ok(board.items.some((item) => item.reference === "Task/lab-sent" && item.inventoryStatus === "at_lab"));
});

test("worklist rethrows a non-404 inventory join failure", async () => {
  const fixture = setup();
  const brokenOrder: LabOrder = {
    ...ORDER,
    header: { ...ORDER.header, orderId: "ORD-BROKEN" },
    frame: { ...ORDER.frame!, inventoryId: "inventory-broken" },
  };
  fixture.tasks.set("lab-broken", transmission("lab-broken", "sent", brokenOrder));

  const result = await handleLabOrderWorklistRequest(fixture.deps, {
    authHeader: "Bearer good",
  });

  assert.equal(result.status, 400);
  assert.match(String((result.body as { error: string }).error), /inventory-broken/);
});

test("staff status and problem actions persist verified identity and resolve without losing history", async () => {
  const fixture = setup();
  const status = await handleSetLabOrderStatusRequest(fixture.deps, {
    authHeader: "Bearer good",
    labOrderReference: "Task/lab-sent",
    body: { status: "received" },
  });
  assert.equal(status.status, 200);
  const flagged = await handleFlagLabOrderProblemRequest(fixture.deps, {
    authHeader: "Bearer good",
    labOrderReference: "Task/lab-sent",
    body: { reason: "lab-breakage-remake", note: "Lens broke during edging" },
  });
  assert.equal((flagged.body as { flag: { flaggedBy: string } }).flag.flaggedBy, "Practitioner/verified-staff");
  const resolved = await handleResolveLabOrderProblemRequest(fixture.deps, {
    authHeader: "Bearer good",
    labOrderReference: "Task/lab-sent",
    flagId: "flag-1",
  });
  assert.equal(resolved.status, 200);
  assert.ok(fixture.updates.every((update) => update.headers?.["If-Match"]));
});

test("problem flag retries one version conflict and preserves both concurrent append-only flags", async () => {
  const fixture = setup();
  fixture.updateControls.before = ({ id, current }) => {
    const concurrent = flagLabOrderProblem(current, {
      reason: "lab-lost",
      note: "Lab reported the tray missing",
      flaggedBy: "Practitioner/other-staff",
      flaggedAt: "2026-07-11T13:59:00.000Z",
    });
    fixture.tasks.set(id, {
      ...concurrent,
      meta: { ...(concurrent.meta ?? {}), versionId: "2" },
    });
  };

  const result = await handleFlagLabOrderProblemRequest(fixture.deps, {
    authHeader: "Bearer good",
    labOrderReference: "Task/lab-sent",
    body: { reason: "other", note: "Practice follow-up" },
  });
  assert.equal(result.status, 200);
  const saved = await fixture.fhir.read<Task>("Task", "lab-sent");
  const record = backfilledLabOrderStatusRecord(saved);
  assert.deepEqual(record.problemFlags.map((flag) => flag.note), [
    "Lab reported the tray missing",
    "Practice follow-up",
  ]);
  assert.deepEqual(fixture.updates.map((update) => update.headers?.["If-Match"]), ['W/"1"', 'W/"2"']);
  assert.equal(saved.meta?.versionId, "3");
});

test("a second version conflict returns a clean 409 response", async () => {
  const fixture = setup();
  fixture.updateControls.alwaysConflict = true;
  const result = await handleSetLabOrderStatusRequest(fixture.deps, {
    authHeader: "Bearer good",
    labOrderReference: "Task/lab-sent",
    body: { status: "received" },
  });
  assert.equal(result.status, 409);
  assert.match(String((result.body as { error: string }).error), /modified concurrently; reload and retry/);
  assert.equal(fixture.updates.length, 2);
});

test("all nine lab-order HTTP endpoints reach handlers after service authentication", async () => {
  const fixture = setup();
  let serviceAuthCalls = 0;
  const app = express();
  app.use(express.json());
  registerLabOrderRoutes(app, {
    authenticateService: async () => { serviceAuthCalls += 1; },
    handlers: fixture.deps,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const cases: Array<["GET" | "POST", string, unknown]> = [
      ["POST", "/lab-orders/submit", { order: ORDER, orderTaskReference: "Task/order-1", lab: "Cherry" }],
      ["POST", "/lab-orders/Task%2Flab-sent/advance", { toState: "received" }],
      ["POST", "/lab-orders/Task%2Flab-sent/cancel", {}],
      ["GET", "/lab-orders/Task%2Flab-sent/state", undefined],
      ["GET", "/lab-orders/Task%2Flab-sent/sheet", undefined],
      ["POST", "/lab-orders/Task%2Flab-sent/status", { status: "received" }],
      ["POST", "/lab-orders/Task%2Flab-sent/flags", { reason: "other", note: "Needs review" }],
      ["POST", "/lab-orders/Task%2Flab-sent/flags/flag-1/resolve", {}],
      ["GET", "/lab-orders?state=at-lab", undefined],
    ];
    for (const [method, path, body] of cases) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: "Bearer good",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, `${method} ${path}: ${await response.text()}`);
    }
    assert.equal(serviceAuthCalls, cases.length);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
