import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { ProtocolService } from "../src/clinical-graph/protocol-service.js";
import type { ChargeProposal, PlanActionInstance } from "../src/clinical-graph/protocol-types.js";
import { FhirEncounterExamScopeStore, type ProposedExamTest } from "../src/clinical-graph/exam-scope-store.js";
import { buildProcedureFeeDefinition } from "../src/clinical-graph/procedure-fee-schedule.js";
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";

const AT = "2026-09-21T14:00:00.000Z";

class FollowUpFhir {
  readonly baseUrl = "http://localhost:8103/";
  resources: Resource[] = [];
  writes: string[] = [];
  reads: string[] = [];
  next = 1;
  failServiceRequest = false;
  failCharge = false;
  failEncounterStatus?: number;

  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    this.reads.push(`${type}/${id}`);
    if (type === "Encounter" && this.failEncounterStatus) throw Object.assign(new Error("Encounter unreadable"), { status: this.failEncounterStatus });
    const found = this.resources.find(row => row.resourceType === type && row.id === id);
    if (!found) throw Object.assign(new Error(`${type}/${id} missing`), { status: 404 });
    return structuredClone(found) as T;
  }

  async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const [codeSystem, codeValue] = params.code?.split("|") ?? [];
    const [identifierSystem, identifierValue] = params.identifier?.split("|") ?? [];
    const rows = this.resources.filter(row => row.resourceType === type &&
      (!codeValue || ((row as Basic).code?.coding ?? []).some(code => code.system === codeSystem && code.code === codeValue)) &&
      (!identifierValue || ((row as Basic).identifier ?? []).some(identifier => identifier.system === identifierSystem && identifier.value === identifierValue)));
    return { resourceType: "Bundle", type: "searchset", entry: rows.map(resource => ({ resource: structuredClone(resource) as T })) };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    if (resource.resourceType === "ServiceRequest" && this.failServiceRequest) throw new Error("ServiceRequest unavailable");
    if (resource.resourceType === "Basic" && resource.code?.coding?.some(code => code.code === PROTOCOL_BASIC_CODES.chargeProposal) && this.failCharge) throw new Error("Charge unavailable");
    const saved = { ...structuredClone(resource), id: resource.id ?? `r${this.next++}`, meta: { versionId: "1" } } as T;
    this.resources.push(saved);
    this.writes.push(`create:${saved.resourceType}`);
    return structuredClone(saved);
  }

  async update<T extends Resource>(type: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex(row => row.resourceType === type && row.id === id);
    if (index < 0) throw new Error(`${type}/${id} missing for update`);
    const saved = { ...structuredClone(resource), id, meta: { versionId: String(Number(this.resources[index].meta?.versionId ?? "0") + 1) } } as T;
    this.resources[index] = saved;
    this.writes.push(`update:${type}`);
    return structuredClone(saved);
  }
}

function existingOrder(): PlanActionInstance {
  return {
    id: "glaucoma-order", encounterId: "e1", patientId: "p1", protocolApplicationId: null,
    actionType: "order", state: "selected", mergeKey: "order:fundus-photography",
    linkedDx: [], linkedFindings: [], modifiedFields: [], payload: { orderableKey: "fundus-photography", focus: "optic nerve" },
    provenance: { source: "clinician-entered", actor: "Practitioner/synthetic", at: AT },
  };
}

test("S3c2c1b G13 queue order creates a distinct materialized action without a merge identity", async () => {
  const fhir = new FollowUpFhir();
  let next = 1;
  const service = new ProtocolService(fhir, {
    async commitFinding() { return undefined; },
    async materializeAction() { return `ServiceRequest/sr-${next++}`; },
  }, () => AT, () => `queue-${next++}`);
  await service.actions.save(existingOrder());
  const retina = await service.addQueueOrder({ encounterId: "e1", patientId: "p1", orderable: "fundus-photography", focus: "retina", actor: "Practitioner/synthetic", linkedDx: [] });
  const actions = await service.actions.list();
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map(action => action.payload.focus), ["optic nerve", "retina"]);
  assert.equal(Object.hasOwn(retina, "mergeKey"), false);
  assert.equal(retina.protocolApplicationId, null);
  assert.equal(retina.state, "selected");
  assert.match(retina.materializedFhirRef ?? "", /^ServiceRequest\/sr-/);
});

const optic: ProposedExamTest = { orderable: "fundus-photography", focus: "optic nerve", label: "Optic nerve photos", sources: [{ kind: "profile", profileKey: "glaucoma" }] };
const retina: ProposedExamTest = { orderable: "fundus-photography", focus: "retina", label: "Retina photos", sources: [{ kind: "profile", profileKey: "macula-retina" }] };
const actor = { reference: "Practitioner/synthetic" };

async function acceptFixture(tests: ProposedExamTest[] = [optic], coded = true) {
  const { handleFollowUpAcceptRequest } = await import("../src/clinical-graph/protocol-endpoint.js");
  const staff = new FollowUpFhir(), service = new FollowUpFhir();
  staff.resources.push({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p1" } });
  await new FhirEncounterExamScopeStore(service).pick("e1", "office-visit", actor, null, [], tests);
  service.resources.push({ ...buildProcedureFeeDefinition({ procedureConceptKey: "fundus-photography", display: "Fundus photography", category: "procedure", priceCents: 6000, ...(coded ? { billingCode: "SYNTHETIC" } : {}) }), id: "fee-photos" });
  const deps = { authenticate: async () => ({ staffReference: actor.reference, actorRole: "provider" as const, fhir: staff as any }), serviceFhir: service as any, now: () => AT };
  const accept = (focus = "optic nerve", overrides: Partial<typeof deps> = {}) => handleFollowUpAcceptRequest({ ...deps, ...overrides }, {
    authHeader: "Bearer synthetic", params: { encounterId: "e1" }, body: { orderable: "fundus-photography", focus },
  });
  const actions = () => new ProtocolBasicStore<PlanActionInstance>(staff, PROTOCOL_BASIC_CODES.planActionInstance).list();
  const charges = () => new ProtocolBasicStore<ChargeProposal>(staff, PROTOCOL_BASIC_CODES.chargeProposal).list();
  return { staff, service, deps, accept, actions, charges };
}

test("S3c2c1b G1 Accept creates one ServiceRequest and one accepted manual charge linked to the order", async () => {
  const h = await acceptFixture();
  const reply = await h.accept();
  assert.equal(reply.status, 200);
  const actions = await h.actions(), charges = await h.charges();
  assert.equal(actions.length, 1);
  assert.equal(h.staff.resources.filter(row => row.resourceType === "ServiceRequest").length, 1);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].state, "accepted");
  assert.equal(charges[0].planActionRef, charges[0].id);
  assert.equal(charges[0].units, 1);
  assert.equal(actions[0].chargeProposalRef, charges[0].id);
  assert.equal((reply.body as any).rows[0].state, "already-ordered");
  assert.equal((reply.body as any).rows[0].charge.status, "billed");
});

test("S3c2c1b G2 concurrent Accept clicks leave one live order and one live charge", async () => {
  const h = await acceptFixture();
  const replies = await Promise.all([h.accept(), h.accept()]);
  assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
  assert.equal((await h.actions()).filter(action => action.state !== "removed").length, 1);
  assert.equal((await h.charges()).filter(charge => charge.state !== "removed").length, 1);
});

test("S3c2c1b G3 two photo focuses create two orders sharing one charge", async () => {
  const h = await acceptFixture([optic, retina]);
  assert.equal((await h.accept()).status, 200);
  const reply = await h.accept("retina");
  assert.equal(reply.status, 200);
  const actions = await h.actions(), charges = await h.charges();
  assert.equal(actions.length, 2);
  assert.equal(h.staff.resources.filter(row => row.resourceType === "ServiceRequest").length, 2);
  assert.equal(charges.length, 1);
  assert.deepEqual(actions.map(action => action.chargeProposalRef), [charges[0].id, charges[0].id]);
  assert.deepEqual((reply.body as any).rows.map((row: any) => row.charge.status), ["billed", "billed"]);
  const { handleProcedureChargePatchRequest } = await import("../src/clinical-graph/manual-procedure-charge-endpoint.js");
  const removal = await handleProcedureChargePatchRequest({ authenticate: h.deps.authenticate }, {
    authHeader: "Bearer synthetic", params: { encounterId: "e1", proposalId: charges[0].id }, body: { state: "removed" },
  });
  assert.equal(removal.status, 200);
  const { handleFollowUpQueueRequest } = await import("../src/clinical-graph/follow-up-queue-endpoint.js");
  const after = await handleFollowUpQueueRequest({ authenticate: h.deps.authenticate, serviceFhir: h.service as any }, { authHeader: "Bearer synthetic", params: { encounterId: "e1" } });
  assert.deepEqual((after.body as any).rows.map((row: any) => row.charge.status), ["removed", "removed"]);
});

test("S3c2c1b G4 existing protocol and Visit charges block another charge", async () => {
  for (const kind of ["protocol", "visit"] as const) {
    const h = await acceptFixture();
    const id = kind === "visit" ? "manual-procedure-charge:visit" : "protocol-charge";
    const proposal: ChargeProposal = {
      id, encounterId: "e1", planActionRef: kind === "visit" ? id : "protocol-order",
      procedureConceptKey: "fundus-photography", units: 1, dxPointers: [], evidenceRefs: [], coverageEvaluations: [],
      state: kind === "visit" ? "accepted" : "staged",
      provenance: { source: "clinician-entered", actor: actor.reference, at: AT },
    };
    await new ProtocolBasicStore<ChargeProposal>(h.staff, PROTOCOL_BASIC_CODES.chargeProposal).save(proposal);
    const reply = await h.accept();
    assert.equal(reply.status, 200, kind);
    assert.equal((await h.actions()).length, 1);
    assert.equal((await h.charges()).length, 1);
    assert.equal((reply.body as any).rows[0].charge.status, kind === "visit" ? "billed" : "protocol-pending");
    assert.equal((await h.actions())[0].chargeProposalRef, kind === "visit" ? id : undefined);
  }
});

test("S3c2c1b G5 an active uncoded fee orders without a charge or Add charge", async () => {
  const h = await acceptFixture([optic], false);
  const reply = await h.accept();
  assert.equal(reply.status, 200);
  assert.equal((await h.actions()).length, 1);
  assert.equal((await h.charges()).length, 0);
  assert.equal((reply.body as any).rows[0].charge.status, "uncoded");
});

test("S3c2c1b G6 order materialization fails cleanly and charge failure leaves an Add charge path", async () => {
  const materialization = await acceptFixture();
  materialization.staff.failServiceRequest = true;
  assert.equal((await materialization.accept()).status, 502);
  assert.equal((await materialization.actions()).filter(action => action.state !== "removed").length, 0);
  assert.equal((await materialization.charges()).length, 0);
  const { handleFollowUpQueueRequest } = await import("../src/clinical-graph/follow-up-queue-endpoint.js");
  const queue = (h: Awaited<ReturnType<typeof acceptFixture>>) => handleFollowUpQueueRequest({ authenticate: h.deps.authenticate, serviceFhir: h.service as any }, { authHeader: "Bearer synthetic", params: { encounterId: "e1" } });
  assert.equal(((await queue(materialization)).body as any).rows[0].state, "for-review");
  const charge = await acceptFixture();
  charge.staff.failCharge = true;
  assert.equal((await charge.accept()).status, 502);
  assert.equal((await charge.actions()).filter(action => action.state !== "removed").length, 1);
  assert.equal((await charge.charges()).length, 0);
  assert.equal(((await queue(charge)).body as any).rows[0].charge.status, "none");
  charge.staff.failCharge = false;
  const retried = await charge.accept();
  assert.equal(retried.status, 200);
  assert.equal((await charge.actions()).length, 1);
  assert.equal((await charge.charges()).length, 1);
  assert.equal((retried.body as any).rows[0].charge.status, "billed");
  const serviceRequestIndex = charge.staff.resources.findIndex(row => row.resourceType === "ServiceRequest");
  const chargeIndex = charge.staff.resources.findIndex(row => row.resourceType === "Basic" && row.code?.coding?.some(code => code.code === PROTOCOL_BASIC_CODES.chargeProposal));
  assert.ok(serviceRequestIndex >= 0 && serviceRequestIndex < chargeIndex);
  const feeRead = await acceptFixture();
  const search = feeRead.service.search.bind(feeRead.service);
  let feeReads = 0;
  feeRead.service.search = (async (type: Resource["resourceType"], params: Record<string, string> = {}) => {
    if (type === "ChargeItemDefinition" && ++feeReads === 2) throw new Error("Fee read unavailable after order");
    return search(type, params);
  }) as typeof feeRead.service.search;
  assert.equal((await feeRead.accept()).status, 502);
  assert.equal((await feeRead.actions()).filter(action => action.state !== "removed").length, 0);
  assert.equal((await feeRead.charges()).length, 0);
  assert.equal((feeRead.staff.resources.find(row => row.resourceType === "ServiceRequest") as any)?.status, "revoked");
  feeRead.service.search = search;
  assert.equal(((await queue(feeRead)).body as any).rows[0].state, "for-review");
});

test("S3c2c1b G7 retina photos choose matching macular diagnosis over the principal glaucoma problem", async () => {
  const { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } = await import("../src/clinical-graph/diagnosis-pick-endpoint.js");
  const h = await acceptFixture([retina]);
  const encounter = h.staff.resources.find(row => row.resourceType === "Encounter") as any;
  encounter.diagnosis = [{ condition: { reference: "Condition/glaucoma" }, rank: 1 }, { condition: { reference: "Condition/macula" }, rank: 2 }, { condition: { reference: "Condition/macula-second" }, rank: 3 }];
  h.staff.resources.push(
    { resourceType: "Condition", id: "glaucoma", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" }, code: { text: "Glaucoma" }, identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: "poag_mild" }] },
    { resourceType: "Condition", id: "macula", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" }, code: { text: "Macular drusen" }, identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: "macular_drusen" }] },
    { resourceType: "Condition", id: "macula-second", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" }, code: { text: "Second macular problem" }, identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: "macular_drusen" }] },
  );
  const { handleFollowUpQueueRequest } = await import("../src/clinical-graph/follow-up-queue-endpoint.js");
  const queue = await handleFollowUpQueueRequest({ authenticate: h.deps.authenticate, serviceFhir: h.service as any }, { authHeader: "Bearer synthetic", params: { encounterId: "e1" } });
  assert.equal(queue.status, 200);
  const reply = await h.accept("retina");
  assert.equal(reply.status, 200);
  assert.deepEqual((await h.charges())[0].dxPointers, ["Condition/macula"]);
  assert.deepEqual((await h.actions())[0].linkedDx, ["Condition/macula"]);
  const unmatched = await acceptFixture([retina]);
  assert.equal((await unmatched.accept("retina")).status, 200);
  assert.deepEqual((await unmatched.charges())[0].dxPointers, []);
});

test("S3c2c1b G8 chart.read-only, signed, and unreadable encounters refuse before writes", async () => {
  const readOnly = await acceptFixture();
  const noWrite = await readOnly.accept("optic nerve", { authenticate: async () => ({ staffReference: actor.reference, actorRole: "admin" as const, fhir: readOnly.staff as any }) });
  assert.equal(noWrite.status, 403);
  assert.equal(readOnly.staff.writes.length, 0);
  assert.deepEqual(readOnly.staff.reads, []);
  const anonymous = await acceptFixture();
  assert.equal((await anonymous.accept("optic nerve", { authenticate: async () => null })).status, 401);
  assert.deepEqual(anonymous.staff.reads, []);
  const invalid = await acceptFixture();
  const { handleFollowUpAcceptRequest } = await import("../src/clinical-graph/protocol-endpoint.js");
  assert.equal((await handleFollowUpAcceptRequest(invalid.deps, { authHeader: "Bearer synthetic", params: { encounterId: "e1" }, body: { orderable: "fundus-photography", extra: true } })).status, 400);
  assert.deepEqual(invalid.staff.reads, []);
  const signed = await acceptFixture();
  (signed.staff.resources.find(row => row.resourceType === "Encounter") as any).status = "finished";
  const refused = await signed.accept();
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: "Signed encounter cannot be edited." });
  assert.equal(signed.staff.writes.length, 0);
  const compartment = await acceptFixture();
  compartment.staff.failEncounterStatus = 403;
  assert.equal((await compartment.accept()).status, 403);
  assert.equal(compartment.staff.writes.length, 0);
});

test("S3c2c2a1 G10 a result before Accept leaves the row eligible for Accept", async () => {
  const { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } = await import("../src/fhir/ophthalmology/codeBindings.js");
  const { handleFollowUpQueueRequest } = await import("../src/clinical-graph/follow-up-queue-endpoint.js");
  const h = await acceptFixture();
  h.staff.resources.push({ resourceType: "Media", id: "photo-1", status: "completed", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
    modality: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "fundus-photo" }] }, content: { contentType: "image/jpeg", title: "synthetic.jpg" },
  });
  const queue = await handleFollowUpQueueRequest({ authenticate: h.deps.authenticate, serviceFhir: h.service as any }, { authHeader: "Bearer synthetic", params: { encounterId: "e1" } });
  assert.equal(queue.status, 200);
  assert.equal((queue.body as any).rows[0].state, "for-review");
  assert.equal((queue.body as any).rows[0].unreviewedResult, true);
  assert.equal((await h.accept()).status, 200);
});

test("S3c2c2a1 G12 Accept refuses every ineligible row with 409 and zero new writes", async () => {
  const { FhirFollowUpDecisionStore } = await import("../src/clinical-graph/follow-up-decision-store.js");
  const notToday = await acceptFixture();
  await new FhirFollowUpDecisionStore(notToday.service as any).apply("e1", { orderable: optic.orderable, focus: optic.focus, decision: "not-today" }, actor);
  const cases: Array<{ name: string; h: Awaited<ReturnType<typeof acceptFixture>>; focus?: string }> = [{ name: "not-today", h: notToday }];
  const unavailable = await acceptFixture();
  (unavailable.service.resources.find(row => row.resourceType === "ChargeItemDefinition") as any).status = "retired";
  cases.push({ name: "unavailable", h: unavailable });
  const billed = await acceptFixture();
  assert.equal((await billed.accept()).status, 200);
  cases.push({ name: "billed", h: billed });
  const removed = await acceptFixture();
  assert.equal((await removed.accept()).status, 200);
  const { handleProcedureChargePatchRequest } = await import("../src/clinical-graph/manual-procedure-charge-endpoint.js");
  const proposalId = (await removed.charges())[0]!.id;
  assert.equal((await handleProcedureChargePatchRequest({ authenticate: removed.deps.authenticate }, {
    authHeader: "Bearer synthetic", params: { encounterId: "e1", proposalId }, body: { state: "removed" },
  })).status, 200);
  cases.push({ name: "removed", h: removed });
  const uncoded = await acceptFixture([optic], false);
  assert.equal((await uncoded.accept()).status, 200);
  cases.push({ name: "uncoded", h: uncoded });
  cases.push({ name: "not-on-visit", h: await acceptFixture(), focus: "retina" });
  for (const { name, h, focus } of cases) {
    const before = h.staff.writes.length;
    const reply = await h.accept(focus ?? "optic nerve");
    assert.equal(reply.status, 409, name);
    assert.equal(h.staff.writes.length, before, name);
  }
});
