import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Task } from "@medplum/fhirtypes";
import { labTransportStateConcept } from "../src/fhir/labTransportState.js";
import { ODOS_OCUCO_ORDER_ID_SYSTEM } from "../src/lab-orders/adapters/ocuco-gatekeeper-lab-order-adapter.js";
import { syncOcucoGatekeeperJobStatus } from "../src/jobs/syncOcucoGatekeeperJobStatus.js";

const CONFIG = { baseUrl: "https://gatekeeper.example", jwtKey: "key", jwtSecret: "secret" };

function transmission(orderId: string, state: "sent" | "acknowledged" = "sent"): Task {
  return {
    resourceType: "Task",
    id: `task-${orderId}`,
    status: "in-progress",
    intent: "order",
    code: { text: "Lab Order Transmission" },
    businessStatus: labTransportStateConcept(state),
    identifier: [{ system: ODOS_OCUCO_ORDER_ID_SYSTEM, value: orderId }],
  };
}

test("Ocuco status sync persists the destructive pull before parsing and advances matched legal statuses", async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  const task = transmission("50481940");
  const rawPull = {
    job_status: [[
      {
        RxNumber: "",
        PoNumber: "50481940",
        OrderDate: "11/19/2021",
        StatusDate: "11/19/2021 16:40:00 PM",
        Status: "Order received",
      },
      {
        RxNumber: "",
        PoNumber: "50481940",
        OrderDate: "11/19/2021",
        StatusDate: "11/19/2021 16:41:00 PM",
        Status: "Bench 7",
      },
      {
        RxNumber: "2402",
        PoNumber: "2402",
        StatusDate: "2020-07-30T14:39:00%2B05:00",
        Status: "Final Inspection",
        OrderID: "287027",
      },
    ]],
  };
  const client = {
    authenticate: async () => ({ authToken: "token", expiresAt: "2026-07-18T18:00:00.000Z" }),
    getContract: async () => ({ hashRoutingKey: "routing", labNumReceiver: "1231", custNumReceiver: "767" }),
    pushOrderToLab: async () => ({ id: 1, guid: "guid", createdAt: "", updatedAt: "" }),
    pullJobStatus: async () => rawPull,
  };
  const fhir = {
    search: async <T extends Task>(_resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> => {
      events.push(`search:${params?.identifier}`);
      return params?.identifier === `${ODOS_OCUCO_ORDER_ID_SYSTEM}|50481940`
        ? { resourceType: "Bundle", type: "searchset", entry: [{ resource: structuredClone(task) as T }] }
        : { resourceType: "Bundle", type: "searchset" };
    },
  };
  const advances: Array<{ labOrderReference: string; toState: string; staffReference: string }> = [];
  const adapter = {
    vendorId: "ocuco-gatekeeper",
    name: "Ocuco Gatekeeper (BP Digital Labs)",
    vendorApiRequired: true,
    submit: async () => { throw new Error("not used"); },
    getTransportState: async () => "sent" as const,
    advanceTransportState: async (request: { labOrderReference: string; toState: "acknowledged"; staffReference: string }) => {
      advances.push(request);
      task.businessStatus = labTransportStateConcept(request.toState);
      return request.toState;
    },
    cancel: async () => undefined,
  };

  const result = await syncOcucoGatekeeperJobStatus({
    config: CONFIG,
    client,
    fhir,
    adapter,
    staffReference: "Practitioner/sync-operator",
    persistRaw: async (raw) => {
      assert.equal(raw, rawPull);
      events.push("persist");
    },
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(events[0], "persist");
  assert.deepEqual(advances, [{
    labOrderReference: "Task/task-50481940",
    toState: "acknowledged",
    staffReference: "Practitioner/sync-operator",
    note: "Ocuco Gatekeeper status: Order received",
  }]);
  assert.deepEqual(result, {
    pulled: 3,
    advanced: 1,
    unmapped: 1,
    unmatched: 1,
    illegal: 0,
  });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((message) => /unmapped.*Bench 7/i.test(message)));
  assert.ok(warnings.some((message) => /2402.*match/i.test(message)));
});

test("Ocuco status sync logs an illegal regression instead of throwing or mutating", async () => {
  const task = transmission("50481940", "acknowledged");
  const warnings: string[] = [];
  let advanced = 0;
  const result = await syncOcucoGatekeeperJobStatus({
    config: CONFIG,
    client: {
      authenticate: async () => ({ authToken: "token", expiresAt: "2026-07-18T18:00:00.000Z" }),
      getContract: async () => ({ hashRoutingKey: "routing", labNumReceiver: "1231", custNumReceiver: "767" }),
      pushOrderToLab: async () => ({ id: 1, guid: "guid", createdAt: "", updatedAt: "" }),
      pullJobStatus: async () => ({ job_status: [{
        RxNumber: "50481940",
        PoNumber: "50481940",
        StatusDate: "2020-07-30T14:39:00%2B05:00",
        Status: "Order Entry",
        OrderID: "287030",
      }] }),
    },
    fhir: {
      search: async <T extends Task>(): Promise<Bundle<T>> => ({
        resourceType: "Bundle", type: "searchset", entry: [{ resource: task as T }],
      }),
    },
    adapter: {
      vendorId: "ocuco-gatekeeper",
      name: "Ocuco Gatekeeper (BP Digital Labs)",
      vendorApiRequired: true,
      submit: async () => { throw new Error("not used"); },
      getTransportState: async () => "acknowledged",
      advanceTransportState: async () => { advanced += 1; return "sent"; },
      cancel: async () => undefined,
    },
    staffReference: "Practitioner/sync-operator",
    persistRaw: async () => undefined,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(advanced, 0);
  assert.equal(result.illegal, 1);
  assert.ok(warnings.some((message) => /illegal.*acknowledged.*sent/i.test(message)));
});
