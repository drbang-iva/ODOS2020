import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { historyRosFixture } from "./helpers/historyRosFixture.js";
import * as endpoints from "../src/clinical-graph/hpi-endpoint.js";

const target = { sectionKey: "review-of-systems", sectionId: "systems", optionCode: "eye-pain" };
test("individual HTTP boundary refuses bulk, malformed targets and routes immutable review/retraction/read", async () => {
  assert.equal(typeof endpoints.handleHistoryItemReviewRequest, "function");
  const { registerHistoryItemRoutes } = await import("../src/clinical-graph/history-item-routes.js");
  const s = historyRosFixture();
  const app = express(); app.use(express.json()); registerHistoryItemRoutes(app, async () => s.deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/clinical-graph`;
  const body = { patientReference: "Patient/ros-test", encounterReference: "Encounter/current", sectionKey: target.sectionKey, action: "items-reviewed", method: "individual", targets: [target], gestureId: randomUUID() };
  const post = (path: string, payload: object) => fetch(`${base}/history/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  try {
    for (const bad of [{ ...target, extra: true }, { sectionId: "systems" }, ...["sectionKey", "sectionId", "optionCode", "eye"].map(field => ({ ...target, [field]: "*" }))]) {
      assert.equal((await post("items/review", { ...body, targets: [bad] })).status, 400);
    }
    assert.equal((await post("items/review", { ...body, method: "bulk" })).status, 400);
    assert.equal((await post("items/review", { ...body, targets: [target, { ...target, optionCode: "tearing" }] })).status, 400);
    const first = await post("items/review", body); assert.equal(first.status, 200);
    const act = await first.json();
    assert.deepEqual(await (await post("items/review", body)).json(), act);
    const original = structuredClone(s.rows.find(r => `Observation/${r.id}` === act.attestationReference));
    const retracted = await post("items/retract", { ...body, method: undefined, action: "items-review-retracted", retracts: act.attestationReference, gestureId: randomUUID() });
    assert.equal(retracted.status, 200);
    assert.deepEqual(s.rows.find(r => `Observation/${r.id}` === act.attestationReference), original);
    const read = await fetch(`${base}/encounters/current/history/items`); assert.equal(read.status, 200);
    const record = await read.json(); assert.equal(record.reviews.length, 1); assert.deepEqual(record.reviews[0].activeTargets, []); assert.equal(record.retractions.length, 1);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
