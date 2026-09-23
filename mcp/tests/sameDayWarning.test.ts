import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Encounter, Resource } from "@medplum/fhirtypes";
import { FhirEncounterExamScopeStore } from "../src/clinical-graph/exam-scope-store.js";
import { buildProcedureFeeDefinition } from "../src/clinical-graph/procedure-fee-schedule.js";
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";
import type { ChargeProposal } from "../src/clinical-graph/protocol-types.js";
import { handleFollowUpAcceptRequest, handleProtocolSignCleanupRequest } from "../src/clinical-graph/protocol-endpoint.js";
import { handleFollowUpQueueRequest } from "../src/clinical-graph/follow-up-queue-endpoint.js";
import { handleProcedureChargeCreateRequest, handleProcedureChargesRequest } from "../src/clinical-graph/manual-procedure-charge-endpoint.js";

const MESSAGE = "Usually not billed together on the same day — document why both were needed.";
const AT = "2026-09-22T12:00:00.000Z";
const PHOTO = "fundus-photography", OCT = "scodi-optic-nerve";

class WarningFhir {
  readonly baseUrl = "http://localhost:18103/";
  resources: Resource[] = [];
  next = 1;
  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    const row = this.resources.find(row => row.resourceType === type && row.id === id);
    if (!row) throw Object.assign(new Error("Synthetic resource missing"), { status: 404 });
    return structuredClone(row) as T;
  }
  async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const rows = this.resources.filter(row => row.resourceType === type &&
      (!params.code || (row as Basic).code?.coding?.some(code => `${code.system}|${code.code}` === params.code)) &&
      (!params.identifier || (row as Basic).identifier?.some(id => `${id.system}|${id.value}` === params.identifier)) &&
      (!params.subject || (row as Encounter).subject?.reference === params.subject));
    return { resourceType: "Bundle", type: "searchset", entry: rows.map(resource => ({ resource: structuredClone(resource) as T })) };
  }
  async create<T extends Resource>(resource: T): Promise<T> {
    const saved = { ...structuredClone(resource), id: resource.id ?? `synthetic-${this.next++}`, meta: { versionId: "1" } } as T;
    this.resources.push(saved);
    return structuredClone(saved);
  }
  async update<T extends Resource>(type: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex(row => row.resourceType === type && row.id === id);
    assert.ok(index >= 0);
    const saved = { ...structuredClone(resource), id, meta: { versionId: String(Number(this.resources[index].meta?.versionId ?? "0") + 1) } } as T;
    this.resources[index] = saved;
    return structuredClone(saved);
  }
}

async function fixture(visits = [{ id: "e1", patient: "p1", day: "2026-09-22T08:00:00-04:00" }]) {
  const staff = new WarningFhir(), service = new WarningFhir();
  for (const visit of visits) {
    staff.resources.push({ resourceType: "Encounter", id: visit.id, status: "in-progress", class: { code: "AMB" }, subject: { reference: `Patient/${visit.patient}` }, ...(visit.day ? { period: { start: visit.day } } : {}) });
    await new FhirEncounterExamScopeStore(service).pick(visit.id, "office-visit", { reference: "Practitioner/synthetic" }, null, [],
      [OCT, PHOTO].map(orderable => ({ orderable, label: orderable, sources: [{ kind: "profile" as const, profileKey: "glaucoma" }] })));
  }
  for (const key of [OCT, PHOTO, "practice-oct"]) {
    const definition = { ...buildProcedureFeeDefinition({ procedureConceptKey: key, display: key, category: "procedure", priceCents: 6000, billingCode: "SYNTHETIC", interpretation: key === PHOTO ? "fundus-photo" : "oct" }), id: `fee-${key}`, meta: { versionId: "1" } };
    service.resources.push(structuredClone(definition));
    staff.resources.push(structuredClone(definition));
  }
  const deps = { authenticate: async () => ({ staffReference: "Practitioner/synthetic", actorRole: "provider" as const, fhir: staff as any }), serviceFhir: service as any, feeScheduleFhir: service as any, now: () => AT };
  const request = (encounterId: string) => ({ authHeader: "Bearer synthetic", params: { encounterId } });
  const charges = new ProtocolBasicStore<ChargeProposal>(staff, PROTOCOL_BASIC_CODES.chargeProposal);
  return { staff, service, deps, charges,
    accept: (key: string, encounterId = "e1") => handleFollowUpAcceptRequest(deps, { ...request(encounterId), body: { orderable: key } }),
    queue: (encounterId = "e1") => handleFollowUpQueueRequest(deps, request(encounterId)),
    visit: (encounterId = "e1") => handleProcedureChargesRequest(deps, request(encounterId)),
    custom: () => handleProcedureChargeCreateRequest(deps, { ...request("e1"), body: { procedureConceptKey: "practice-oct" } }),
    sign: () => handleProtocolSignCleanupRequest(deps, request("e1")),
  };
}
function billed(result: { status: number; body: unknown }) {
  assert.equal(result.status, 200);
  return (result.body as { rows: Array<{ orderable: string; charge?: { status: string; proposalId?: string; sameDayWarning?: string } }> }).rows.filter(row => row.charge?.status === "billed");
}
function warnings(result: { status: number; body: unknown }) {
  return billed(result).map(row => [row.orderable, row.charge?.sameDayWarning]);
}

test("S3c2c2b3b G1 same-visit pair warns both in the second Accept response", async () => {
  const h = await fixture();
  assert.deepEqual(warnings(await h.accept(OCT)), [[OCT, undefined]]);
  assert.deepEqual(warnings(await h.accept(PHOTO)), [[OCT, MESSAGE], [PHOTO, MESSAGE]]);
});

test("S3c2c2b3b G2 pair across same-day visits warns the first visit", async () => {
  const h = await fixture([{ id: "e1", patient: "p1", day: "2026-09-22T08:00:00-04:00" }, { id: "e2", patient: "p1", day: "2026-09-22T15:00:00-04:00" }]);
  assert.equal((await h.accept(PHOTO)).status, 200);
  assert.equal((await h.accept(OCT, "e2")).status, 200);
  assert.deepEqual(warnings(await h.queue()), [[PHOTO, MESSAGE]]);
});

for (const [guard, patient, day] of [["G3 different service day", "p1", "2026-09-23T08:00:00-04:00"], ["G4 another patient", "p2", "2026-09-22T08:00:00-04:00"]]) {
  test(`S3c2c2b3b ${guard} never contributes to the warning`, async () => {
    const h = await fixture([{ id: "e1", patient: "p1", day: "2026-09-22T08:00:00-04:00" }, { id: "e2", patient, day }]);
    assert.equal((await h.accept(PHOTO)).status, 200);
    assert.equal((await h.accept(OCT, "e2")).status, 200);
    assert.deepEqual(warnings(await h.queue()), [[PHOTO, undefined]]);
    assert.equal(Object.hasOwn((await h.visit()).body, "sameDayWarnings"), false);
  });
}

test("S3c2c2b3b G5 a practice OCT fee pairs by image type on both endpoints; two OCTs do not pair", async () => {
  const h = await fixture();
  const custom = await h.custom();
  assert.equal(custom.status, 201);
  assert.equal((await h.accept(OCT)).status, 200);
  assert.deepEqual(warnings(await h.queue()), [[OCT, undefined]]);
  assert.equal(Object.hasOwn((await h.visit()).body, "sameDayWarnings"), false);
  assert.equal((await h.accept(PHOTO)).status, 200);
  assert.deepEqual(warnings(await h.queue()), [[OCT, MESSAGE], [PHOTO, MESSAGE]]);
  const result = await h.visit();
  assert.equal(result.status, 200);
  const expected = (await h.charges.list()).map(proposal => ({ proposalId: proposal.id, message: MESSAGE })).sort((a,b) => a.proposalId.localeCompare(b.proposalId));
  assert.deepEqual((result.body as any).sameDayWarnings.sort((a: any,b: any) => a.proposalId.localeCompare(b.proposalId)), expected);
});

for (const state of ["staged", "removed", "overridden", "finalized"] as const) {
  test(`S3c2c2b3b G6 ${state} OCT on an earlier visit contributes only when finalized`, async () => {
    const h = await fixture([{ id: "e1", patient: "p1", day: "2026-09-22T15:00:00-04:00" }, { id: "e2", patient: "p1", day: "2026-09-22T08:00:00-04:00" }]);
    assert.equal((await h.accept(OCT, "e2")).status, 200);
    const oct = (await h.charges.list())[0];
    await h.charges.save({ ...oct, state });
    if (state === "finalized") {
      const encounter = await h.staff.read<Encounter>("Encounter", "e2");
      await h.staff.update("Encounter", "e2", { ...encounter, status: "finished" });
    }
    assert.equal((await h.accept(PHOTO)).status, 200);
    assert.deepEqual(warnings(await h.queue()), [[PHOTO, state === "finalized" ? MESSAGE : undefined]]);
  });
}

test("S3c2c2b3b G7 pair never blocks Accept, mutates stored charges on read, or changes sign cleanup", async () => {
  const h = await fixture();
  assert.equal((await h.accept(OCT)).status, 200);
  assert.equal((await h.accept(PHOTO)).status, 200);
  assert.deepEqual((await h.charges.list()).map(p => p.state), ["accepted", "accepted"]);
  const beforeSign = await h.sign();
  assert.equal(beforeSign.status, 409);
  assert.equal((beforeSign.body as any).code, "interpretation-required");
  const before = JSON.stringify(h.staff.resources);
  assert.deepEqual(warnings(await h.queue()), [[OCT, MESSAGE], [PHOTO, MESSAGE]]);
  assert.equal((await h.visit()).status, 200);
  assert.equal(JSON.stringify(h.staff.resources), before);
  assert.deepEqual(await h.sign(), beforeSign);
});

test("S3c2c2b3b G8 no pair means warning keys are absent", async () => {
  const h = await fixture();
  assert.equal((await h.accept(PHOTO)).status, 200);
  for (const row of billed(await h.queue())) assert.equal(Object.hasOwn(row.charge!, "sameDayWarning"), false);
  const visit = await h.visit();
  assert.equal(visit.status, 200);
  assert.equal(Object.hasOwn(visit.body, "sameDayWarnings"), false);
});

test("S3c2c2b3b G9 service day preserves the written offset and never pairs the next local day", async () => {
  const h = await fixture([{ id: "e1", patient: "p1", day: "2026-09-22T23:30:00-04:00" }, { id: "e2", patient: "p1", day: "2026-09-22T08:00:00-04:00" }, { id: "e3", patient: "p1", day: "2026-09-23T00:10:00-04:00" }]);
  assert.equal((await h.accept(OCT)).status, 200);
  assert.equal((await h.accept(PHOTO, "e2")).status, 200);
  assert.equal((await h.accept(PHOTO, "e3")).status, 200);
  assert.deepEqual(warnings(await h.queue("e2")), [[PHOTO, MESSAGE]]);
  assert.deepEqual(warnings(await h.queue("e3")), [[PHOTO, undefined]]);
});

test("S3c2c2b3b missing service day never warns", async () => {
  const h = await fixture([{ id: "e1", patient: "p1", day: "" }]);
  assert.equal((await h.accept(OCT)).status, 200);
  assert.equal((await h.accept(PHOTO)).status, 200);
  assert.deepEqual(warnings(await h.queue()), [[OCT, undefined], [PHOTO, undefined]]);
});
