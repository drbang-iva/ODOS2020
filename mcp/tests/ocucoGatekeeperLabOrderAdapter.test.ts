import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEvent, Bundle, Resource, Task } from "@medplum/fhirtypes";
import type { LabOrder } from "../src/fhir/opticalLabOrder.js";
import { ODOS_LAB_TRANSPORT_STATE_SYSTEM } from "../src/fhir/labTransportState.js";
import {
  createOcucoGatekeeperLabOrderAdapter,
  ODOS_OCUCO_ORDER_ID_SYSTEM,
} from "../src/lab-orders/adapters/ocuco-gatekeeper-lab-order-adapter.js";

const NOW = "2026-07-17T18:00:00.000Z";
const CONFIG = { baseUrl: "https://gatekeeper.example", jwtKey: "key", jwtSecret: "secret" };

function order(): LabOrder {
  return {
    header: {
      orderId: "50481940",
      orderDate: "2026-07-17",
      lab: "BP Digital Labs",
      patientName: "Wanda Walkthrough",
    },
    rx: {
      od: { sphere: -2.25, cylinder: -0.75, axis: 180, distPd: 31.5 },
      os: { sphere: -2.5, cylinder: -0.5, axis: 175, distPd: 31 },
    },
    lensSpec: {
      jobType: "Lenses Only",
      lensDesign: "Single Vision",
      lensMaterial: "Polycarbonate",
      treatments: ["AR"],
    },
    frameSource: 0,
    frame: {
      source: "stock",
      a: "51.0",
      b: "38.0",
      ed: "51.0",
      dbl: "18.0",
      frameType: "standard",
    },
  };
}

function clinicalTask(): Task {
  return {
    resourceType: "Task",
    id: "order-1",
    status: "in-progress",
    intent: "order",
    code: { text: "Optical order" },
    for: { reference: "Patient/p1" },
  };
}

function fakeFhir() {
  const tasks = new Map<string, Task>([["order-1", clinicalTask()]]);
  const created: Resource[] = [];
  const updated: Task[] = [];
  return {
    store: { tasks, created, updated },
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      assert.equal(resourceType, "Task");
      const task = tasks.get(id);
      if (!task) throw new Error(`Task/${id} not found`);
      return structuredClone(task) as T;
    },
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
      assert.equal(resourceType, "Task");
      const transmissions = [...tasks.values()].filter((task) =>
        task.basedOn?.[0]?.reference === "Task/order-1"
        && task.businessStatus?.coding?.[0]?.system === ODOS_LAB_TRANSPORT_STATE_SYSTEM);
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: transmissions.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
    create: async <T extends Resource>(resource: T): Promise<T> => {
      const copy = structuredClone(resource);
      if (copy.resourceType === "Task") {
        const task = { ...copy, id: "ocuco-1" };
        tasks.set(task.id, task);
        created.push(structuredClone(task));
        return structuredClone(task) as T;
      }
      const audit = { ...copy, id: `audit-${created.length + 1}` };
      created.push(structuredClone(audit));
      return audit as T;
    },
    update: async <T extends Resource>(_type: T["resourceType"], id: string, resource: T): Promise<T> => {
      const task = structuredClone(resource) as Task;
      tasks.set(id, task);
      updated.push(task);
      return structuredClone(resource);
    },
  };
}

function fakeClient() {
  const pushes: Array<{ hashRoutingKey: string; hashrefBody: string; traceBody?: string }> = [];
  let authCalls = 0;
  let contractCalls = 0;
  return {
    store: { pushes, get authCalls() { return authCalls; }, get contractCalls() { return contractCalls; } },
    authenticate: async () => {
      authCalls += 1;
      return { authToken: "token", expiresAt: "2026-07-18T18:00:00.000Z" };
    },
    getContract: async () => {
      contractCalls += 1;
      return { hashRoutingKey: "routing", labNumReceiver: "1231", custNumReceiver: "767" };
    },
    pushOrderToLab: async (_token: string, request: { hashRoutingKey: string; hashrefBody: string; traceBody?: string }) => {
      pushes.push(structuredClone(request));
      return { id: 581050, guid: "remote-guid", createdAt: NOW, updatedAt: NOW };
    },
    pullJobStatus: async () => ({ job_status: [] }),
  };
}

function submitRequest() {
  return {
    order: order(),
    orderTaskReference: "Task/order-1",
    staffReference: "Practitioner/staff-1",
    lab: "BP Digital Labs",
  };
}

test("Ocuco submit sends the JSON-ready Hashref, persists the shared transmission Task, and audits", async () => {
  const fhir = fakeFhir();
  const client = fakeClient();
  const adapter = createOcucoGatekeeperLabOrderAdapter(fhir, CONFIG, client, { now: () => NOW });

  const result = await adapter.submit(submitRequest());

  assert.deepEqual(result, {
    labOrderReference: "Task/ocuco-1",
    transportState: "sent",
    transmittedVia: "api",
    submittedAt: NOW,
  });
  assert.equal(client.store.authCalls, 1);
  assert.equal(client.store.contractCalls, 1);
  assert.equal(client.store.pushes.length, 1);
  assert.equal(client.store.pushes[0].hashRoutingKey, "routing");
  assert.match(client.store.pushes[0].hashrefBody, /file_version:2\.5/);
  assert.match(client.store.pushes[0].hashrefBody, /order_id:50481940/);

  const transmission = fhir.store.tasks.get("ocuco-1")!;
  assert.equal(transmission.status, "in-progress");
  assert.equal(transmission.businessStatus?.coding?.[0]?.code, "sent");
  assert.equal(transmission.basedOn?.[0]?.reference, "Task/order-1");
  assert.ok(transmission.identifier?.some((identifier) =>
    identifier.system === ODOS_OCUCO_ORDER_ID_SYSTEM && identifier.value === "50481940"));
  assert.ok(transmission.input?.some((input) => input.valueString?.includes('"format":"odos-lab-order"')));
  const audit = fhir.store.created.find((resource): resource is AuditEvent => resource.resourceType === "AuditEvent");
  assert.ok(audit?.entity?.some((entity) => entity.what?.reference === "Task/ocuco-1"));
});

test("Ocuco adapter reaches vendor-only states through legal forward transitions", async () => {
  const fhir = fakeFhir();
  const adapter = createOcucoGatekeeperLabOrderAdapter(fhir, CONFIG, fakeClient(), { now: () => NOW });
  const submitted = await adapter.submit(submitRequest());

  for (const state of ["acknowledged", "in-production", "shipped", "received"] as const) {
    assert.equal(await adapter.advanceTransportState({
      labOrderReference: submitted.labOrderReference,
      staffReference: "Practitioner/staff-1",
      toState: state,
    }), state);
  }
  assert.equal(await adapter.getTransportState(submitted.labOrderReference), "received");
  assert.equal(fhir.store.tasks.get("ocuco-1")?.status, "completed");
});

test("Ocuco advanceTransportState cannot bypass the remote cancellation flow", async () => {
  const fhir = fakeFhir();
  const client = fakeClient();
  const adapter = createOcucoGatekeeperLabOrderAdapter(fhir, CONFIG, client, { now: () => NOW });
  const submitted = await adapter.submit(submitRequest());
  const taskBefore = structuredClone(fhir.store.tasks.get("ocuco-1"));

  await assert.rejects(
    () => adapter.advanceTransportState({
      labOrderReference: submitted.labOrderReference,
      staffReference: "Practitioner/staff-1",
      toState: "cancelled",
    }),
    /must use cancel\(\).*notify Ocuco/i,
  );

  assert.equal(client.store.pushes.length, 1);
  assert.equal(fhir.store.updated.length, 0);
  assert.deepEqual(fhir.store.tasks.get("ocuco-1"), taskBefore);
});

test("Ocuco cancellation re-submits the original order with cancel:1 before cancelling the Task", async () => {
  const fhir = fakeFhir();
  const client = fakeClient();
  const adapter = createOcucoGatekeeperLabOrderAdapter(fhir, CONFIG, client, { now: () => NOW });
  const submitted = await adapter.submit(submitRequest());

  await adapter.cancel(submitted.labOrderReference, "Practitioner/staff-1");

  assert.equal(client.store.pushes.length, 2);
  assert.match(client.store.pushes[1].hashrefBody, /\r\ncancel:1\r\n/);
  assert.match(client.store.pushes[1].hashrefBody, /\r\norder_id:50481940\r\n/);
  assert.equal(await adapter.getTransportState(submitted.labOrderReference), "cancelled");
});

test("Ocuco cancellation fails before a remote call when the stored original order id is absent", async () => {
  const fhir = fakeFhir();
  const client = fakeClient();
  const adapter = createOcucoGatekeeperLabOrderAdapter(fhir, CONFIG, client, { now: () => NOW });
  const submitted = await adapter.submit(submitRequest());
  const task = fhir.store.tasks.get("ocuco-1")!;
  const exportInput = task.input?.find((input) => input.valueString?.includes('"format":"odos-lab-order"'));
  assert.ok(exportInput?.valueString);
  const envelope = JSON.parse(exportInput.valueString);
  delete envelope.order.header.orderId;
  exportInput.valueString = JSON.stringify(envelope);

  await assert.rejects(
    () => adapter.cancel(submitted.labOrderReference, "Practitioner/staff-1"),
    /original.*order_id|order_id.*recover/i,
  );
  assert.equal(client.store.pushes.length, 1);
});

test("Ocuco submit fails clearly when runtime config is absent and never falls back to manual", async () => {
  const fhir = fakeFhir();
  const client = fakeClient();
  const adapter = createOcucoGatekeeperLabOrderAdapter(fhir, {}, client, { now: () => NOW });

  await assert.rejects(
    () => adapter.submit(submitRequest()),
    /Ocuco Gatekeeper is not configured.*OCUCO_GATEKEEPER_/,
  );
  assert.equal(client.store.authCalls, 0);
  assert.equal(fhir.store.created.length, 0);
});

test("Ocuco adapter metadata identifies the real BP Digital API transport", () => {
  const adapter = createOcucoGatekeeperLabOrderAdapter(fakeFhir(), CONFIG, fakeClient());
  assert.equal(adapter.vendorId, "ocuco-gatekeeper");
  assert.equal(adapter.name, "Ocuco Gatekeeper (BP Digital Labs)");
  assert.equal(adapter.vendorApiRequired, true);
});
