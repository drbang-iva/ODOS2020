import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Resource, Task } from "@medplum/fhirtypes";
import express from "express";
import { labTransportStateConcept, type LabTransportState } from "../src/fhir/labTransportState.js";
import { labOrderToExport, type LabOrder } from "../src/fhir/opticalLabOrder.js";
import {
  LAB_ORDER_EXPORT_INPUT_CODE,
  LAB_ORDER_TRANSMISSION_TASK_CODE,
  OSOD_LAB_ORDER_TASK_INPUT_SYSTEM,
  OSOD_LAB_ORDER_TASK_CODE_SYSTEM,
} from "../src/lab-orders/adapters/manual-lab-order-adapter.js";
import type { LabOrderAdapter } from "../src/lab-orders/lab-order-adapter.js";
import { createLabOrderDispatch } from "../src/lab-orders/lab-order-dispatch.js";
import {
  handleLabOrderSheetRequest,
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
};

function transmission(id: string, state: LabTransportState): Task {
  return {
    resourceType: "Task",
    id,
    status: state === "received" ? "completed" : "in-progress",
    intent: "order",
    code: {
      coding: [{
        system: OSOD_LAB_ORDER_TASK_CODE_SYSTEM,
        code: LAB_ORDER_TRANSMISSION_TASK_CODE,
      }],
    },
    basedOn: [{ reference: "Task/order-1" }],
    businessStatus: labTransportStateConcept(state),
    input: [{
      type: {
        coding: [{ system: OSOD_LAB_ORDER_TASK_INPUT_SYSTEM, code: LAB_ORDER_EXPORT_INPUT_CODE }],
        text: "Lab order export",
      },
      valueString: JSON.stringify(labOrderToExport(ORDER)),
    }],
  };
}

function setup() {
  const tasks = new Map<string, Task>([
    ["lab-sent", transmission("lab-sent", "sent")],
    ["lab-received", transmission("lab-received", "received")],
  ]);
  const calls: Array<{ operation: string; staff?: string; reference?: string }> = [];
  const fhir = {
    read: async <T extends Resource>(_resourceType: T["resourceType"], id: string): Promise<T> => {
      const task = tasks.get(id);
      if (!task) throw new Error(`Task/${id} not found`);
      return structuredClone(task) as T;
    },
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [...tasks.values()].map((resource) => ({ resource: structuredClone(resource) as T })),
    }),
    update: async <T extends Resource>(_rt: T["resourceType"], _id: string, resource: T): Promise<T> => resource,
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
      ? { staffReference: "Practitioner/verified-staff", actorRole: "front-desk", fhir }
      : null,
    dispatch: {
      ...dispatch,
      getAdapter: () => adapter,
    },
  };
  return { adapter, calls, deps, fhir };
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

test("sheet handler re-renders from the stored export and worklist filters by transport state", async () => {
  const fixture = setup();
  const sheet = await handleLabOrderSheetRequest(fixture.deps, {
    authHeader: "Bearer good",
    labOrderReference: "Task/lab-sent",
  });
  assert.equal(sheet.status, 200);
  assert.match(String((sheet.body as { content: string }).content), /ORD-HANDLER/);

  const worklist = await handleLabOrderWorklistRequest(fixture.deps, {
    authHeader: "Bearer good",
    state: "received",
  });
  assert.equal(worklist.status, 200);
  assert.deepEqual((worklist.body as { items: Task[] }).items.map(({ id }) => id), ["lab-received"]);

  const invalid = await handleLabOrderWorklistRequest(fixture.deps, {
    authHeader: "Bearer good",
    state: "at-lab",
  });
  assert.equal(invalid.status, 400);
  assert.match(String((invalid.body as { error: string }).error), /transport state/i);
});

test("all six lab-order HTTP endpoints reach handlers after service authentication", async () => {
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
      ["GET", "/lab-orders?state=sent", undefined],
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
