import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  LAB_ORDER_STATUSES,
  advanceLabOrderTransport,
  cancelLabOrder,
  fetchLabOrderSheet,
  fetchLabOrderWorklist,
  flagLabOrderProblem,
  resolveLabOrderProblem,
  setLabOrderStatus,
  submitLabOrder,
  type LabOrderBoardItem,
  type LabOrderBoardSummary,
} from "../src/lib/lab-order-transport";
import { FilterRail, OrdersBoard } from "../src/scenes/LabOrdersWorklist";
import type { LabOrder } from "../src/lib/optical-lab-order";
import { RouteSwitch } from "../src/App";
import { AppShell } from "../src/components/AppShell";
import { DeskHome } from "../src/scenes/DeskHome";
import { LabOrderActionButtons } from "../src/scenes/OpticalOrder";

const ORDER: LabOrder = {
  header: {
    orderId: "order-1",
    orderDate: "2026-07-11",
    lab: "Cherry Optical Lab",
    patientName: "Patient Example",
  },
  rx: { od: { sphere: -1 }, os: { sphere: -1.25 } },
  lensSpec: { jobType: "Rx", lensDesign: "Progressive", lensMaterial: "Poly", treatments: [] },
  frameSource: 4,
  frameOwnership: "in-house",
};

test("lab-order transport sends authenticated requests with the server contract", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    { labOrderReference: "Task/lab-1", transportState: "sent", transmittedVia: "manual", submittedAt: "2026-07-11T12:00:00Z" },
    { transportState: "received" },
    { transportState: "cancelled" },
    { status: "received", enteredAt: "2026-07-11T13:00:00Z" },
    { flag: { id: "flag-1" } },
    { flagId: "flag-1", resolvedAt: "2026-07-11T13:05:00Z" },
    { items: [] },
    { items: [] },
    { kind: "html-sheet", content: "<section>sheet</section>" },
  ];
  const options = {
    authHeader: () => "Bearer test",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse(responses.shift());
    },
  };

  await submitLabOrder({ order: ORDER, orderTaskReference: "Task/order-1", lab: "Cherry Optical Lab" }, options);
  await advanceLabOrderTransport("Task/lab-1", "received", "Arrived intact", options);
  await cancelLabOrder("Task/lab-1", options);
  await setLabOrderStatus("Task/lab-1", "received", undefined, options);
  await flagLabOrderProblem("Task/lab-1", "lab-lost", "Lab cannot find tray", options);
  await resolveLabOrderProblem("Task/lab-1", "flag-1", options);
  await fetchLabOrderWorklist(undefined, options);
  await fetchLabOrderWorklist("at-lab", options);
  await fetchLabOrderSheet("Task/lab-1", options);

  assert.deepEqual(calls.map(({ url, init }) => [url, init?.method ?? "GET"]), [
    ["/lab-orders/submit", "POST"],
    ["/lab-orders/Task%2Flab-1/advance", "POST"],
    ["/lab-orders/Task%2Flab-1/cancel", "POST"],
    ["/lab-orders/Task%2Flab-1/status", "POST"],
    ["/lab-orders/Task%2Flab-1/flags", "POST"],
    ["/lab-orders/Task%2Flab-1/flags/flag-1/resolve", "POST"],
    ["/lab-orders", "GET"],
    ["/lab-orders?state=at-lab", "GET"],
    ["/lab-orders/Task%2Flab-1/sheet", "GET"],
  ]);
  for (const call of calls) {
    assert.equal((call.init?.headers as Record<string, string>).Authorization, "Bearer test");
  }
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    order: ORDER,
    orderTaskReference: "Task/order-1",
    lab: "Cherry Optical Lab",
  });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { toState: "received", note: "Arrived intact" });
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {});
});

test("lab-order transport reports response status and server error", async () => {
  await assert.rejects(
    () => fetchLabOrderWorklist(undefined, {
      authHeader: () => "Bearer test",
      fetchImpl: async () => jsonResponse({ error: "Worklist unavailable" }, 503),
    }),
    /Lab-order request failed: 503 Worklist unavailable/,
  );
});

test("Orders board renders DCS frame source, ownership, status age, transmission fact, and contextual action", () => {
  const html = renderToStaticMarkup(
    <OrdersBoard
      items={[boardItem()]}
      onStatus={() => undefined}
      onFlag={async () => undefined}
      onResolve={() => undefined}
      onPrint={() => undefined}
    />,
  );
  assert.match(html, /#order-1/);
  assert.match(html, /Cherry Optical Lab/);
  assert.match(html, /Patient Example/);
  assert.match(html, /FRAME ENCLOSED/);
  assert.match(html, /POF — PATIENT&#x27;S OWN/);
  assert.match(html, /Outbound/);
  assert.match(html, /At lab ✓/);
  assert.match(html, /print \+ mail/);
});

test("Orders board busy state matches the exact Task reference, not a string-prefix neighbor", () => {
  const html = renderToStaticMarkup(
    <OrdersBoard
      items={[
        boardItem({ reference: "Task/1", orderId: "1", patientName: "Prefix Patient" }),
        boardItem({ reference: "Task/10", orderId: "10", patientName: "Busy Patient" }),
      ]}
      busy="Task/10:status"
      onStatus={() => undefined}
      onFlag={async () => undefined}
      onResolve={() => undefined}
      onPrint={() => undefined}
    />,
  );
  const prefixRow = html.match(/<div class="odos-orders-row"><span class="odos-orders-id">#1<\/span>[\s\S]*?<\/div>/)?.[0] ?? "";
  const busyRow = html.match(/<div class="odos-orders-row"><span class="odos-orders-id">#10<\/span>[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.doesNotMatch(prefixRow, /disabled/);
  assert.match(busyRow, /disabled/);
});

test("Done — dispensed remains visible but has no active filter action", async () => {
  const selected: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<FilterRail summary={boardSummary()} filter="all-active" setFilter={(filter) => selected.push(filter)} />);
  });
  const done = renderer.root.findAllByType("button")
    .find((button) => button.children.flat().join("").includes("Done — dispensed"));
  assert.ok(done);
  assert.equal(done.props.disabled, true);
  assert.equal(done.props.title, "Dispensed orders live on the patient record");
  assert.equal(done.props.onClick, undefined);
  assert.deepEqual(selected, []);
  renderer.unmount();
});

test("lab-order worklist is reachable from its route and the global Sections menu", () => {
  const route = renderToStaticMarkup(<AppShell path="/dispensary/lab-orders" roles={["front-desk"]} homePath="/desk" side="desk" email="desk@example.test"><RouteSwitch view={{ kind: "picker" }} path="/dispensary/lab-orders" /></AppShell>);
  const desk = renderToStaticMarkup(<AppShell path="/desk" roles={["front-desk"]} homePath="/desk" side="desk" email="desk@example.test"><DeskHome /></AppShell>);
  assert.match(route, /Orders/);
  assert.match(route, /Loading orders/);
  assert.match(route, /Office/);
  assert.match(desk, /href="\/dispensary\/lab-orders"/);
  assert.match(desk, /optical orders in flight/);
});

test("Send to Lab is gated by a created order and active transmissions expose only follow-up actions", () => {
  const props = {
    canPrint: true,
    busy: false,
    onPrint: () => undefined,
    onDownload: () => undefined,
    onSend: () => undefined,
    onMarkReceived: () => undefined,
    onCancel: () => undefined,
  };
  const beforeCheckout = renderToStaticMarkup(<LabOrderActionButtons {...props} canSend={false} activeLabOrder={false} />);
  const ready = renderToStaticMarkup(<LabOrderActionButtons {...props} canSend activeLabOrder={false} />);
  const active = renderToStaticMarkup(<LabOrderActionButtons {...props} canSend activeLabOrder />);

  assert.match(button(beforeCheckout, "Send to Lab"), /disabled/);
  assert.doesNotMatch(button(ready, "Send to Lab"), /disabled/);
  assert.match(button(active, "Send to Lab"), /disabled/);
  assert.match(active, /Mark Received/);
  assert.match(active, /Cancel Lab Order/);
});

function boardItem(overrides: Partial<LabOrderBoardItem> = {}): LabOrderBoardItem {
  return {
    reference: "Task/lab-1",
    orderId: "order-1",
    patientName: "Patient Example",
    lab: "Cherry Optical Lab",
    frame: "Ray-Ban 5154",
    lenses: "Progressive · Poly",
    frameSource: 4,
    frameSourceLabel: "Frame enclosed",
    frameOwnership: "patients-own",
    status: "outbound",
    statusLabel: "Outbound",
    enteredAt: "2026-07-11T12:00:00Z",
    ageMinutes: 1440,
    limitMinutes: 4320,
    needsAction: false,
    overdue: false,
    transportState: "sent",
    transmissionFact: { kind: "manual", label: "print + mail" },
    problemFlags: [],
    ...overrides,
  };
}

function boardSummary(): LabOrderBoardSummary {
  const counts = Object.fromEntries(LAB_ORDER_STATUSES.map((status) => [status, status === "dispensed" ? 2 : 0])) as LabOrderBoardSummary["counts"];
  return {
    items: [],
    counts,
    activeCount: 0,
    alarms: { flaggedProblems: 0, atLabOverdue: 0, transmissionFailures: 0, receivedNotNotified: 0 },
    rollups: { preLab: 0, outbound: 0, atLab: 0, inbound: 0, notified: 0 },
    agingConfig: { outboundDays: 3, inboundDays: 3, atLabDays: 5, receivedNotifyHours: 24, notifiedRetryDays: 2, notifiedFollowUpDays: 7 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function button(html: string, label: string): string {
  return html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";
}
