import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Task } from "@medplum/fhirtypes";
import {
  canTransitionOpticalOrderStatus,
  createOpticalCashOrder,
  transitionOpticalOrderStatus,
  updateOpticalOrderTask,
} from "../src/optical-order-lifecycle-service.js";
import type { MedplumClient } from "../src/fhir-client.js";
import { opticalOrderStatusConcept } from "../src/fhir/opticalOrderStatus.js";
import { opticalOrderTypeConcept } from "../src/fhir/opticalOrderType.js";

test("createOpticalCashOrder POSTs the transaction Bundle and returns created resource ids", async () => {
  let posted: Bundle | undefined;
  const fhir = fakeClient({
    executeTransaction: async (bundle) => {
      posted = bundle;
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { response: { status: "201 Created", location: "DeviceRequest/dr-1/_history/1" } },
          { response: { status: "201 Created", location: "Task/task-1/_history/1" } },
          { response: { status: "201 Created", location: "ChargeItem/ci-1/_history/1" } },
          { response: { status: "201 Created", location: "ChargeItem/ci-2/_history/1" } },
          { response: { status: "201 Created", location: "Invoice/inv-1/_history/1" } },
        ],
      };
    },
  });

  const result = await createOpticalCashOrder(fhir, {
    patientReference: "Patient/p1",
    visionPrescriptionReference: "VisionPrescription/vp1",
    encounterReference: "Encounter/e1",
    orderHcpcsCode: "V2020",
    orderType: "lenses-only",
    charges: [
      { code: "V2020", feeCents: 18500 },
      { code: "V2100", feeCents: 12000 },
    ],
    tender: "CASH",
  });

  assert.equal(posted?.type, "transaction");
  const task = posted?.entry?.find((entry) => entry.resource?.resourceType === "Task")?.resource as Task;
  assert.equal(task.code?.coding?.[0]?.code, "lenses-only");
  assert.deepEqual(result, {
    deviceRequestId: "dr-1",
    taskId: "task-1",
    chargeItemIds: ["ci-1", "ci-2"],
    invoiceId: "inv-1",
  });
});

test("canTransitionOpticalOrderStatus allows every in-vocabulary transition except out of cancelled", () => {
  assert.equal(canTransitionOpticalOrderStatus("quote", "at-lab"), true);
  assert.equal(canTransitionOpticalOrderStatus("at-lab", "cancelled"), true);
  assert.equal(canTransitionOpticalOrderStatus("cancelled", "cancelled"), true);
  assert.equal(canTransitionOpticalOrderStatus("cancelled", "dispensed"), false);
  assert.throws(() => canTransitionOpticalOrderStatus("quote", "shipped"), /optical order status/i);
});

test("transitionOpticalOrderStatus updates businessStatus and syncs Task.status minimally", async () => {
  let updated: Task | undefined;
  const fhir = fakeClient({
    read: async () => taskFixture({ businessStatus: "at-lab", status: "in-progress" }),
    update: async (_rt, _id, task) => {
      updated = task as Task;
      return updated;
    },
  });

  await transitionOpticalOrderStatus(fhir, "task-1", "dispensed");

  assert.equal(updated?.businessStatus?.coding?.[0]?.code, "dispensed");
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.code?.coding?.[0]?.code, "rx");
});

test("transitionOpticalOrderStatus rejects transitions out of cancelled", async () => {
  const fhir = fakeClient({
    read: async () => taskFixture({ businessStatus: "cancelled", status: "cancelled" }),
  });

  await assert.rejects(() => transitionOpticalOrderStatus(fhir, "task-1", "at-lab"), /terminal/i);
});

test("updateOpticalOrderTask rejects any Task.code order-type change after create", async () => {
  const current = taskFixture({ businessStatus: "quote", orderType: "rx" });
  const attempted: Task = {
    ...current,
    code: opticalOrderTypeConcept("frame-only"),
  };
  const fhir = fakeClient({
    read: async () => current,
  });

  await assert.rejects(() => updateOpticalOrderTask(fhir, "task-1", attempted), /Order Type is immutable/i);
});

function taskFixture(input: {
  businessStatus: string;
  status?: Task["status"];
  orderType?: string;
}): Task {
  return {
    resourceType: "Task",
    id: "task-1",
    status: input.status ?? "in-progress",
    intent: "order",
    focus: { reference: "DeviceRequest/dr-1" },
    for: { reference: "Patient/p1" },
    businessStatus: opticalOrderStatusConcept(input.businessStatus),
    code: opticalOrderTypeConcept(input.orderType ?? "rx"),
  };
}

function fakeClient(overrides: Partial<MedplumClient>): MedplumClient {
  const fail = () => {
    throw new Error("unexpected fake FHIR client call");
  };
  return {
    login: fail,
    read: fail,
    search: fail,
    history: fail,
    vread: fail,
    create: fail,
    update: fail,
    patch: fail,
    executeTransaction: fail,
    deleteAttempt: fail,
    nullifyAttempt: fail,
    ...overrides,
  };
}
