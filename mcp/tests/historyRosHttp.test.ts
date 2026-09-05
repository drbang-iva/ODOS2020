import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { historyRosFixture } from "./helpers/historyRosFixture.js";
import * as endpoints from "../src/clinical-graph/hpi-endpoint.js";
import { buildHistoryAnswerObservation, HISTORY_ITEM_REVIEW_CODE, isHistoryAnswerObservation, parseHistoryAnswerObservation, parseHistoryItemReview } from "../src/clinical-graph/history-answer-observation.js";
import { HISTORY_OPTION_CATALOGS } from "../src/clinical-graph/history-template-engine.js";
import { handleEncounterVoidRequest } from "../src/clinical-graph/encounter-void-endpoint.js";
import type { Observation } from "@medplum/fhirtypes";

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
    assert.equal(result.method, "bulk");
    assert.deepEqual(result.targets, targets);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("bulk units derive seven answers from the shared eight-entry limit and write the act last", async () => {
  const s = historyRosFixture();
  const result = await bulk(s, bulkBody(15));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const answerUnits = s.transactions.filter(bundle => bundle.entry?.[0]?.request?.ifNoneExist);
  assert.deepEqual(answerUnits.map(bundle => bundle.entry?.length), [8, 8, 2]);
  assert.ok(answerUnits.every(bundle => (bundle.entry?.length ?? 0) <= endpoints.HISTORY_CONDITIONAL_BUNDLE_ENTRY_LIMIT));
  assert.ok(answerUnits.flatMap(bundle => bundle.entry ?? []).filter(entry => entry.resource?.resourceType === "Observation")
    .every(entry => entry.request?.method === "POST" && entry.request.ifNoneExist?.startsWith("identifier=")));
  const actIndex = s.transactions.findIndex(bundle => bundle.entry?.[0]?.resource?.resourceType === "Observation" &&
    (bundle.entry[0].resource as Observation).code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE));
  assert.equal(actIndex, 3, "the immutable act follows every answer unit");
  const act = s.transactions[actIndex].entry?.[0]?.resource as Observation;
  assert.deepEqual(parseHistoryItemReview(act).targets, targets(15));
});

test("a partial bulk run records its own act and a new gesture covers only the remaining targets", async () => {
  const s = historyRosFixture();
  const first = bulkBody(8);
  s.failTransactionAt(2);

  const partial = await bulk(s, first);

  assert.equal(partial.status, 503);
  const acts = () => s.rows.filter((row): row is Observation => row.resourceType === "Observation" &&
    row.code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE));
  assert.equal(acts().length, 1, "the failed click still records an act for its persisted answers");
  assert.deepEqual(parseHistoryItemReview(acts()[0]).targets, first.targets.slice(0, 7));

  s.failTransactionAt(undefined);
  const second = { ...first, gestureId: randomUUID(), targets: first.targets.slice(7) };
  const completed = await bulk(s, second);

  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(acts().length, 2);
  assert.deepEqual(acts().map(act => parseHistoryItemReview(act).targets), [first.targets.slice(0, 7), second.targets]);
  assert.notEqual(acts()[0].identifier?.[0]?.value, acts()[1].identifier?.[0]?.value);
  const locks = s.rows.filter(row => row.resourceType === "Basic" && row.code.coding?.some(coding => coding.code === "history-bulk-denial-lock"));
  assert.equal(locks.length, 2);
  assert.ok(locks.every(lock => lock.extension === undefined));
  assert.doesNotMatch(JSON.stringify(locks), /target/i);
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
  const stored = s.rows.find((row): row is Observation => row.resourceType === "Observation" && row.id === positive.id);
  assert.ok(stored); assert.equal((parseHistoryAnswerObservation(stored).value as any).status, "positive");
  const act = s.rows.find((row): row is Observation => row.resourceType === "Observation" && row.code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE));
  assert.ok(act); assert.deepEqual(parseHistoryItemReview(act).targets, [body.targets[1]]);
});

test("server reread excludes a created answer changed positive before the act", async () => {
  const s = historyRosFixture();
  const body = bulkBody(1);
  const staff = await s.deps.authenticate("synthetic");
  assert.ok(staff);
  const search = staff.fhir.search.bind(staff.fhir);
  let changed = false;
  staff.fhir.search = async (type, params = {}) => {
    if (!changed && type === "Observation" && params.identifier) {
      const index = s.rows.findIndex(row => row.resourceType === "Observation" &&
        row.identifier?.some(identifier => `${identifier.system}|${identifier.value}` === params.identifier));
      if (index !== -1) {
        const current = s.rows[index] as Observation;
        const parsed = parseHistoryAnswerObservation(current);
        s.rows[index] = { ...buildHistoryAnswerObservation({ ...parsed, value: { kind: "tri-state", status: "positive" } }, {
          patientReference: body.patientReference,
          encounterReference: body.encounterReference,
          recordedAt: "2026-09-05T12:00:01Z",
        }), id: current.id, meta: current.meta };
        changed = true;
      }
    }
    return search(type, params);
  };

  const result = await bulk(s, body);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const current = s.rows.find((row): row is Observation => row.resourceType === "Observation" && isHistoryAnswerObservation(row));
  assert.ok(current);
  assert.equal((parseHistoryAnswerObservation(current).value as any).status, "positive");
  assert.deepEqual((result.body as any).targets, []);
  assert.equal(s.rows.some(row => row.resourceType === "Observation" &&
    row.code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE)), false);
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

test("completed gesture replay restores its paired Provenance before reporting success", async () => {
  const s = historyRosFixture();
  const body = bulkBody(2);
  const first = await bulk(s, body);
  assert.equal(first.status, 200);
  const provenanceIndex = s.rows.findIndex(row => row.resourceType === "Provenance" &&
    !row.meta?.tag?.some(tag => tag.system?.endsWith("/unit")));
  assert.notEqual(provenanceIndex, -1);
  s.rows.splice(provenanceIndex, 1);

  const replay = await bulk(s, body);

  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay, first);
  assert.equal(s.rows.filter(row => row.resourceType === "Provenance" &&
    !row.meta?.tag?.some(tag => tag.system?.endsWith("/unit"))).length, 1,
  "a saved act is incomplete until its own Provenance is present");
});

test("completed gesture replay refuses a Provenance paired to another target", async () => {
  const s = historyRosFixture();
  const body = bulkBody(2);
  assert.equal((await bulk(s, body)).status, 200);
  const provenance = s.rows.find(row => row.resourceType === "Provenance" &&
    !row.meta?.tag?.some(tag => tag.system?.endsWith("/unit")));
  assert.ok(provenance);
  provenance.target = [{ reference: "Observation/other-act" }];

  await assert.rejects(() => bulk(s, body), /Provenance is incomplete/);
});

test("an in-flight bulk lock is durable, target-free, and released after the owning request settles", async () => {
  const s = historyRosFixture();
  const body = bulkBody(1);
  const actHold = deferred();
  s.raceAt(2, async () => { actHold.mark(); await actHold.released; });

  const pending = bulk(s, body);
  await actHold.held;
  try {
    const lock = s.rows.find(row => row.resourceType === "Basic" && row.code.coding?.some(coding => coding.code === "history-bulk-denial-lock"));
    assert.ok(lock, "the server must persist section ownership before the act can commit");
    assert.equal(JSON.stringify(lock).includes("target"), false, "the lock must never store intended or persisted targets");
    const whileHeld = await endpoints.handleHistoryItemActsRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
    assert.deepEqual((whileHeld.body as any).locks, [{ sectionKey: "review-of-systems", gestureId: body.gestureId }]);
  } finally { actHold.release(); }
  assert.equal((await pending).status, 200);
  const after = await endpoints.handleHistoryItemActsRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
  assert.deepEqual((after.body as any).locks, []);
});

test("all-positive bulk writes no negative answer and no review act", async () => {
  const s = historyRosFixture();
  const body = bulkBody(2);
  s.race(() => {
    for (const [index, candidate] of body.targets.entries()) {
      const answerId = `history-current-${candidate.sectionKey}-${candidate.sectionId}-${candidate.optionCode}`;
      s.rows.push({ ...buildHistoryAnswerObservation({ id: answerId, subjectScope: "encounter", templateKey: candidate.sectionKey,
        sectionId: candidate.sectionId, optionCode: candidate.optionCode, value: { kind: "tri-state", status: "positive" } }, {
        patientReference: body.patientReference, encounterReference: body.encounterReference, recordedAt: `2026-09-05T12:00:0${index}Z`,
      }), id: `concurrent-positive-${index}`, meta: { versionId: String(index + 1) } });
    }
  });

  const result = await bulk(s, body);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((result.body as any).targets, []);
  assert.equal(s.rows.filter(row => row.resourceType === "Observation" &&
    row.code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE)).length, 0,
  "zero persisted negatives must produce zero review acts");
});

test("concurrent same-gesture requests keep one answer-unit Provenance and one act Provenance", async () => {
  const s = historyRosFixture();
  const body = bulkBody(1);

  const results = await Promise.all([bulk(s, body), bulk(s, body)]);

  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const provenance = s.rows.filter(row => row.resourceType === "Provenance");
  assert.equal(provenance.length, 2,
    `one answer-unit Provenance plus one act Provenance: ${JSON.stringify(provenance.map(row => ({ tag: row.meta?.tag, activity: row.activity?.coding?.[0]?.code })))}`);
  assert.equal(new Set(provenance.map(row => JSON.stringify(row.meta?.tag))).size, 2);
});

test("bulk refuses missing identity and pre-answered targets before writing", async () => {
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
  assert.equal(s.transactions.length, 0);
});

test("fresh bulk after History clear records new live negatives", async () => {
  const s = historyRosFixture();
  const first = bulkBody(2);
  assert.equal((await bulk(s, first)).status, 200);
  const cleared = await handleEncounterVoidRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" },
    body: { scope: "section", sectionKey: ["hpi", "review-of-systems"] } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const next = await bulk(s, { ...first, gestureId: randomUUID() });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const live = s.rows.filter((row): row is Observation => row.resourceType === "Observation" &&
    row.status !== "entered-in-error" && row.status !== "cancelled" && row.code.coding?.some(coding => coding.code === "history-template-answer"));
  assert.equal(live.length, 2);
});

test("I2 every item-review HTTP door enforces one contract", async () => {
  for (const handler of [endpoints.handleHistoryItemReviewRequest, endpoints.handleHistoryReviewRequest]) {
    for (const [change, expected] of [
      [{ method: "individual" }, 400], [{ gestureId: undefined }, 400], [{ targets: [] }, 400], [{}, 200],
    ] as const) {
      const s = historyRosFixture();
      const result = await handler(s.deps, { authHeader: "synthetic", body: { ...bulkBody(2), ...change } });
      assert.equal(result.status, expected, `${handler.name}: ${JSON.stringify(change)}`);
      if (expected === 400) assert.equal(s.rows.length, 0);
      else {
        assert.equal((result.body as any).method, "bulk");
        assert.deepEqual((result.body as any).targets, bulkBody(2).targets);
      }
    }
    const s = historyRosFixture(), body = bulkBody(1);
    assert.equal((await handler(s.deps, { authHeader: "synthetic", body: { ...body, method: "individual" } })).status, 200);
    const before = JSON.stringify(s.rows);
    assert.equal((await handler(s.deps, { authHeader: "synthetic", body })).status, 409);
    assert.equal(JSON.stringify(s.rows), before, "a changed method must not write answers");
    const partial = historyRosFixture(), partialBody = bulkBody(8);
    partial.failTransactionAt(2);
    assert.equal((await handler(partial.deps, { authHeader: "synthetic", body: partialBody })).status, 503);
    const interrupted = JSON.stringify(partial.rows);
    assert.equal((await handler(partial.deps, { authHeader: "synthetic", body: { ...partialBody, method: "individual", targets: [partialBody.targets[0]] } })).status, 409);
    assert.equal(JSON.stringify(partial.rows), interrupted, "the partial run's act reserves the gesture");
  }
});

function deferred() {
  let mark!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { mark = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { held, released, mark, release };
}
