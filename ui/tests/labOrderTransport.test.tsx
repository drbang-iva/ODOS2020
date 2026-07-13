import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  advanceLabOrderTransport,
  cancelLabOrder,
  fetchLabOrderSheet,
  fetchLabOrderWorklist,
  flagLabOrderProblem,
  resolveLabOrderProblem,
  setLabOrderStatus,
  submitLabOrder,
  type LabOrderBoardItem,
} from "../src/lib/lab-order-transport";
import { OrdersBoard } from "../src/scenes/LabOrdersWorklist";
import type { LabOrder } from "../src/lib/optical-lab-order";
import { RouteSwitch } from "../src/App";
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

test("lab-order worklist is reachable from its route and the Desk sections menu", () => {
  const route = renderToStaticMarkup(<RouteSwitch view={{ kind: "picker" }} path="/dispensary/lab-orders" />);
  const desk = renderToStaticMarkup(<DeskHome />);
  assert.match(route, /Orders/);
  assert.match(route, /Loading orders/);
  assert.match(route, /Office/);
  assert.match(desk, /href="\/dispensary\/lab-orders"/);
  assert.match(desk, /Track orders sent to the lab/);
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

function boardItem(): LabOrderBoardItem {
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
