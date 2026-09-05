import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import express from "express";
import { historyRosFixture } from "./helpers/historyRosFixture.js";
import * as endpoints from "../src/clinical-graph/hpi-endpoint.js";
import { buildHistoryAnswerObservation, HISTORY_ITEM_REVIEW_CODE, parseHistoryAnswerObservation, parseHistoryItemReview } from "../src/clinical-graph/history-answer-observation.js";
import { HISTORY_OPTION_CATALOGS } from "../src/clinical-graph/history-template-engine.js";
import { getRoleDeclaration } from "../src/authz/roles.js";
import type { Basic, Observation } from "@medplum/fhirtypes";

const target = { sectionKey: "review-of-systems", sectionId: "systems", optionCode: "eye-pain" };
const targets = (count: number) => HISTORY_OPTION_CATALOGS.ros_items.slice(0, count).map(option => ({ ...target, optionCode: option.code }));
const bulkBody = (count: number, gestureId = randomUUID()) => ({
  patientReference: "Patient/ros-test",
  encounterReference: "Encounter/current",
  sectionKey: target.sectionKey,
  action: "items-reviewed" as const,
  method: "bulk" as const,
  targets: targets(count),
  gestureId,
});
const bulk = (s: ReturnType<typeof historyRosFixture>, body: ReturnType<typeof bulkBody>) =>
  endpoints.handleHistoryItemReviewRequest(s.deps, { authHeader: "synthetic", body });
test("individual HTTP boundary refuses malformed targets and routes immutable review/retraction/read", async () => {
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

test("bulk HTTP boundary admits an identified unanswered-only denial", async () => {
  const { registerHistoryItemRoutes } = await import("../src/clinical-graph/history-item-routes.js");
  const s = historyRosFixture();
  const app = express(); app.use(express.json()); registerHistoryItemRoutes(app, async () => s.deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const targets = [target, { ...target, optionCode: "tearing" }];
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/clinical-graph/history/items/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientReference: "Patient/ros-test",
        encounterReference: "Encounter/current",
        sectionKey: target.sectionKey,
        action: "items-reviewed",
        method: "bulk",
        targets,
        gestureId: randomUUID(),
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "complete");
    assert.equal(result.recorded, 2);
    assert.equal(result.total, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("bulk progress uses its registered Basic extension and provider/staff coded ledger grants", async () => {
  const s = historyRosFixture();
  assert.equal((await bulk(s, bulkBody(1))).status, 200);
  const ledger = s.rows.find((row): row is Basic => row.resourceType === "Basic");
  assert.ok(ledger);
  const extension = ledger.extension?.[0];
  const url = "https://odos2020.com/fhir/StructureDefinition/history-bulk-denial-state";
  assert.equal(extension?.url, url);
  assert.equal(typeof extension.valueString, "string");
  const directory = resolve(import.meta.dirname, "../../data/canonical-extensions");
  const registry = JSON.parse(await readFile(resolve(directory, "registry.json"), "utf8"));
  assert.equal(registry.extensions.filter((entry: any) => entry.url === url && entry.status === "active").length, 1);
  const definition = JSON.parse(await readFile(resolve(directory, "history-bulk-denial-state.json"), "utf8"));
  assert.equal(definition.url, url);
  assert.deepEqual(definition.context, [{ type: "element", expression: "Basic" }]);
  assert.deepEqual(definition.differential.element.find((entry: any) => entry.id === "Extension.value[x]").type, [{ code: "string" }]);

  const criteria = "Basic?code=https://odos2020.com/fhir/CodeSystem/history-bulk-denial|history-bulk-denial-ledger";
  for (const role of ["provider", "staff"] as const) {
    const rules = getRoleDeclaration(role).resourceRules.filter(rule => rule.resourceType === "Basic" && rule.scope.kind === "practice-search" && rule.scope.criteria === criteria);
    assert.ok(rules.some(rule => rule.interactions.includes("read")));
    assert.ok(rules.some(rule => rule.interactions.includes("create") && rule.interactions.includes("update")));
  }
});

test("bulk units derive seven answers from the shared eight-entry limit and finish ledger then act in order", async () => {
  const s = historyRosFixture();
  const result = await bulk(s, bulkBody(15));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((result.body as any).status, "complete");
  assert.equal((result.body as any).recorded, 15);
  assert.equal((result.body as any).total, 15);
  const answerUnits = s.transactions.filter(bundle => bundle.entry?.[0]?.request?.ifNoneExist);
  assert.deepEqual(answerUnits.map(bundle => bundle.entry?.length), [8, 8, 2]);
  assert.ok(answerUnits.every(bundle => (bundle.entry?.length ?? 0) <= endpoints.HISTORY_CONDITIONAL_BUNDLE_ENTRY_LIMIT));
  assert.ok(answerUnits.flatMap(bundle => bundle.entry ?? []).filter(entry => entry.resource?.resourceType === "Observation")
    .every(entry => entry.request?.method === "POST" && entry.request.ifNoneExist?.startsWith("identifier=")));
  assert.equal(s.events[0], "create:Basic");
  assert.equal(s.events.at(-1), "update:Basic");
  const actIndex = s.transactions.findIndex(bundle => bundle.entry?.[0]?.resource?.resourceType === "Observation" &&
    (bundle.entry[0].resource as Observation).code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE));
  assert.equal(actIndex, 3, "the immutable act follows every answer unit");
});

test("a failed later unit leaves durable progress and retry resumes before writing the act", async () => {
  const s = historyRosFixture();
  const body = bulkBody(8);
  s.failTransactionAt(2);
  const partial = await bulk(s, body);
  assert.equal(partial.status, 503);
  assert.equal((partial.body as any).status, "in-progress");
  assert.equal((partial.body as any).recorded, 7);
  assert.equal((partial.body as any).total, 8);
  const ledger = s.rows.find((row): row is Basic => row.resourceType === "Basic");
  assert.ok(ledger, "the progress ledger must survive the failed unit");
  assert.equal(JSON.parse(ledger.extension?.[0]?.valueString ?? "null").persistedTargets.length, 7);
  assert.equal(s.rows.some((row): row is Observation => row.resourceType === "Observation" && row.code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE)), false);
  const read = await endpoints.handleHistoryItemActsRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
  assert.equal(read.status, 200);
  const { error: _error, ...progress } = partial.body as any;
  assert.deepEqual((read.body as any).bulkDenials, [{ ...progress, targets: body.targets }]);

  s.failTransactionAt(undefined);
  const resumed = await bulk(s, body);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal((resumed.body as any).status, "complete");
  assert.equal((resumed.body as any).recorded, 8);
  assert.equal((resumed.body as any).total, 8);
  assert.equal(s.transactions.filter(bundle => bundle.entry?.[0]?.request?.ifNoneExist).length, 2, "the persisted seven-answer unit is not replayed");
});

test("conditional create preserves a concurrent explicit Yes and excludes it from the bulk act", async () => {
  const s = historyRosFixture();
  const body = bulkBody(2);
  const concurrent = body.targets[0];
  const answerId = `history-current-${concurrent.sectionKey}-${concurrent.sectionId}-${concurrent.optionCode}`;
  const positive = { ...buildHistoryAnswerObservation({ id: answerId, subjectScope: "encounter", templateKey: concurrent.sectionKey,
    sectionId: concurrent.sectionId, optionCode: concurrent.optionCode, value: { kind: "tri-state", status: "positive" } }, {
    patientReference: body.patientReference, encounterReference: body.encounterReference, recordedAt: "2026-09-05T12:00:01Z",
  }), id: "concurrent-positive", meta: { versionId: "1" } };
  s.race(() => s.rows.push(positive));
  const result = await bulk(s, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((result.body as any).recorded, 1);
  const stored = s.rows.find((row): row is Observation => row.resourceType === "Observation" && row.id === positive.id);
  assert.ok(stored); assert.equal((parseHistoryAnswerObservation(stored).value as any).status, "positive");
  const act = s.rows.find((row): row is Observation => row.resourceType === "Observation" && row.code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE));
  assert.ok(act); assert.deepEqual(parseHistoryItemReview(act).targets, [body.targets[1]]);
});

test("completed gesture replay is byte-stable and changed targets remain immutable", async () => {
  const s = historyRosFixture();
  const body = bulkBody(2);
  const first = await bulk(s, body); assert.equal(first.status, 200);
  const snapshot = JSON.stringify(s.rows), transactions = s.transactionAttempts(), events = [...s.events];
  assert.deepEqual(await bulk(s, body), first);
  assert.equal(JSON.stringify(s.rows), snapshot);
  assert.equal(s.transactionAttempts(), transactions);
  assert.deepEqual(s.events, events);
  const changed = await bulk(s, { ...body, targets: [body.targets[0]] });
  assert.equal(changed.status, 409);
  assert.match((changed.body as any).error, /immutable/i);
});

test("bulk refuses missing identity and pre-answered targets without creating a ledger", async () => {
  const s = historyRosFixture();
  const body = bulkBody(1);
  const missing = await endpoints.handleHistoryItemReviewRequest(s.deps, { authHeader: "synthetic", body: { ...body, gestureId: undefined } });
  assert.equal(missing.status, 400);
  const target0 = body.targets[0], answerId = `history-current-${target0.sectionKey}-${target0.sectionId}-${target0.optionCode}`;
  s.rows.push({ ...buildHistoryAnswerObservation({ id: answerId, subjectScope: "encounter", templateKey: target0.sectionKey,
    sectionId: target0.sectionId, optionCode: target0.optionCode, value: { kind: "tri-state", status: "positive" } }, {
    patientReference: body.patientReference, encounterReference: body.encounterReference, recordedAt: "2026-09-05T12:00:00Z",
  }), id: "existing-positive" });
  const answered = await bulk(s, body);
  assert.equal(answered.status, 409);
  assert.match((answered.body as any).error, /unanswered/i);
  assert.equal(s.rows.some(row => row.resourceType === "Basic"), false);
  assert.equal(s.transactions.length, 0);
});
