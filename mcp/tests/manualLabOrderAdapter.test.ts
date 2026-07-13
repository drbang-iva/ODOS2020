import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEvent, Bundle, Resource, Task, VisionPrescription } from "@medplum/fhirtypes";
import { buildLabOrder, type LabOrder } from "../src/fhir/opticalLabOrder.js";
import { OSOD_OPTICAL_ORDER_STATUS_SYSTEM, opticalOrderStatusConcept } from "../src/fhir/opticalOrderStatus.js";
import { OSOD_LAB_TRANSPORT_STATE_SYSTEM } from "../src/fhir/labTransportState.js";
import {
  createManualLabOrderAdapter,
  taskStatusForLabTransportState,
} from "../src/lab-orders/adapters/manual-lab-order-adapter.js";

const NOW = "2026-07-11T14:00:00.000Z";

function order(): LabOrder {
  const rx: VisionPrescription = {
    resourceType: "VisionPrescription",
    status: "active",
    created: NOW,
    dateWritten: NOW,
    patient: { reference: "Patient/p1" },
    prescriber: { reference: "Practitioner/dr1" },
    lensSpecification: [
      { product: { text: "lens" }, eye: "right", sphere: -2.25, cylinder: -0.75, axis: 180 },
      { product: { text: "lens" }, eye: "left", sphere: -2.5, cylinder: -0.5, axis: 175 },
    ],
  };
  return buildLabOrder({
    orderId: "ORD-1001",
    orderDate: "2026-07-11",
    lab: "Best Price Digital Lab",
    patientName: "Wanda Walkthrough",
    patientRef: "Patient/p1",
    visionPrescription: rx,
    lensSpec: {
      jobType: "Frame To Come",
      lensDesign: "BP Easy",
      lensMaterial: "Polycarbonate",
      treatments: ["AR"],
    },
    frameSource: 3,
    frameOwnership: "in-house",
  });
}

function clinicalTask(): Task {
  return {
    resourceType: "Task",
    id: "order-1",
    status: "in-progress",
    intent: "order",
    code: { text: "Rx" },
    businessStatus: opticalOrderStatusConcept("quote"),
    focus: { reference: "DeviceRequest/device-1" },
    for: { reference: "Patient/p1" },
  };
}

function fakeFhir(initialTransmissions: Task[] = []) {
  const clinical = clinicalTask();
  const tasks = new Map<string, Task>([["order-1", structuredClone(clinical)]]);
  for (const task of initialTransmissions) tasks.set(task.id!, structuredClone(task));
  const created: Resource[] = [];
  const updated: Task[] = [];

  return {
    store: { clinical, tasks, created, updated },
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
        && task.businessStatus?.coding?.[0]?.system === OSOD_LAB_TRANSPORT_STATE_SYSTEM);
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: transmissions.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
    create: async <T extends Resource>(resource: T): Promise<T> => {
      const copy = structuredClone(resource);
      if (copy.resourceType === "Task") {
        const task = { ...copy, id: `lab-${[...tasks.keys()].filter((id) => id.startsWith("lab-")).length + 1}` };
        tasks.set(task.id, task);
        created.push(structuredClone(task));
        return structuredClone(task) as T;
      }
      const audit = { ...copy, id: `audit-${created.filter((row) => row.resourceType === "AuditEvent").length + 1}` };
      created.push(structuredClone(audit));
      return audit as T;
    },
    update: async <T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T): Promise<T> => {
      const task = structuredClone(resource) as Task;
      tasks.set(id, task);
      updated.push(task);
      return structuredClone(resource);
    },
  };
}

function submitRequest(overrides: Record<string, unknown> = {}) {
  return {
    order: order(),
    orderTaskReference: "Task/order-1",
    staffReference: "Practitioner/staff-1",
    lab: "Best Price Digital Lab",
    ...overrides,
  } as never;
}

test("manual submit persists a sent transmission Task, round-trippable export, AuditEvent, and printable artifact without changing the clinical Task", async () => {
  const fhir = fakeFhir();
  const before = structuredClone(fhir.store.tasks.get("order-1"));
  const adapter = createManualLabOrderAdapter(fhir, { now: () => NOW });

  const result = await adapter.submit(submitRequest());

  assert.equal(result.labOrderReference, "Task/lab-1");
  assert.equal(result.transportState, "sent");
  assert.equal(result.transmittedVia, "manual");
  assert.equal(result.submittedAt, NOW);
  assert.equal(result.artifact?.kind, "html-sheet");
  assert.match(result.artifact?.content ?? "", /ORD-1001/);

  const transmission = fhir.store.tasks.get("lab-1")!;
  assert.equal(transmission.status, "in-progress");
  assert.equal(transmission.intent, "order");
  assert.equal(transmission.basedOn?.[0]?.reference, "Task/order-1");
  assert.equal(transmission.businessStatus?.coding?.[0]?.system, OSOD_LAB_TRANSPORT_STATE_SYSTEM);
  assert.equal(transmission.businessStatus?.coding?.[0]?.code, "sent");
  const storedExport = transmission.input?.find((input) => input.valueString)?.valueString;
  assert.ok(storedExport);
  assert.deepEqual(JSON.parse(storedExport), {
    format: "osod-lab-order",
    version: "0",
    order: order(),
  });

  const audit = fhir.store.created.find((resource): resource is AuditEvent => resource.resourceType === "AuditEvent");
  assert.ok(audit);
  assert.equal(audit.agent?.[0]?.who?.reference, "Practitioner/staff-1");
  assert.ok(audit.entity?.some((entity) => entity.what?.reference === "Task/lab-1"));
  assert.deepEqual(fhir.store.tasks.get("order-1"), before);
  assert.equal(fhir.store.tasks.get("order-1")?.businessStatus?.coding?.[0]?.system, OSOD_OPTICAL_ORDER_STATUS_SYSTEM);
});

test("manual submit rejects an active transmission for the same optical order", async () => {
  const fhir = fakeFhir();
  const adapter = createManualLabOrderAdapter(fhir, { now: () => NOW });
  await adapter.submit(submitRequest());
  await assert.rejects(() => adapter.submit(submitRequest()), /already transmitted/i);
  assert.equal([...fhir.store.tasks.keys()].filter((id) => id.startsWith("lab-")).length, 1);
});

test("manual transport advances sent to received, derives completed Task.status, and audits the update", async () => {
  const fhir = fakeFhir();
  const adapter = createManualLabOrderAdapter(fhir, { now: () => NOW });
  const submitted = await adapter.submit(submitRequest());

  const state = await adapter.advanceTransportState({
    labOrderReference: submitted.labOrderReference,
    toState: "received",
    staffReference: "Practitioner/staff-1",
    note: "Lab confirmed receipt",
  });

  assert.equal(state, "received");
  assert.equal(await adapter.getTransportState(submitted.labOrderReference), "received");
  assert.equal(fhir.store.tasks.get("lab-1")?.status, "completed");
  assert.equal(fhir.store.tasks.get("lab-1")?.businessStatus?.coding?.[0]?.code, "received");
  assert.equal(fhir.store.created.filter((resource) => resource.resourceType === "AuditEvent").length, 2);
});

test("manual cancel advances a non-terminal transmission to cancelled", async () => {
  const fhir = fakeFhir();
  const adapter = createManualLabOrderAdapter(fhir, { now: () => NOW });
  const submitted = await adapter.submit(submitRequest());

  await adapter.cancel(submitted.labOrderReference, "Practitioner/staff-1");

  assert.equal(await adapter.getTransportState(submitted.labOrderReference), "cancelled");
  assert.equal(fhir.store.tasks.get("lab-1")?.status, "cancelled");
});

test("manual adapter rejects vendor-only states, illegal transitions, and terminal changes with explicit errors", async () => {
  const fhir = fakeFhir();
  const adapter = createManualLabOrderAdapter(fhir, { now: () => NOW });
  const submitted = await adapter.submit(submitRequest());

  for (const toState of ["acknowledged", "in-production", "shipped"] as const) {
    await assert.rejects(() => adapter.advanceTransportState({
      labOrderReference: submitted.labOrderReference,
      toState,
      staffReference: "Practitioner/staff-1",
    }), /not applicable in manual mode/i);
  }
  await assert.rejects(() => adapter.advanceTransportState({
    labOrderReference: submitted.labOrderReference,
    toState: "queued",
    staffReference: "Practitioner/staff-1",
  }), /cannot advance|illegal/i);

  await adapter.advanceTransportState({
    labOrderReference: submitted.labOrderReference,
    toState: "received",
    staffReference: "Practitioner/staff-1",
  });
  await assert.rejects(() => adapter.advanceTransportState({
    labOrderReference: submitted.labOrderReference,
    toState: "error",
    staffReference: "Practitioner/staff-1",
  }), /terminal/i);
  await assert.rejects(() => adapter.cancel(submitted.labOrderReference, "Practitioner/staff-1"), /terminal/i);
});

test("manual adapter rejects malformed order, transmission, and staff references before writes", async () => {
  const fhir = fakeFhir();
  const adapter = createManualLabOrderAdapter(fhir, { now: () => NOW });

  await assert.rejects(() => adapter.submit(submitRequest({ orderTaskReference: "order-1" })), /Task\/<id>/);
  await assert.rejects(() => adapter.submit(submitRequest({ staffReference: "staff-1" })), /Practitioner/);
  await assert.rejects(() => adapter.submit(submitRequest({ lab: "  " })), /lab/i);
  await assert.rejects(() => adapter.getTransportState("lab-1"), /Task\/<id>/);
  await assert.rejects(() => adapter.cancel("Task/lab-1", "staff-1"), /Practitioner/);
  assert.equal(fhir.store.created.length, 0);
});

test("manual adapter metadata declares a no-API transport", () => {
  const adapter = createManualLabOrderAdapter(fakeFhir());
  assert.equal(adapter.vendorId, "manual");
  assert.equal(adapter.name, "manual-lab-order");
  assert.equal(adapter.vendorApiRequired, false);
});

test("every lab transport state derives the required FHIR Task.status", () => {
  assert.equal(taskStatusForLabTransportState("queued"), "requested");
  assert.equal(taskStatusForLabTransportState("sent"), "in-progress");
  assert.equal(taskStatusForLabTransportState("received"), "completed");
  assert.equal(taskStatusForLabTransportState("cancelled"), "cancelled");
  assert.equal(taskStatusForLabTransportState("error"), "failed");
  assert.equal(taskStatusForLabTransportState("acknowledged"), "in-progress");
  assert.equal(taskStatusForLabTransportState("in-production"), "in-progress");
  assert.equal(taskStatusForLabTransportState("shipped"), "in-progress");
});
