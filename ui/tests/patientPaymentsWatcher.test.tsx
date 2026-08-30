import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWatcherCollectionContext,
  resolveWatcherAfterCollection,
} from "../src/scenes/claims/PatientPayments";

test("patient-payment launch context requires a patient and explicit collection intent", () => {
  assert.deepEqual(
    parseWatcherCollectionContext("?patientId=sarah&collect=1&watcherTaskId=task-1"),
    { patientId: "sarah", collect: true, watcherTaskId: "task-1" },
  );
  assert.deepEqual(
    parseWatcherCollectionContext("?patientId=sarah&watcherTaskId=task-1"),
    { patientId: "sarah", collect: false, watcherTaskId: "task-1" },
  );
});

test("successful collection resolves exactly the carried watcher Task", async () => {
  const calls: Array<{ taskId: string; action: { action: "resolve" } }> = [];

  await resolveWatcherAfterCollection("task-1", async (taskId, action) => {
    calls.push({ taskId, action });
    return { taskId, status: "completed" };
  });

  assert.deepEqual(calls, [{ taskId: "task-1", action: { action: "resolve" } }]);
});
