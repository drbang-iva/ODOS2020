import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@medplum/fhirtypes";
import {
  backfilledLabOrderStatusRecord,
  backfilledStatusForTransport,
  flagLabOrderProblem,
  projectLabOrderBoard,
  resolveLabOrderProblem,
  setLabOrderStatus,
  withLabOrderStatusRecord,
  type LabOrderStatus,
} from "../src/fhir/labOrderStatus.js";

const STAFF = "Practitioner/front-desk";

test("legacy queued, sent, and received transport facts backfill to staff statuses without changing transport", () => {
  assert.equal(backfilledStatusForTransport("queued"), "in-office-not-sent");
  assert.equal(backfilledStatusForTransport("sent"), "at-lab");
  assert.equal(backfilledStatusForTransport("received"), "received");
  for (const [transport, status] of [["queued", "in-office-not-sent"], ["sent", "at-lab"], ["received", "received"]] as const) {
    const task = labTask(`legacy-${transport}`, transport, "2026-07-01T12:00:00Z");
    const record = backfilledLabOrderStatusRecord(task);
    assert.equal(record.currentStatus, status);
    assert.equal(record.history[0].enteredAt, "2026-07-01T12:00:00Z");
    assert.equal(task.businessStatus?.coding?.[0]?.code, transport);
  }
});

test("each contextual advance records a fresh entered-at instant and notified sub-reason", () => {
  let task = withLabOrderStatusRecord(labTask("advance", "sent", "2026-07-01T12:00:00Z"), {
    version: 1,
    currentStatus: "patients-frame",
    history: [{ status: "patients-frame", enteredAt: "2026-07-01T12:00:00Z", setBy: STAFF }],
    problemFlags: [],
  });
  const statuses: LabOrderStatus[] = ["in-office-not-sent", "outbound", "at-lab", "inbound", "received"];
  statuses.forEach((status, index) => {
    task = setLabOrderStatus(task, status, `2026-07-0${index + 2}T12:00:00Z`, STAFF);
  });
  task = setLabOrderStatus(task, "notified", "2026-07-07T12:00:00Z", STAFF, "left-message");
  task = setLabOrderStatus(task, "dispensed", "2026-07-08T12:00:00Z", STAFF);
  const record = backfilledLabOrderStatusRecord(task);
  assert.deepEqual(record.history.map((entry) => entry.status), ["patients-frame", ...statuses, "notified", "dispensed"]);
  assert.equal(record.history.find((entry) => entry.status === "notified")?.notificationReason, "left-message");
  assert.ok(record.history.every((entry) => entry.enteredAt && (entry.setBy === STAFF || entry.status === "patients-frame")));
});

test("status-specific aging crosses the configured at-lab threshold and preserves separate transmission facts", () => {
  const task = withLabOrderStatusRecord(labTask("aging", "error", "2026-07-01T12:00:00Z"), {
    version: 1,
    currentStatus: "at-lab",
    history: [{ status: "at-lab", enteredAt: "2026-07-01T12:00:00Z", setBy: STAFF }],
    problemFlags: [],
  });
  const before = projectLabOrderBoard([task], "2026-07-06T11:59:00Z");
  const crossed = projectLabOrderBoard([task], "2026-07-06T12:00:00Z");
  assert.equal(before.items[0].overdue, false);
  assert.equal(crossed.items[0].overdue, true);
  assert.equal(crossed.items[0].status, "at-lab");
  assert.equal(crossed.items[0].transportState, "error");
  assert.equal(crossed.items[0].transmissionFact.kind, "error");

  for (const nestedStatus of ["lenses-on-order", "frame-on-order"] as const) {
    const nested = setLabOrderStatus(task, nestedStatus, "2026-07-01T12:00:01Z", STAFF);
    const nestedBoard = projectLabOrderBoard([nested], "2026-07-06T12:00:01Z");
    assert.equal(nestedBoard.items[0].overdue, true);
    assert.equal(nestedBoard.alarms.atLabOverdue, 1);
  }
});

test("board projection keeps live frame inventory state distinct from staff status and transport", () => {
  const task = labTask("inventory", "sent", "2026-07-01T12:00:00Z");
  const envelope = JSON.parse(task.input?.[0]?.valueString ?? "{}");
  envelope.order.frame.inventoryId = "unit-1";
  task.input![0]!.valueString = JSON.stringify(envelope);
  const board = projectLabOrderBoard(
    [task],
    "2026-07-02T12:00:00Z",
    undefined,
    new Map([["unit-1", "at_lab"]]),
  );
  assert.equal(board.items[0].status, "at-lab");
  assert.equal(board.items[0].transportState, "sent");
  assert.equal(board.items[0].inventoryUnitId, "unit-1");
  assert.equal(board.items[0].inventoryStatus, "at_lab");
  assert.equal(board.items[0].inventoryStatusLabel, "At Lab");
});

test("problem flags append, breakage alone resets aging, pin open problems, and retain resolved history", () => {
  const normal = withLabOrderStatusRecord(labTask("normal", "sent", "2026-07-04T12:00:00Z"), {
    version: 1,
    currentStatus: "at-lab",
    history: [{ status: "at-lab", enteredAt: "2026-07-04T12:00:00Z", setBy: STAFF }],
    problemFlags: [],
  });
  let flagged = withLabOrderStatusRecord(labTask("flagged", "sent", "2026-07-01T12:00:00Z"), {
    version: 1,
    currentStatus: "at-lab",
    history: [{ status: "at-lab", enteredAt: "2026-07-01T12:00:00Z", setBy: STAFF }],
    problemFlags: [],
  });
  flagged = flagLabOrderProblem(flagged, {
    reason: "cannot-locate",
    note: "Tray is not on the incoming shelf",
    flaggedBy: STAFF,
    flaggedAt: "2026-07-04T10:00:00Z",
  });
  assert.equal(backfilledLabOrderStatusRecord(flagged).history.length, 1);
  flagged = flagLabOrderProblem(flagged, {
    reason: "lab-breakage-remake",
    note: "Lab broke the lens during edging",
    flaggedBy: STAFF,
    flaggedAt: "2026-07-04T11:00:00Z",
  });
  let record = backfilledLabOrderStatusRecord(flagged);
  assert.equal(record.history.length, 2);
  assert.equal(record.history[1].enteredAt, "2026-07-04T11:00:00Z");
  assert.equal(record.problemFlags.length, 2);
  const projected = projectLabOrderBoard([normal, flagged], "2026-07-04T12:00:00Z");
  assert.equal(projected.items[0].reference, "Task/flagged");
  assert.equal(projected.alarms.flaggedProblems, 1);

  flagged = resolveLabOrderProblem(flagged, { flagId: "flag-1", resolvedBy: STAFF, resolvedAt: "2026-07-04T12:05:00Z" });
  flagged = resolveLabOrderProblem(flagged, { flagId: "flag-2", resolvedBy: STAFF, resolvedAt: "2026-07-04T12:06:00Z" });
  record = backfilledLabOrderStatusRecord(flagged);
  assert.equal(record.problemFlags.length, 2);
  assert.ok(record.problemFlags.every((flag) => flag.resolvedBy === STAFF && flag.resolvedAt));
  assert.equal(projectLabOrderBoard([flagged], "2026-07-04T12:07:00Z").alarms.flaggedProblems, 0);
});

test("one unprojectable legacy task is counted and skipped without blanking the board", () => {
  const valid = labTask("valid", "sent", "2026-07-01T12:00:00Z");
  const invalid = labTask("missing-time", "queued", "2026-07-01T12:00:00Z");
  delete invalid.authoredOn;
  const board = projectLabOrderBoard([invalid, valid], "2026-07-02T12:00:00Z");
  assert.deepEqual(board.items.map((item) => item.reference), ["Task/valid"]);
  assert.equal(board.counts["at-lab"], 1);
  assert.equal(board.counts["in-office-not-sent"], 0);
  assert.equal(board.unprojectableCount, 1);
});

function labTask(id: string, transport: "queued" | "sent" | "received" | "error", authoredOn: string): Task {
  return {
    resourceType: "Task",
    id,
    status: transport === "received" ? "completed" : transport === "queued" ? "requested" : transport === "error" ? "failed" : "in-progress",
    intent: "order",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/task-type", code: "lab-order-transmission" }] },
    businessStatus: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/lab-transport-state", code: transport }] },
    authoredOn,
    input: [{
      type: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/lab-order-task-input", code: "lab-order-export" }] },
      valueString: JSON.stringify({
        format: "odos-lab-order",
        version: "0",
        order: {
          header: { orderId: id, orderDate: "2026-07-01", lab: "Example Lab", patientName: `${id} Patient`, patientRef: `Patient/${id}` },
          rx: { od: {}, os: {} },
          lensSpec: { jobType: "Rx", lensDesign: "Progressive", lensMaterial: "Poly", treatments: [] },
          frameSource: 4,
          frameOwnership: "in-house",
          frame: { brand: "Modo", model: "7008", source: "stock" },
        },
      }),
    }],
  };
}
