import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { GuarantorLinkScreens } from "../src/components/patient/GuarantorLinkScreens";

const person = { resourceType: "Person" as const, id: "D", name: [{ family: "Destination" }] };
const pendingCorrection = { kind: "correct", task: { id: "correction", status: "in-progress" }, patients: [{ name: "Synthetic child" }] };
const completedCorrection = { kind: "correct", task: { id: "completed-correction", status: "completed" }, patients: [{ name: "Synthetic child" }] };
const pendingTransfer = { kind: "transfer", task: { id: "pending-transfer", status: "in-progress" }, patients: [{ name: "Synthetic child" }] };

async function screen(completeStatus: 200 | 409, inspect: (context: {
  tree: ReturnType<typeof create>;
  calls: { path: string; method: string }[];
  reloads: () => number;
}) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string }[] = [];
  let reloadCount = 0;
  let historyReads = 0;
  let tree: ReturnType<typeof create> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://synthetic.test");
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method });
    if (url.pathname === "/guarantors/link-operations" && method === "GET") {
      historyReads++;
      return Response.json(historyReads === 1 ? [pendingCorrection, completedCorrection, pendingTransfer] : [{ ...pendingCorrection, task: { ...pendingCorrection.task, status: "cancelled" } }, completedCorrection, pendingTransfer]);
    }
    if (url.pathname === "/guarantors/link-operations/correction/complete" && method === "POST") {
      return Response.json(completeStatus === 200
        ? { ...pendingCorrection, task: { ...pendingCorrection.task, status: "cancelled" } }
        : { ...pendingCorrection, phase: "recovery-conflict", error: "Pending: Complete or Correct." }, { status: completeStatus });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  };
  try {
    await act(async () => { tree = create(<GuarantorLinkScreens person={person} relatedPersonId="r1" disabled={false} onReload={async () => { reloadCount++; }} />); });
    const history = tree!.root.findAllByType("button").find(button => button.children.join("") === "Guarantor changes")!;
    await act(async () => { await history.props.onClick(); });
    await inspect({ tree: tree!, calls, reloads: () => reloadCount });
  } finally {
    await act(async () => { tree?.unmount(); });
    globalThis.fetch = originalFetch;
  }
}

test("R9: an in-progress correction alone renders Complete and success reloads the patient and history once", async () => screen(200, async ({ tree, calls, reloads }) => {
  const completes = tree.root.findAllByType("button").filter(button => button.children.join("") === "Complete");
  assert.equal(completes.length, 1);
  await act(async () => { await completes[0].props.onClick(); });
  assert.equal(calls.filter(call => call.path.endsWith("/complete") && call.method === "POST").length, 1);
  assert.equal(calls.filter(call => call.path === "/guarantors/link-operations" && call.method === "GET").length, 2);
  assert.equal(reloads(), 1);
  assert.equal(tree.root.findAllByType("button").filter(button => button.children.join("") === "Complete").length, 0);
}));

test("R9 K15: a 409 with a Task from Complete reloads once and closes history", async () => screen(409, async ({ tree, calls, reloads }) => {
  const complete = tree.root.findAllByType("button").find(button => button.children.join("") === "Complete");
  assert.ok(complete);
  await act(async () => { await complete.props.onClick(); });
  assert.equal(calls.filter(call => call.path.endsWith("/complete") && call.method === "POST").length, 1);
  assert.equal(calls.filter(call => call.path === "/guarantors/link-operations" && call.method === "GET").length, 1);
  assert.equal(reloads(), 1);
  assert.equal(tree.root.findAllByType("button").some(button => button.children.join("") === "Complete"), false);
  assert.equal(tree.root.findAllByType("button").find(button => button.children.join("") === "Guarantor changes")!.props["aria-expanded"], false);
}));
