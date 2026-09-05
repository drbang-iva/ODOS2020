import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Bundle, Encounter, Observation, Resource } from "@medplum/fhirtypes";
import { buildHistoryAnswerObservation, buildHistoryReviewAttestation } from "../src/clinical-graph/history-answer-observation.js";
import { handleHpiRecordRequest, handleHistoryReviewRequest, handleHpiCaptureRequest, type HpiEndpointDeps } from "../src/clinical-graph/hpi-endpoint.js";
import { HISTORY_SUBJECT_SECTIONS } from "../src/clinical-graph/history-template-engine.js";

const patientReference = "Patient/item-review-patient";
const encounterReference = "Encounter/current";
const base = "https://odos2020.com/fhir";
const itemCode = `${base}/CodeSystem/odos-history-review|history-item-review`;
const tobacco = { sectionKey: "social-history", sectionId: "tobacco" };
const occupation = { sectionKey: "social-history", sectionId: "occupation" };
const earlier = "2026-09-01T12:00:00Z";
const later = "2026-09-04T12:00:00Z";
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
    const matches = rows.filter(row => row.resourceType === type).filter(row => {
      const searchable = row as Observation;
      return (!params.subject || searchable.subject?.reference === params.subject) &&
      (!params.encounter || searchable.encounter?.reference === params.encounter) &&
      (!params.identifier || searchable.identifier?.some(c => `${c.system}|${c.value}` === params.identifier)) &&
      (!params._tag || row.meta?.tag?.some(c => `${c.system}|${c.code}` === params._tag)) &&
      (!params.code || searchable.code?.coding?.some(c => `${c.system}|${c.code}` === params.code)) &&
      (!params["category:not"] || !searchable.category?.some(c => c.coding?.some(v => `${v.system}|${v.code}` === params["category:not"])));
    });
    const count = Number(params._count ?? 20), start = Number(params._offset ?? 0);
    return { resourceType: "Bundle", type: "searchset", entry: matches.slice(start, start + count).map(resource => ({ resource: structuredClone(resource) as unknown as T })),
      ...(start + count < matches.length ? { link: [{ relation: "next", url: `${baseUrl}fhir/R4/${type}?${new URLSearchParams({ ...params, _offset: String(start + count) })}` }] } : {}) };
  }
  const fhir = {
    baseUrl,
    read: async <T extends Encounter>(_type: T["resourceType"], id: string) => ({ resourceType: "Encounter", id, status: "in-progress", subject: { reference: patientReference } }) as T,
    search: async <T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}) => page<T>(type, params),
    searchUrl: async <T extends Resource>(url: string, type: T["resourceType"]) => page<T>(type, Object.fromEntries(new URL(url, baseUrl).searchParams)),
    create: async (row: any) => row,
    update: async (_type: any, _id: string, row: any) => row,
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      beforeTransaction?.(); beforeTransaction = undefined;
      transactions.push(structuredClone(bundle));
      const entries: NonNullable<Bundle["entry"]> = [];
      const resolvedFullUrls = new Map<string, string>();
      for (const entry of bundle.entry ?? []) {
        if (!entry.resource) continue;
        const resource = structuredClone(entry.resource);
        if (resource.resourceType === "Provenance") resource.target = resource.target.map(target => ({
          ...target,
          ...(target.reference && resolvedFullUrls.has(target.reference) ? { reference: resolvedFullUrls.get(target.reference) } : {}),
        }));
        const conditional = new URLSearchParams(entry.request?.ifNoneExist ?? "");
        const request = new URL(entry.request!.url!, baseUrl).searchParams;
        const identifier = conditional.get("identifier") ?? request.get("identifier");
        const tag = conditional.get("_tag") ?? request.get("_tag");
        const existing = rows.find(row => row.resourceType === resource.resourceType && (
          identifier ? (row as Observation).identifier?.some(v => `${v.system}|${v.value}` === identifier) :
          tag ? row.meta?.tag?.some(v => `${v.system}|${v.code}` === tag) :
          row.id === resource.id
        ));
        if (existing && entry.request?.ifMatch && entry.request.ifMatch !== `W/"${existing.meta?.versionId}"`) {
          if (thrownConflict) throw Object.assign(new Error("Synthetic transaction conflict"), { status: Number(conflictStatus) });
          return { resourceType: "Bundle", type: "transaction-response", entry: [{ response: { status: conflictStatus } }] };
        }
        const saved = { ...resource, id: existing?.id ?? resource.id ?? randomUUID(), meta: { ...resource.meta, versionId: randomUUID() } };
        if (entry.fullUrl) resolvedFullUrls.set(entry.fullUrl, `${saved.resourceType}/${saved.id}`);
        if (existing) rows.splice(rows.indexOf(existing), 1, saved); else rows.push(saved);
        entries.push({ resource: structuredClone(saved), response: { status: existing ? "200" : "201", location: `${saved.resourceType}/${saved.id}/_history/${saved.meta.versionId}` } });
      }
      return { resourceType: "Bundle", type: "transaction-response", entry: entries };
    },
  };
  const deps: HpiEndpointDeps = { authenticate: async () => ({ staffReference: "Practitioner/test", actorRole: "provider", fhir }), now: () => now };
  return { deps, rows, transactions, searches, conflictStatus: (value: string, throws = false) => { conflictStatus = value; thrownConflict = throws; }, time: (value: string) => { now = value; }, race: (fn: () => void) => { beforeTransaction = fn; } };
}
const review = (s: ReturnType<typeof fixture>, targets: object[], gestureId = randomUUID(), extra: object = {}) => handleHistoryReviewRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, sectionKey: "social-history", action: "items-reviewed", method: "individual", targets, gestureId, ...extra } });
const read = (s: ReturnType<typeof fixture>) => handleHpiRecordRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
const acts = (s: ReturnType<typeof fixture>) => s.rows.filter((row): row is Observation => row.resourceType === "Observation" && row.code.coding?.some(c => `${c.system}|${c.code}` === itemCode) === true);
const dates = async (s: ReturnType<typeof fixture>) => { const result = await read(s); assert.equal(result.status, 200); return (result.body as any).lastReviewed as Array<{ target: typeof tobacco; lastReviewed: string }>; };
const savedAnswer = (id: string, sectionId: string, date = earlier, encounter = encounterReference) => ({ ...buildHistoryAnswerObservation({ id, subjectScope: "patient", templateKey: "social-history", sectionId, value: sectionId === "tobacco" ? { kind: "selection", code: "never" } : { kind: "text", text: "Synthetic" } }, { patientReference, encounterReference: encounter, recordedAt: date }), id, meta: { versionId: "1" } });

test("separate A then B gestures preserve two acts and both dates", async () => {
  const s = fixture();
  assert.equal((await review(s, [tobacco])).status, 200);
  s.time(later);
  assert.equal((await review(s, [occupation])).status, 200);
  assert.equal(acts(s).length, 2);
  assert.deepEqual(await dates(s), [{ target: tobacco, lastReviewed: earlier }, { target: occupation, lastReviewed: later }]);
  assert.equal((await read(s)).status, 200);
  assert.deepEqual(((await read(s)).body as any).reviewAttestations, []);
});
test("retrying the same gesture produces one unchanged act and original response", async () => {
  const s = fixture(), gesture = randomUUID();
  const first = await review(s, [tobacco], gesture); assert.equal(first.status, 200);
  const snapshot = structuredClone(acts(s)); s.time(later);
  assert.deepEqual(await review(s, [tobacco], gesture), first);
  assert.equal(acts(s).length, 1); assert.deepEqual(acts(s), snapshot);
});
test("a reused gesture cannot replace its immutable targets or method", async () => {
  const s = fixture(), gesture = randomUUID();
  assert.equal((await review(s, [tobacco], gesture)).status, 200);
  const snapshot = structuredClone(acts(s));
  assert.equal((await review(s, [occupation], gesture)).status, 409);
  assert.equal((await review(s, [tobacco], gesture, { method: "bulk" })).status, 409);
  assert.deepEqual(acts(s), snapshot);
});
for (const [raceStatus, throws] of [["400", false], ["412", false], ["400", true], ["412", true]] as const) test(`a concurrent winner cannot have its targets overwritten (${raceStatus}, throws=${throws})`, async () => {
  const s = fixture(), gesture = randomUUID();
  assert.equal((await review(s, [occupation], gesture)).status, 200);
  const winner = acts(s)[0]; s.rows.length = 0; s.conflictStatus(raceStatus, throws);
  s.race(() => s.rows.push(winner));
  assert.equal((await review(s, [tobacco], gesture)).status, 409);
  assert.deepEqual(acts(s), [winner]);
});
test("legacy derivedFrom gives a review date only to the referenced answer", async () => {
  const x = savedAnswer("x", "tobacco", earlier, "Encounter/prior"), y = savedAnswer("y", "occupation", earlier, "Encounter/prior");
  const legacy = { ...buildHistoryReviewAttestation({ patientReference, encounterReference: "Encounter/prior", sectionKey: "social-history", actorReference: "Practitioner/test", recordedAt: later, priorAnswerReferences: ["Observation/x"] }), id: "legacy" };
  assert.deepEqual(await dates(fixture([x, y, legacy])), [{ target: tobacco, lastReviewed: later }, { target: occupation, lastReviewed: earlier }]);
});
test("recording and changing an answer writes zero item-review acts", async () => {
  const s = fixture();
  for (const code of ["never", "former-smoker"]) {
    const result = await handleHpiCaptureRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, templateAnswers: [{ id: "tobacco", subjectScope: "patient", templateKey: "social-history", sectionId: "tobacco", value: { kind: "selection", code } }] } });
    assert.equal(result.status, 200); assert.equal(acts(s).length, 0);
  }
});
test("editing an answer leaves existing item acts alive and unmodified", async () => {
  const s = fixture([savedAnswer("x", "tobacco")]);
  assert.equal((await review(s, [tobacco])).status, 200);
  const snapshot = structuredClone(acts(s)); s.time(later);
  const result = await handleHpiCaptureRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, templateAnswers: [{ id: "x", subjectScope: "patient", templateKey: "social-history", sectionId: "tobacco", value: { kind: "selection", code: "former-smoker" } }] } });
  assert.equal(result.status, 200); assert.deepEqual(acts(s), snapshot);
});
for (const answerDate of [earlier, "2026-09-05T12:00:00Z"]) test(`lastReviewed uses the later of answer and act (${answerDate})`, async () => {
  const s = fixture([savedAnswer("x", "tobacco", answerDate)]); s.time(later);
  assert.equal((await review(s, [tobacco])).status, 200);
  assert.deepEqual(await dates(s), [{ target: tobacco, lastReviewed: answerDate > later ? answerDate : later }]);
});
test("patient item-act search spans two encounters and uses the 5000-row ceiling", async () => {
  const s = fixture();
  for (let i = 0; i < 26; i++) assert.equal((await review(s, [i % 2 ? occupation : tobacco], randomUUID(), { encounterReference: `Encounter/${i % 2 ? "prior" : "current"}` })).status, 200);
  const prototype = acts(s)[0];
  for (let i = 26; i < 1001; i++) s.rows.push({ ...structuredClone(prototype), id: `seed-${i}` });
  assert.equal(acts(s).length, 1001); assert.equal((await dates(s)).length, 2);
  const queries = s.searches.filter(p => p.code === itemCode && !p.identifier);
  assert.ok(queries.length > 1); assert.ok(queries.every(p => p.subject === patientReference && !p.encounter));
  for (let i = 1001; i < 5001; i++) s.rows.push({ ...structuredClone(prototype), id: `seed-${i}` });
  const result = await read(s); assert.equal(result.status, 409); assert.match((result.body as any).error, /5001 rows/);
});
test("single_select, text and per-eye catalog targets round-trip exactly", async () => {
  const s = fixture();
  for (const target of [tobacco, occupation, { sectionKey: "ocular-history", sectionId: "conditions", optionCode: "glaucoma", eye: "OS" }]) {
    const result = await review(s, [target], randomUUID(), { sectionKey: target.sectionKey });
    assert.equal(result.status, 200); assert.deepEqual((result.body as any).targets, [target]);
  }
  assert.equal((await dates(s)).length, 3);
});
test("encounter-scoped declarations support item review without carried answers; legacy still refuses", async () => {
  HISTORY_SUBJECT_SECTIONS.push({ key: "synthetic-encounter", label: "Synthetic", subjectScope: "encounter", completionAnchor: "item", sections: [{ id: "item", type: "text", label: "Synthetic" }] });
  try {
    const s = fixture();
    assert.equal((await review(s, [{ sectionKey: "synthetic-encounter", sectionId: "item" }], randomUUID(), { sectionKey: "synthetic-encounter" })).status, 200);
    assert.equal((await handleHistoryReviewRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, sectionKey: "synthetic-encounter" } })).status, 400);
    assert.equal((await handleHistoryReviewRequest(s.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, sectionKey: "social-history" } })).status, 400);
  } finally { HISTORY_SUBJECT_SECTIONS.pop(); }
});
for (const target of [
  { ...tobacco, optionCode: "never" }, { ...tobacco, eye: "OU" }, { ...tobacco, sectionId: "*" },
  { ...tobacco, sectionKey: "ocular-history" }, { ...occupation, optionCode: "anything" },
  { sectionKey: "ocular-history", sectionId: "conditions", optionCode: "glaucoma" },
  { sectionKey: "ocular-history", sectionId: "conditions", optionCode: "dry-eye", eye: "OD" },
]) test(`invalid target refused without writes: ${JSON.stringify(target)}`, async () => {
  const s = fixture(); assert.equal((await review(s, [target])).status, 400); assert.equal(s.transactions.length, 0);
});
test("void, cancelled and foreign acts cannot contribute dates", async () => {
  const s = fixture(); assert.equal((await review(s, [tobacco])).status, 200);
  const row = acts(s)[0]; s.rows.length = 0;
  s.rows.push({ ...row, status: "entered-in-error" }, { ...row, id: "cancelled", status: "cancelled" }, { ...row, id: "foreign", subject: { reference: "Patient/other" } });
  assert.deepEqual(await dates(s), []);
});
