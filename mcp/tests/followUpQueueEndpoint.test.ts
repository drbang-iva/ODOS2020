import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import type { ExamOverviewFhirClient } from "../src/clinical-graph/exam-overview-endpoint.js";
import { resolveProfileTests } from "../src/clinical-graph/exam-overview-endpoint.js";
import { FhirEncounterExamScopeStore, type ProposedExamTest } from "../src/clinical-graph/exam-scope-store.js";
import { FhirFollowUpProfileStore } from "../src/clinical-graph/follow-up-profile-store.js";
import { buildProtocolBasic, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";
import type { PlanActionInstance } from "../src/clinical-graph/protocol-types.js";
import type { ProcedureFeeScheduleItem } from "../src/clinical-graph/procedure-fee-schedule.js";
import { deriveFollowUpQueue, handleFollowUpQueueRequest } from "../src/clinical-graph/follow-up-queue-endpoint.js";

const source = { kind: "profile" as const, profileKey: "glaucoma", profileLabel: "Frozen shape" };
const proposed = (fields: Partial<ProposedExamTest> = {}): ProposedExamTest => ({ orderable: "fundus-photography", focus: "optic nerve", label: "Optic nerve photos", sources: [source], ...fields });
const fee = (active = true): ProcedureFeeScheduleItem => ({ id: "photos", procedureConceptKey: "fundus-photography", display: "Fundus photography", active, category: "procedure", version: "1" });
const order = (fields: Partial<PlanActionInstance> = {}): PlanActionInstance => ({
  id: "order-1", encounterId: "e1", patientId: "p1", protocolApplicationId: null, actionType: "order",
  state: "selected", payload: { orderableKey: "fundus-photography", focus: "optic nerve" }, linkedDx: [], linkedFindings: [], modifiedFields: [],
  provenance: { source: "clinician-entered", actor: "Practitioner/synthetic", at: "2026-09-21T00:00:00Z" }, ...fields,
});
const queue = (tests: ProposedExamTest[] | undefined, fees: ProcedureFeeScheduleItem[] = [fee()], actions: PlanActionInstance[] = []) => deriveFollowUpQueue(tests, fees, actions, "e1", "p1");
function rows(value: ReturnType<typeof deriveFollowUpQueue>) { assert.equal(value.recorded, true); if (!value.recorded) throw new Error("Expected recorded queue"); return value.rows; }

class QueueFhir implements ExamOverviewFhirClient {
  baseUrl = "http://localhost/";
  resources: Resource[] = [];
  reads: string[] = [];
  failRead?: number;
  failSearch?: (type: string, params: Record<string, string>) => boolean;
  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    this.reads.push(`${type}/${id}`);
    if (this.failRead) throw Object.assign(new Error("read unavailable"), { status: this.failRead });
    return { resourceType: "Encounter", id, status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p1" } } as T;
  }
  async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    if (this.failSearch?.(type, params)) throw new Error("search unavailable");
    return { resourceType: "Bundle", type: "searchset", entry: this.resources.filter(r => r.resourceType === type &&
      (!params.identifier || (r as Basic).identifier?.some(i => `${i.system}|${i.value}` === params.identifier)) &&
      (!params.code || (r as Basic).code?.coding?.some(c => `${c.system}|${c.code}` === params.code))
    ).map(r => ({ resource: structuredClone(r) as T })) };
  }
  async create<T extends Resource>(resource: T): Promise<T> {
    const saved = { ...structuredClone(resource), id: resource.id ?? `r${this.resources.length}`, meta: { versionId: "1" } };
    this.resources.push(saved); return structuredClone(saved);
  }
  async update<T extends Resource>(_type: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex(r => r.id === id);
    const saved = { ...structuredClone(resource), meta: { versionId: String(Number(this.resources[index].meta?.versionId) + 1) } };
    this.resources[index] = saved; return structuredClone(saved);
  }
}
const actor = { reference: "Practitioner/synthetic" };
const request = { authHeader: "Bearer synthetic", params: { encounterId: "e1" } };
function deps(staff: QueueFhir, service = staff) {
  return { authenticate: async () => ({ staffReference: actor.reference, actorRole: "provider" as const, fhir: staff }), serviceFhir: service };
}

test("S3c2a G1 queue uses frozen labels and reasons after profile edits", async () => {
  const fhir = new QueueFhir(), profiles = new FhirFollowUpProfileStore(fhir), store = new FhirEncounterExamScopeStore(fhir);
  const profile = (await profiles.list()).find(p => p.profileKey === "macula-retina")!;
  await store.shapeIfAbsent("e1", actor, async () => ({ profiles: [profile], testsProposed: resolveProfileTests([profile]) }));
  const original = structuredClone(profile.testsQueuedByDefault);
  const { versionId, ...editable } = profile;
  await profiles.save({ ...editable, version: 2, label: "Changed shape", testsQueuedByDefault: original.map(t => ({ ...t, label: "Changed label", unavailableReason: "Changed reason" })) }, null);
  const result = await handleFollowUpQueueRequest(deps(fhir), request);
  assert.equal(result.status, 200);
  const output = rows(result.body as ReturnType<typeof deriveFollowUpQueue>);
  assert.equal(output[0].label, original[0].label);
  assert.equal(output[0].reason, original[0].unavailableReason);
  assert.deepEqual(output[0].sources, ["from the Macular degeneration / retina shape"]);
  assert.equal(JSON.stringify(output).includes("Changed"), false);
});

test("S3c2a G2 matches orderable and focus, retaining multiple matching action ids", () => {
  const output = rows(queue([proposed(), proposed({ focus: "retina", label: "Retina photos" })], [fee()], [order(), order({ id: "order-2", state: "modified" })]));
  assert.deepEqual(output.map(r => [r.label, r.state, r.actionIds]), [["Optic nerve photos", "already-ordered", ["order-1", "order-2"]], ["Retina photos", "for-review", undefined]]);
});

test("S3c2a G3 only a live order for this encounter and patient counts", () => {
  for (const action of [order({ state: "removed" }), order({ state: "cancelled" }), order({ encounterId: "other" }), order({ patientId: "other" }), order({ actionType: "counseling" })]) {
    assert.equal(rows(queue([proposed()], [fee()], [action]))[0].state, "for-review", JSON.stringify(action));
  }
  assert.equal(rows(queue([proposed({ focus: undefined })], [fee()], [order({ payload: { orderableKey: "fundus-photography" } })]))[0].state, "already-ordered");
});

test("S3c2a G4 a real order wins over unavailable fees", () => {
  for (const fees of [[], [fee(false)]]) assert.equal(rows(queue([proposed()], fees, [order()]))[0].state, "already-ordered");
});

test("S3c2a G5 availability is live and reason precedence is frozen then pending then catalogue", () => {
  assert.equal(rows(queue([proposed({ unavailableReason: "Frozen" })]))[0].state, "for-review");
  const output = rows(queue([proposed({ orderable: "erg", unavailableReason: "Frozen" }), proposed({ orderable: "erg" }), proposed()], []));
  assert.deepEqual(output.map(r => [r.state, r.reason]), [["unavailable", "Frozen"], ["unavailable", "On ODOS's pending-orderables list."], ["unavailable", "Not in the practice catalogue."]]);
  assert.equal(rows(queue([proposed()], [fee(false)]))[0].state, "unavailable");
});

test("S3c2a G6 any failed order, shape or catalogue read refuses the queue", async () => {
  for (const failure of ["actions", "shape", "fees"]) {
    const staff = new QueueFhir(), service = new QueueFhir();
    const predicate = (type: string, params: Record<string, string>) => failure === "actions" ? Boolean(params.code?.endsWith("|odos-plan-action-instance")) : failure === "shape" ? Boolean(params.identifier?.startsWith("urn:odos:encounter-exam-scope|")) : type === "ChargeItemDefinition";
    staff.failSearch = service.failSearch = predicate;
    const result = await handleFollowUpQueueRequest(deps(staff, service), request);
    assert.equal(result.status, 502, failure); assert.equal("rows" in (result.body as object), false);
  }
});

test("S3c2a G7 absent and explicitly empty remain distinct", async () => {
  assert.deepEqual(queue(undefined), { recorded: false });
  assert.deepEqual(queue([]), { recorded: true, rows: [] });
  assert.deepEqual((await handleFollowUpQueueRequest(deps(new QueueFhir()), request)).body, { recorded: false });
});

test("S3c2a G8 enforces authentication, chart.read and staff Encounter compartment before service reads", async () => {
  const staff = new QueueFhir(), service = new QueueFhir();
  const noAuth = await handleFollowUpQueueRequest({ ...deps(staff, service), authenticate: async () => null }, request);
  const noRole = await handleFollowUpQueueRequest({ ...deps(staff, service), authenticate: async () => ({ staffReference: actor.reference, actorRole: "forbidden" as never, fhir: staff }) }, request);
  assert.equal(noAuth.status, 401); assert.equal(noRole.status, 403); assert.deepEqual(staff.reads, []);
  service.failSearch = () => { assert.fail("service reads must follow compartment check"); };
  staff.failRead = 403;
  assert.equal((await handleFollowUpQueueRequest(deps(staff, service), request)).status, 403);
  assert.deepEqual(staff.reads, ["Encounter/e1"]);
});

test("S3c2a status mapping and client separation are read-only", async () => {
  for (const [status, expected] of [[401, 403], [404, 404], [410, 404], [503, 502]]) {
    const staff = new QueueFhir(); staff.failRead = status;
    assert.equal((await handleFollowUpQueueRequest(deps(staff), request)).status, expected);
  }
  const staff = new QueueFhir(), service = new QueueFhir();
  await new FhirEncounterExamScopeStore(service).pick("e1", "office-visit", actor, null, [], [proposed()]);
  staff.resources.push(buildProtocolBasic(order(), PROTOCOL_BASIC_CODES.planActionInstance));
  const before = JSON.stringify([staff.resources, service.resources]);
  const result = await handleFollowUpQueueRequest(deps(staff, service), request);
  assert.equal(result.status, 200);
  assert.equal(rows(result.body as ReturnType<typeof deriveFollowUpQueue>)[0].state, "already-ordered");
  assert.deepEqual(service.reads, []); assert.equal(JSON.stringify([staff.resources, service.resources]), before);
});

test("S3c2a G10 legacy proposals load unchanged and use catalogue then key labels", async () => {
  const fhir = new QueueFhir(), store = new FhirEncounterExamScopeStore(fhir);
  const legacy = [{ orderable: "fundus-photography", focus: "retina", sources: [{ kind: "profile" as const, profileKey: "old" }] }, { orderable: "erg", sources: [{ kind: "plan-set" as const, planSetKey: "old-plan" }] }];
  await store.pick("e1", "office-visit", actor, null, [], legacy);
  const stored = await store.get("e1");
  assert.deepEqual(stored.testsProposed, legacy);
  const output = rows(queue(stored.testsProposed));
  assert.deepEqual(output.map(r => r.label), ["Fundus photography — retina", "erg"]);
  assert.deepEqual(output[0].sources, ["from the old shape"]);
  assert.equal(rows(queue([legacy[0]], [fee(false)]))[0].label, "fundus-photography");
});

async function decisionRequest(dependencies: Parameters<typeof handleFollowUpQueueRequest>[0], body: unknown) {
  const { handleFollowUpDecisionRequest } = await import("../src/clinical-graph/follow-up-queue-endpoint.js");
  assert.equal(typeof handleFollowUpDecisionRequest, "function");
  return handleFollowUpDecisionRequest(dependencies, { ...request, body });
}
const mark = { orderable: "fundus-photography", focus: "optic nerve", decision: "not-today" };
const putBack = { ...mark, decision: "put-back" };
async function decisionFixture() {
  const staff = new QueueFhir(), service = new QueueFhir();
  const scope = new FhirEncounterExamScopeStore(service);
  await scope.pick("e1", "office-visit", actor, null, [], [proposed(), proposed({ focus: "retina" })]);
  const { buildProcedureFeeDefinition } = await import("../src/clinical-graph/procedure-fee-schedule.js");
  service.resources.push({ ...buildProcedureFeeDefinition(fee()), id: "photos" });
  return { staff, service, scope, dependencies: deps(staff, service) };
}
function decisionSnapshot(service: QueueFhir) {
  const record = service.resources.find(r => r.resourceType === "Basic" && r.identifier?.some(i => i.system === "urn:odos:encounter-follow-up-decisions")) as Basic | undefined;
  return record ? JSON.parse(record.extension![0].valueString!) : undefined;
}

test("S3c2b G1 T4 Not today survives reload, profile edit, second problem and explicit repick until Put back", async () => {
  const h = await decisionFixture();
  assert.equal((await decisionRequest(h.dependencies, mark)).status, 200);
  const original = decisionSnapshot(h.service);
  const profiles = new FhirFollowUpProfileStore(h.service);
  const profile = (await profiles.list()).find(p => p.profileKey === "glaucoma")!;
  const { versionId, ...editable } = profile;
  const check = async () => {
    const reply = await handleFollowUpQueueRequest(h.dependencies, request);
    assert.equal(reply.status, 200);
    assert.equal(rows(reply.body as any)[0].state, "not-today");
    assert.deepEqual(decisionSnapshot(h.service), original);
  };
  await check();
  await profiles.save({ ...editable, version: profile.version + 1, label: "Edited shape" }, versionId ?? null);
  await check();
  h.staff.resources.push({ resourceType: "Condition", id: "second-problem", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" } });
  await check();
  const current = await h.scope.get("e1");
  await h.scope.pick("e1", "office-visit", actor, current.versionId!, [profile], [proposed(), proposed({ focus: "retina" })]);
  await check();
  const reply = await decisionRequest(h.dependencies, putBack);
  assert.equal(reply.status, 200); assert.equal(rows(reply.body as any)[0].state, "for-review");
  assert.deepEqual(decisionSnapshot(h.service).decisions, {});
});

test("S3c2b G2 one focus decision leaves the same orderable other focus For review", async () => {
  const h = await decisionFixture();
  const reply = await decisionRequest(h.dependencies, mark);
  assert.equal(reply.status, 200);
  assert.deepEqual(rows(reply.body as any).map(r => r.state), ["not-today", "for-review"]);
});

test("S3c2b G3 orders beat decisions; decisions beat deactivated fees; Put back exposes Unavailable", async () => {
  const h = await decisionFixture();
  await decisionRequest(h.dependencies, mark);
  h.staff.resources.push(buildProtocolBasic(order(), PROTOCOL_BASIC_CODES.planActionInstance));
  assert.equal(rows((await handleFollowUpQueueRequest(h.dependencies, request)).body as any)[0].state, "already-ordered");
  h.staff.resources = [];
  h.service.resources = h.service.resources.map(r => r.resourceType === "ChargeItemDefinition" ? { ...r, status: "retired" } : r);
  assert.equal(rows((await handleFollowUpQueueRequest(h.dependencies, request)).body as any)[0].state, "not-today");
  assert.equal(rows((await decisionRequest(h.dependencies, putBack)).body as any)[0].state, "unavailable");
});

test("S3c2b G4 invalid transitions refuse; repeated decisions and inapplicable Put back never write", async () => {
  for (const state of ["already-ordered", "unavailable", "unknown"]) {
    const h = await decisionFixture();
    if (state === "already-ordered") h.staff.resources.push(buildProtocolBasic(order(), PROTOCOL_BASIC_CODES.planActionInstance));
    if (state === "unavailable") h.service.resources = h.service.resources.map(r => r.resourceType === "ChargeItemDefinition" ? { ...r, status: "retired" } : r);
    const before = JSON.stringify(h.service.resources);
    const reply = await decisionRequest(h.dependencies, state === "unknown" ? { ...mark, focus: "missing" } : mark);
    assert.equal(reply.status, 409, state); assert.deepEqual(reply.body, { error: "This test can no longer be marked Not today." });
    assert.equal(JSON.stringify(h.service.resources), before);
    assert.equal((await decisionRequest(h.dependencies, putBack)).status, 200);
    assert.equal(JSON.stringify(h.service.resources), before);
  }
  const h = await decisionFixture();
  await decisionRequest(h.dependencies, mark);
  const before = JSON.stringify(h.service.resources);
  const repeated = await decisionRequest({ ...h.dependencies, authenticate: async () => ({ staffReference: "Practitioner/second", actorRole: "staff", fhir: h.staff }) }, mark);
  assert.equal(repeated.status, 200); assert.equal(JSON.stringify(h.service.resources), before);
});

test("S3c2b G6 exhausted conflicts map to concurrent-edit after exactly three attempts", async () => {
  const h = await decisionFixture(); let attempts = 0;
  h.service.create = async () => { attempts++; throw Object.assign(new Error("competing create"), { status: 409 }); };
  const reply = await decisionRequest(h.dependencies, mark);
  assert.equal(reply.status, 409); assert.equal((reply.body as any).code, "concurrent-edit"); assert.equal(attempts, 3);
});

test("S3c2b G8 chart.write grants staff and provider and exposes canDecide only for shaped visits", async () => {
  for (const role of ["provider", "staff", "admin"] as const) {
    const h = await decisionFixture();
    const dependencies = { ...h.dependencies, authenticate: async () => ({ staffReference: actor.reference, actorRole: role, fhir: h.staff }) };
    const before = JSON.stringify(h.service.resources);
    const get = await handleFollowUpQueueRequest(dependencies, request);
    assert.equal(get.status, 200); assert.equal((get.body as any).canDecide, role !== "admin");
    const put = await decisionRequest(dependencies, mark);
    assert.equal(put.status, role === "admin" ? 403 : 200);
    if (role === "admin") assert.equal(JSON.stringify(h.service.resources), before);
    else assert.equal((put.body as any).canDecide, true);
  }
  assert.deepEqual((await handleFollowUpQueueRequest(deps(new QueueFhir()), request)).body, { recorded: false });
});

test("S3c2b G9 signed Encounter refuses with ordinary conflict and no write", async () => {
  const h = await decisionFixture();
  const read = h.staff.read.bind(h.staff);
  h.staff.read = async (...args) => ({ ...await read(...args), status: "finished" }) as any;
  const before = JSON.stringify(h.service.resources);
  const reply = await decisionRequest(h.dependencies, mark);
  assert.equal(reply.status, 409); assert.deepEqual(reply.body, { error: "Signed encounter cannot be edited." });
  assert.equal(JSON.stringify(h.service.resources), before);
});

test("S3c2b G10 Encounter compartment read precedes all service work in both handlers", async () => {
  for (const status of [401, 403, 404, 410]) {
    const h = await decisionFixture(); let searches = 0;
    h.staff.failRead = status;
    h.service.failSearch = () => { searches++; return true; };
    const before = JSON.stringify(h.service.resources);
    for (const result of [await handleFollowUpQueueRequest(h.dependencies, request), await decisionRequest(h.dependencies, mark)]) {
      assert.equal(result.status, [401,403].includes(status) ? 403 : 404);
    }
    assert.equal(searches, 0); assert.equal(JSON.stringify(h.service.resources), before);
  }
});

test("S3c2b G11 all downstream failures including HTTP statuses return 502 and no write", async () => {
  for (const kind of ["shape", "fees", "actions", "decisions"]) for (const status of [undefined, 401, 403, 404, 410]) {
    const h = await decisionFixture();
    for (const client of [h.staff, h.service]) {
      const search = client.search.bind(client);
      client.search = async (type, params = {}) => {
        const matches = kind === "shape" ? params.identifier?.startsWith("urn:odos:encounter-exam-scope|") : kind === "fees" ? type === "ChargeItemDefinition" : kind === "actions" ? params.code?.endsWith("|odos-plan-action-instance") : params.identifier?.startsWith("urn:odos:encounter-follow-up-decisions|");
        if (matches) throw Object.assign(new Error("synthetic downstream failure"), status ? { status } : {});
        return search(type, params);
      };
    }
    const before = JSON.stringify(h.service.resources);
    for (const reply of [await handleFollowUpQueueRequest(h.dependencies, request), await decisionRequest(h.dependencies, mark)]) {
      assert.equal(reply.status, 502, `${kind} ${status}`);
      assert.deepEqual(reply.body, { error: "The tests for this visit could not be loaded." });
    }
    assert.equal(JSON.stringify(h.service.resources), before);
  }
});

test("S3c2b strict body validation precedes Encounter and service reads", async () => {
  for (const body of [null, {}, { ...mark, extra: true }, { ...mark, decision: "accept" }, { ...mark, orderable: "" }, { ...mark, focus: 42 }]) {
    const h = await decisionFixture(); const before = JSON.stringify(h.service.resources);
    const reply = await decisionRequest(h.dependencies, body);
    assert.equal(reply.status, 400); assert.deepEqual(h.staff.reads, []); assert.equal(JSON.stringify(h.service.resources), before);
  }
});
