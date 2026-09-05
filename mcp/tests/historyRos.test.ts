import { buildEncounterComplaintResource } from "../src/clinical-graph/encounter-complaint-store.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Bundle, Observation, Resource } from "@medplum/fhirtypes";
import * as engine from "../src/clinical-graph/history-template-engine.js";
import { buildHistoryAnswerObservation } from "../src/clinical-graph/history-answer-observation.js";
import { handleHpiDefinitionRequest, handleHpiRecordRequest, handleHistoryReviewRequest, handleHpiCaptureRequest, recordHistoryItemReview, type HpiEndpointDeps } from "../src/clinical-graph/hpi-endpoint.js";
import { handleEncounterVoidRequest } from "../src/clinical-graph/encounter-void-endpoint.js";
import { handleExamOverviewRequest } from "../src/clinical-graph/exam-overview-endpoint.js";
import { buildHpiFindingDefinition } from "../src/clinical-graph/hpi-definition.js";
const patientReference = "Patient/ros-test";
const encounterReference = "Encounter/current";
const earlier = "2026-09-05T12:00:00Z";
const later = "2026-09-05T13:00:00Z";
const sectionKey = "review-of-systems";
const a = { sectionKey, sectionId: "systems", optionCode: "eye-pain" };
const b = { ...a, optionCode: "poor-vision" };
function fixture(rows: Resource[] = []) {
  const transactions: Bundle[] = [];
  const searches: Record<string, string>[] = [];
  let now = earlier;
  let conflictStatus = "412";
  let thrownConflict = false;
  let beforeTransaction: (() => void) | undefined;
  const baseUrl = "http://localhost:18103/";
  function page<T extends Resource>(type: T["resourceType"], params: Record<string, string>): Bundle<T> {
    searches.push(params);
    const matches = rows.filter((resource): resource is Observation => resource.resourceType === type).filter(row =>
      (!params._id || row.id === params._id) &&
      (!params.subject || row.subject?.reference === params.subject) &&
      (!params.encounter || row.encounter?.reference === params.encounter) &&
      (!params.identifier || row.identifier?.some(c => `${c.system}|${c.value}` === params.identifier)) &&
      (!params.code || row.code.coding?.some(c => `${c.system}|${c.code}` === params.code)) &&
      (!params["category:not"] || !row.category?.some(c => c.coding?.some(v => `${v.system}|${v.code}` === params["category:not"])))
    );
    const count = Number(params._count ?? 20), start = Number(params._offset ?? 0);
    return { resourceType: "Bundle", type: "searchset", entry: matches.slice(start, start + count).map(resource => ({ resource: structuredClone(resource) as unknown as T })),
      ...(start + count < matches.length ? { link: [{ relation: "next", url: `${baseUrl}fhir/R4/${type}?${new URLSearchParams({ ...params, _offset: String(start + count) })}` }] } : {}) };
  }
  const fhir = {
    baseUrl,
    read: async <T extends Resource>(type: T["resourceType"], id: string) => (type === "Encounter" ? { resourceType: "Encounter", id, status: "in-progress", period: { start: earlier }, subject: { reference: patientReference } } : structuredClone(rows.find(row => row.resourceType === type && row.id === id))) as T,
    search: async <T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}) => page<T>(type, params),
    searchUrl: async <T extends Resource>(url: string, type: T["resourceType"]) => page<T>(type, Object.fromEntries(new URL(url, baseUrl).searchParams)),
    create: async (row: any) => row,
    update: async (_type: any, _id: string, row: any) => row,
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      beforeTransaction?.(); beforeTransaction = undefined;
      transactions.push(structuredClone(bundle));
      const entries: NonNullable<Bundle["entry"]> = [];
      for (const entry of bundle.entry ?? []) {
        if (!entry.resource) {
          entries.push({ response: { status: "201", location: `Provenance/${randomUUID()}/_history/1` } }); continue;
        }
        const resource = structuredClone(entry.resource);
        const query = new URL(entry.request!.url!, baseUrl).searchParams.get("identifier");
        const existing = rows.find(row => query ? (row as Observation).identifier?.some(v => `${v.system}|${v.value}` === query) : Boolean(resource.id) && row.id === resource.id && row.resourceType === resource.resourceType);
        if (existing && entry.request?.ifMatch && entry.request.ifMatch !== `W/"${existing.meta?.versionId}"`) {
          if (thrownConflict) throw Object.assign(new Error("Synthetic transaction conflict"), { status: Number(conflictStatus) });
          return { resourceType: "Bundle", type: "transaction-response", entry: [{ response: { status: conflictStatus } }] };
        }
        const saved = { ...resource, id: existing?.id ?? resource.id ?? randomUUID(), meta: { versionId: randomUUID() } };
        if (existing) rows.splice(rows.indexOf(existing), 1, saved); else rows.push(saved);
        entries.push({ resource: structuredClone(saved), response: { status: existing ? "200" : "201", location: `${saved.resourceType}/${saved.id}/_history/${saved.meta.versionId}` } });
      }
      return { resourceType: "Bundle", type: "transaction-response", entry: entries };
    },
  };
  const definition = buildHpiFindingDefinition({ source: "manual", recordedAt: earlier, actorReference: "Practitioner/test" });
  (definition.valueSchema.fields.reviewOfSystems as any).options.push({ code: "headache", display: "Headache", category: "general", active: true });
  const deps: HpiEndpointDeps = { findingDefinitions: () => [definition], authenticate: async () => ({ staffReference: "Practitioner/test", actorRole: "provider", fhir }), now: () => now };
  return { deps, rows, transactions, searches, conflictStatus: (value: string, throws = false) => { conflictStatus = value; thrownConflict = throws; }, time: (value: string) => { now = value; }, race: (fn: () => void) => { beforeTransaction = fn; } };
}

const review = (s: ReturnType<typeof fixture>, targets: object[], extra: object = {}) => handleHistoryReviewRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, sectionKey, action: "items-reviewed", method: "individual", targets, gestureId: randomUUID(), ...extra } });
const bulkReview = async (s: ReturnType<typeof fixture>, targets: typeof a[], gestureId = randomUUID()) => {
  const staff = await s.deps.authenticate("synthetic"); assert.ok(staff);
  return recordHistoryItemReview(staff.fhir, { patientReference, encounterReference, sectionKey, method: "bulk", targets,
    gestureId, actorReference: staff.staffReference, recordedAt: earlier });
};
const retract = (s: ReturnType<typeof fixture>, reference: string, target: object = a, extra: object = {}) => handleHistoryReviewRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, sectionKey, targets: [target], gestureId: randomUUID(), action: "items-review-retracted", retracts: reference, ...extra } });
const read = async (s: ReturnType<typeof fixture>) => { const r = await handleHpiRecordRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } }); assert.equal(r.status, 200); return r.body as any; };
const save = async (s: ReturnType<typeof fixture>, body: object) => { const r = await handleHpiCaptureRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, ...body } }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r; };
const answer = (code: string, status: "positive" | "negative" = "positive") => ({ id: `ros-${code}`, subjectScope: "encounter" as const, templateKey: sectionKey, sectionId: "systems", optionCode: code, value: { kind: "tri-state" as const, status } });
const declaration = () => { const d = engine.HISTORY_SUBJECT_SECTIONS.find(d => d.key === sectionKey); assert.ok(d); return d; };
const overview = async (s: ReturnType<typeof fixture>) => { const r = await handleExamOverviewRequest({ ...s.deps, findingDefinitions: s.deps.findingDefinitions! }, { authHeader: "synthetic", params: { encounterId: "current" } }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as any; };

test("ROS declaration exposes fourteen grouped systems and encounter scope", async () => {
  const s = fixture(); const result = await handleHpiDefinitionRequest(s.deps, { authHeader: "synthetic" });
  const d = (result.body as any).itemizedSubjectSections.find((d: any) => d.key === sectionKey);
  assert.equal((result.body as any).subjectSections.some((d: any) => d.key === sectionKey), false);
  assert.ok(d); assert.equal(d.subjectScope, "encounter"); assert.equal(d.review, "per-item");
  assert.deepEqual(d.charted_when, { reviewed_items_min: 1 });
  assert.equal(d.sections[0].group_by, "system"); assert.equal(d.sections[1].label, "ROS notable for");
  const items = (result.body as any).catalogs[d.sections[0].catalog];
  assert.equal(new Set(items.map((o: any) => o.system)).size, 14);
  for (const code of ["jaw-pain", "scalp-tenderness"]) assert.equal(items.find((o: any) => o.code === code).system, "Eyes");
});
test("targeted retraction preserves B and original bytes; shipped void restores A", async () => {
  const s = fixture(); const first = await bulkReview(s, [a, b]); assert.equal(first.status, 200);
  const ref = (first.body as any).attestationReference;
  const original = JSON.stringify(s.rows.find(row => `Observation/${row.id}` === ref)); s.time(later);
  const removed = await retract(s, ref); assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(JSON.stringify(s.rows.find(row => `Observation/${row.id}` === ref)), original);
  assert.deepEqual((await read(s)).lastReviewed, [{ target: b, lastReviewed: earlier }]);
  const retractionRef = (removed.body as any).attestationReference;
  const retraction = s.rows.find(row => `Observation/${row.id}` === retractionRef) as Observation;
  assert.deepEqual(retraction.derivedFrom, [{ reference: ref }]);
  const undone = await handleEncounterVoidRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" }, body: { scope: "observation", observationReference: retractionRef } });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.deepEqual((await read(s)).lastReviewed, [{ target: a, lastReviewed: earlier }, { target: b, lastReviewed: earlier }]);
  assert.equal(JSON.stringify(s.rows.find(row => `Observation/${row.id}` === ref)), original);
});
test("retraction retry is immutable and cannot reuse an item-review gesture", async () => {
  const s = fixture(), gestureId = randomUUID(); const first = await bulkReview(s, [a,b], gestureId); assert.equal(first.status, 200);
  const ref = (first.body as any).attestationReference;
  assert.equal((await retract(s, ref, a, { gestureId })).status, 409);
  const id = randomUUID(); const removed = await retract(s, ref, a, { gestureId: id }); assert.equal(removed.status, 200);
  const snapshot = JSON.stringify(s.rows); s.time(later);
  assert.deepEqual(await retract(s, ref, a, { gestureId: id }), removed);
  assert.equal((await retract(s, ref, b, { gestureId: id })).status, 409);
  assert.equal(JSON.stringify(s.rows), snapshot);
});
test("retraction affects only its referenced act; answer dates and later reviews survive", async () => {
  const s = fixture(); const first = await review(s, [a]); assert.equal(first.status, 200);
  s.time(later); assert.equal((await review(s, [a])).status, 200);
  assert.equal((await retract(s, (first.body as any).attestationReference)).status, 200);
  assert.deepEqual((await read(s)).lastReviewed, [{ target: a, lastReviewed: later }]);
  assert.equal((await save(s, { templateAnswers: [answer("eye-pain")] })).status, 200);
  assert.equal((await read(s)).lastReviewed[0].lastReviewed, later);
});
for (const target of [{ ...a, extra: true }, { sectionId: "systems", optionCode: "eye-pain" }, ...["sectionKey", "sectionId", "optionCode", "eye"].map(key => ({ ...a, [key]: "*" }))]) {
  for (const action of ["items-reviewed", "items-review-retracted"]) test(`malformed target refused at endpoint: ${action} ${JSON.stringify(target)}`, async () => {
    const s = fixture(); const r = action === "items-reviewed" ? await review(s, [target]) : await retract(s, "Observation/original", target);
    assert.equal(r.status, 400); assert.equal(s.transactions.length, 0);
  });
}
test("retraction refuses absent, wrong-target, foreign and prior-encounter originals", async () => {
  const s = fixture(); assert.equal((await retract(s, "Observation/missing")).status, 400);
  const first = await review(s, [b]); const ref = (first.body as any).attestationReference;
  assert.equal((await retract(s, ref)).status, 400);
  const row = s.rows.find(row => `Observation/${row.id}` === ref) as Observation;
  row.subject = { reference: "Patient/foreign" }; assert.equal((await retract(s, ref, b)).status, 400);
  row.subject = { reference: patientReference }; row.encounter = { reference: "Encounter/prior" };
  assert.equal((await retract(s, ref, b)).status, 400);
});
test("Social requires four answers even with a tobacco review; ROS explicitly counts bulk", async () => {
  const social = { ...engine.HISTORY_SUBJECT_SECTIONS.find(d => d.key === "social-history")!, review: "per-item" as const };
  const context = { encounterStart: earlier, lastReviewed: [{ target: { sectionKey: "social-history", sectionId: "tobacco" }, lastReviewed: later }] };
  assert.equal(engine.historySubjectSectionState(social, [], context), "not-started");
  const tobacco = { id: "t", subjectScope: "patient" as const, templateKey: "social-history", sectionId: "tobacco", value: { kind: "selection" as const, code: "never" } };
  assert.equal(engine.historySubjectSectionState(social, [tobacco], context), "started");
  assert.equal(engine.historySubjectSectionState(social, [tobacco, ...["driving", "alcohol-drugs", "home-safety"].map(sectionId => ({ ...tobacco, id: sectionId, sectionId, value: { kind: "tri-state" as const, status: "negative" as const } }))], context), "charted");
  const s = fixture(); assert.equal((await bulkReview(s, [a])).status, 200);
  assert.equal((await read(s)).subjectSectionSummaries.find((d: any) => d.sectionKey === sectionKey).state, "charted");
});
test("coverage reports 3/8 until every item is dated this encounter; positives survive", () => {
  const d = declaration(); const items = engine.HISTORY_OPTION_CATALOGS.ros_items.filter(o => o.system === "Eyes"); assert.equal(items.length, 8);
  const dates = items.map((o, i) => ({ target: { ...a, optionCode: o.code }, lastReviewed: i < 3 ? earlier : "2026-09-04T12:00:00Z" }));
  const context = { encounterStart: earlier, lastReviewed: dates, methods: ["bulk" as const] };
  const summary = engine.renderDeclaredSubjectSummary(d, [answer("eye-pain")], context);
  assert.match(summary, /Eyes 3\/8/); assert.doesNotMatch(summary, /Eyes reviewed/); assert.match(summary, /eye pain/i);
  const complete = engine.renderDeclaredSubjectSummary(d, [answer("eye-pain")], { ...context, lastReviewed: dates.map(r => ({ ...r, lastReviewed: earlier })) });
  assert.match(complete, /Eyes reviewed/); assert.match(complete, /eye pain/i);
});
test("bulk and individual summaries are byte-identical with the same partial coverage and positives", () => {
  const d = declaration();
  const lastReviewed = engine.HISTORY_OPTION_CATALOGS.ros_items.filter(o => o.system === "Eyes").slice(0, 3)
    .map(o => ({ target: { ...a, optionCode: o.code }, lastReviewed: earlier }));
  const answers = [answer("eye-pain")];
  const context = { encounterStart: earlier, lastReviewed };
  assert.equal(
    engine.renderDeclaredSubjectSummary(d, answers, { ...context, methods: ["bulk"] }),
    engine.renderDeclaredSubjectSummary(d, answers, { ...context, methods: ["individual"] }),
  );
});
test("catalog additions automatically change coverage denominator", () => {
  const d = declaration(); engine.HISTORY_OPTION_CATALOGS.ros_items.push({ code: "synthetic-new", display: "Synthetic new", system: "Eyes" });
  try { assert.match(engine.renderDeclaredSubjectSummary(d, [], { encounterStart: earlier, lastReviewed: [{ target: a, lastReviewed: earlier }] }), /Eyes 1\/9/); }
  finally { engine.HISTORY_OPTION_CATALOGS.ros_items.pop(); }
});
test("unregistered tokens throw in complaint and subject renderers", () => {
  assert.throws(() => engine.renderDeclaredComplaintNarrative({ ...engine.HISTORY_TEMPLATES[0], narrative: "{invented_summary}" }, []), /Unknown history.*token/);
  assert.throws(() => engine.renderDeclaredSubjectSummary({ ...declaration(), summary: "{invented_summary}" }, [], { encounterStart: earlier, lastReviewed: [] }), /Unknown history.*token/);
});
test("aggregate and itemized ROS never synthesize each other; overview prefers Charted itemized", async () => {
  const s = fixture([{ id: "complaint-basic", ...buildEncounterComplaintResource({ id: "complaint", patientId: "ros-test", encounterId: "current", ordinal: 1,
    freeTextLabel: "Blurred vision", eyeLocation: "OU", conditions: [], qualities: [], treatmentsTried: [], resolvedDx: [], additionalHistory: "", narrative: { mode: "automated" }, status: "active", provenanceHistory: [], provenance: { source: "manual", recordedAt: earlier, actorReference: "Practitioner/test" } }) }]); assert.equal((await save(s, { reviewOfSystems: [{ code: "headache", display: "Headache", category: "general", status: "positive" }], reviewAttestations: ["general"] })).status, 200);
  assert.deepEqual((await read(s)).answers, []);
  const aggregate = () => s.rows.find(row => row.resourceType === "Observation" && row.component?.some(c => c.code.coding?.some(v => v.code === "ROS_HEADACHE"))) as Observation;
  const originalComponents = JSON.stringify(aggregate().component?.filter(c => c.code.coding?.some(v => v.code?.startsWith("ROS_"))));
  assert.equal((await save(s, { templateAnswers: [answer("eye-pain")] })).status, 200);
  assert.equal(JSON.stringify(aggregate().component?.filter(c => c.code.coding?.some(v => v.code?.startsWith("ROS_")))), originalComponents);
  assert.equal(s.rows.some(row => row.resourceType === "Observation" && row.component?.some(c => c.code.coding?.some(v => v.code === "ROS_EYE_PAIN"))), false);
  const fresh = fixture(); assert.equal((await save(fresh, { templateAnswers: [answer("eye-pain")] })).status, 200);
  assert.equal(fresh.rows.some(row => row.resourceType === "Observation" && row.component?.some(c => c.code.coding?.some(v => v.code?.startsWith("ROS_")))), false);
  assert.match((await overview(s)).historySummary, /Eyes 1\/8/);
  assert.match((await overview(s)).historySummary, /eye pain/i);
});

test("overview falls back to the aggregate after the only item review is retracted", async () => {
  const s = fixture([{ resourceType: "Observation", id: "aggregate", status: "preliminary", subject: { reference: patientReference }, encounter: { reference: encounterReference },
    code: sHpiCode(), effectiveDateTime: earlier, component: [{ code: { coding: [{ code: "ROS_ATTESTED_GENERAL" }] }, valueBoolean: true }] }]);
  const first = await review(s, [a]); assert.equal(first.status, 200);
  assert.match((await overview(s)).historySummary, /Eyes 1\/8/);
  assert.equal((await retract(s, (first.body as any).attestationReference)).status, 200);
  assert.equal((await read(s)).subjectSectionSummaries.find((d: any) => d.sectionKey === sectionKey).state, "not-started");
  assert.equal((await overview(s)).historySummary, "ROS reviewed");
});

function sHpiCode() {
  return buildHpiFindingDefinition({ source: "manual", recordedAt: earlier, actorReference: "Practitioner/test" }).fhirObservationCode;
}

test("prior encounter acts keep historical dates without Charting this encounter", async () => {
  const s = fixture(); assert.equal((await review(s, [a], { encounterReference: "Encounter/prior" })).status, 200);
  assert.deepEqual((await read(s)).lastReviewed, [{ target: a, lastReviewed: earlier }]);
  const summary = (await read(s)).subjectSectionSummaries.find((d: any) => d.sectionKey === sectionKey);
  assert.equal(summary.state, "not-started"); assert.match(summary.summary, /Eyes 0\/8/); assert.doesNotMatch(summary.summary, /Review method/);
});

test("retracting an act never erases a positive answer or its own review date", async () => {
  const s = fixture(); await save(s, { templateAnswers: [answer("eye-pain")] });
  const first = await review(s, [a]); assert.equal(first.status, 200);
  assert.equal((await retract(s, (first.body as any).attestationReference)).status, 200);
  const result = await read(s);
  assert.deepEqual(result.lastReviewed, [{ target: a, lastReviewed: earlier }]);
  const summary = result.subjectSectionSummaries.find((d: any) => d.sectionKey === sectionKey);
  assert.equal(summary.state, "charted"); assert.match(summary.summary, /Reports eye pain/); assert.doesNotMatch(summary.summary, /Review method/);
});
