import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition, Condition, Encounter, Resource } from "@medplum/fhirtypes";
import {
  PROCEDURE_FEE_SEEDS,
  buildProcedureFeeDefinition,
  listProcedureFeeScheduleSnapshot,
  materializeAcceptedChargeProposals,
  saveProcedureFeeScheduleItem,
} from "../src/clinical-graph/procedure-fee-schedule.js";
import {
  handleProcedureFeeScheduleCreateRequest,
  handleProcedureFeeScheduleMutationRequest,
} from "../src/clinical-graph/procedure-fee-schedule-endpoint.js";
import {
  createAcceptedManualProcedureCharge,
  handleProcedureChargeCreateRequest,
  handleProcedureChargePatchRequest,
} from "../src/clinical-graph/manual-procedure-charge-endpoint.js";
import { handleProtocolApplyRequest, handleVisitChargeMutationRequest } from "../src/clinical-graph/protocol-endpoint.js";
import { GLAUCOMA_SUSPECT_PROTOCOL_V1 } from "../src/clinical-graph/protocol-fixtures.js";
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";
import type { ChargeProposal, ProtocolApplication } from "../src/clinical-graph/protocol-types.js";

const NOW = "2026-09-22T14:00:00.000Z";

class FeeFhir {
  readonly baseUrl = "http://localhost:8103/";
  readonly resources: Resource[] = [];
  writes = 0;
  nextId = 1;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const row = this.resources.find(item => item.resourceType === resourceType && item.id === id);
    if (!row) throw new Error(`${resourceType}/${id} missing`);
    return structuredClone(row) as T;
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    let rows = this.resources.filter(row => row.resourceType === resourceType);
    const [codeSystem, codeValue] = params.code?.split("|") ?? [];
    if (codeValue) rows = rows.filter(row => "code" in row && row.code?.coding?.some(code => code.system === codeSystem && code.code === codeValue));
    const [identifierSystem, identifierValue] = params.identifier?.split("|") ?? [];
    if (identifierValue) rows = rows.filter(row => "identifier" in row && Array.isArray(row.identifier) &&
      row.identifier.some(identifier => identifier.system === identifierSystem && identifier.value === identifierValue));
    if (params.subject) rows = rows.filter(row => "subject" in row && row.subject?.reference === params.subject);
    if (params.encounter) rows = rows.filter(row => "encounter" in row && row.encounter?.reference === params.encounter);
    if (params.status) rows = rows.filter(row => "status" in row && row.status === params.status);
    return { resourceType: "Bundle", type: "searchset", entry: rows
      .map(resource => ({ resource: structuredClone(resource) as T })) };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const saved = { ...structuredClone(resource), id: resource.id ?? `fee-${this.nextId++}`, meta: { versionId: "1" } } as T;
    this.resources.push(saved);
    this.writes += 1;
    return structuredClone(saved);
  }

  async createWithOutcome<T extends Resource>(resource: T): Promise<{ resource: T; created: boolean }> {
    return { resource: await this.create(resource), created: true };
  }

  async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex(row => row.resourceType === resourceType && row.id === id);
    if (index < 0) throw new Error(`${resourceType}/${id} missing`);
    const saved = { ...structuredClone(resource), id, meta: { versionId: String(Number(this.resources[index]!.meta?.versionId ?? "0") + 1) } } as T;
    this.resources[index] = saved;
    this.writes += 1;
    return structuredClone(saved);
  }
}

const feeAnswer = (value: unknown) => (value as { interpretation?: string }).interpretation;
const charges = (fhir: FeeFhir) => new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
const encounter = (): Encounter => ({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" },
  subject: { reference: "Patient/p1" }, diagnosis: [{ condition: { reference: "Condition/dx1" }, rank: 1 },
    { condition: { reference: "Condition/dx2" }, rank: 2 }] });

test("S3c2c2b2 G1 every seed has its fixed interpretation answer and custom absence stays unanswered", async () => {
  const fhir = new FeeFhir();
  fhir.resources.push({ ...buildProcedureFeeDefinition({ procedureConceptKey: "fundus-photography", display: "Fundus photography" }), id: "persisted-photo" });
  fhir.resources.push({ ...buildProcedureFeeDefinition({ procedureConceptKey: "custom-scan", display: "Custom scan" }), id: "custom" });

  const rows = await listProcedureFeeScheduleSnapshot(fhir);
  const byKey = new Map(rows.map(row => [row.procedureConceptKey, row]));
  assert.equal(PROCEDURE_FEE_SEEDS.length, 18);
  for (const seed of PROCEDURE_FEE_SEEDS) {
    const expected = seed.procedureConceptKey === "fundus-photography" ? "fundus-photo"
      : seed.procedureConceptKey === "scodi-optic-nerve" ? "oct"
        : seed.procedureConceptKey === "visual-field-threshold" ? "visual-field" : "not-required";
    assert.equal(feeAnswer(byKey.get(seed.procedureConceptKey)), expected, seed.procedureConceptKey);
  }
  assert.equal(Object.hasOwn(byKey.get("custom-scan")!, "interpretation"), false);
  assert.equal(fhir.writes, 0);
});

test("S3c2c2b2 G2 custom answers persist and an equal seed answer permits the rest of a save", async () => {
  const fhir = new FeeFhir();
  const deps = { authenticate: async () => ({ staffReference: "Practitioner/admin", actorRole: "admin" as const, fhir }) };
  const create = await handleProcedureFeeScheduleCreateRequest(deps, { authHeader: "Bearer admin", body: {
    action: "create", display: "Custom OCT", category: "procedure", interpretation: "oct", priceCents: 12000, active: true,
  } });
  assert.equal(create.status, 201);
  assert.equal(feeAnswer((create.body as { item: unknown }).item), "oct");
  const save = (key: string, body: Record<string, unknown>) => handleProcedureFeeScheduleMutationRequest(deps, {
    authHeader: "Bearer admin", params: { procedureConceptKey: key }, body: { action: "save", active: true, priceCents: 12000, ...body },
  });
  const omitted = await save("custom-oct", {});
  assert.equal(omitted.status, 200);
  assert.equal(feeAnswer((omitted.body as { item: unknown }).item), "oct");
  const changed = await save("custom-oct", { interpretation: "not-required" });
  assert.equal(changed.status, 200);
  assert.equal(feeAnswer((changed.body as { item: unknown }).item), "not-required");

  const equalSeed = await save("fundus-photography", { interpretation: "fundus-photo", priceCents: 18000 });
  assert.equal(equalSeed.status, 200);
  assert.equal((equalSeed.body as { item: { priceCents: number } }).item.priceCents, 18000);
  const before = fhir.writes;
  const differentSeed = await save("fundus-photography", { interpretation: "oct" });
  assert.equal(differentSeed.status, 400);
  assert.match((differentSeed.body as { error: string }).error, /Interpretation cannot be changed/);
  assert.equal(fhir.writes, before);
});

test("S3c2c2b2 G3 fee routes round-trip answers and reject unknown values without changing old creates", async () => {
  const fhir = new FeeFhir();
  const deps = { authenticate: async () => ({ staffReference: "Practitioner/admin", actorRole: "admin" as const, fhir }) };
  const create = (display: string, extra: Record<string, unknown>) => handleProcedureFeeScheduleCreateRequest(deps, {
    authHeader: "Bearer admin", body: { action: "create", display, category: "procedure", priceCents: null, active: true, ...extra },
  });
  assert.equal((await create("Custom imaging", { interpretation: "fundus-photo" })).status, 201);
  assert.equal(feeAnswer((await listProcedureFeeScheduleSnapshot(fhir)).find(row => row.procedureConceptKey === "custom-imaging")), "fundus-photo");
  const saved = await handleProcedureFeeScheduleMutationRequest(deps, { authHeader: "Bearer admin",
    params: { procedureConceptKey: "custom-imaging" }, body: { action: "save", interpretation: "oct", priceCents: null, active: true } });
  assert.equal(saved.status, 200);
  assert.equal(feeAnswer((saved.body as { item: unknown }).item), "oct");
  assert.equal((await create("Unknown imaging", { interpretation: "other" })).status, 400);
  const absent = await create("Imported custom", {});
  assert.equal(absent.status, 201);
  assert.equal(Object.hasOwn((absent.body as { item: object }).item, "interpretation"), false);
});

test("interpretation snapshot reads the fee answer and version without writing", async () => {
  const fhir = new FeeFhir();
  fhir.resources.push({ ...buildProcedureFeeDefinition({ procedureConceptKey: "custom-scan", display: "Custom scan" }), id: "custom", version: "7" });
  const feeModule = await import("../src/clinical-graph/procedure-fee-schedule.js") as unknown as {
    interpretationSnapshot?: (fhir: FeeFhir, key: string, at: string) => Promise<unknown>;
  };
  assert.equal(typeof feeModule.interpretationSnapshot, "function");
  assert.deepEqual(await feeModule.interpretationSnapshot!(fhir, "custom-scan", "2026-09-22T14:00:00.000Z"),
    { answer: "unanswered", feeVersion: "7", at: "2026-09-22T14:00:00.000Z" });
  assert.deepEqual(await feeModule.interpretationSnapshot!(fhir, "no-such-fee", "2026-09-22T14:00:00.000Z"),
    { answer: "unanswered", feeVersion: "none", at: "2026-09-22T14:00:00.000Z" });
  assert.deepEqual(await feeModule.interpretationSnapshot!(fhir, "fundus-photography", "2026-09-22T14:00:00.000Z"),
    { answer: "fundus-photo", feeVersion: "1", at: "2026-09-22T14:00:00.000Z" });
  assert.equal(fhir.writes, 0);
});

test("S3c2c2b2 G4a Visit procedure Add snapshots the custom fee answer, version and time", async () => {
  const fhir = new FeeFhir();
  fhir.resources.push(encounter(), { ...buildProcedureFeeDefinition({ procedureConceptKey: "custom-oct", display: "Custom OCT",
    billingCode: "SYNTH", interpretation: "oct" }), id: "custom-fee", version: "7" });
  const reply = await handleProcedureChargeCreateRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doc", actorRole: "provider" as const, fhir: fhir as never }),
    id: () => "synthetic", now: () => NOW,
  }, { authHeader: "Bearer doctor", params: { encounterId: "e1" }, body: { procedureConceptKey: "custom-oct" } });
  assert.equal(reply.status, 201);
  assert.deepEqual((reply.body as { proposal: ChargeProposal }).proposal.interpretation,
    { answer: "oct", feeVersion: "7", at: NOW });
  assert.deepEqual((await charges(fhir).list())[0]?.interpretation, { answer: "oct", feeVersion: "7", at: NOW });
});

test("S3c2c2b2 G6 accepting unanswered and absent custom fees records explicit unanswered snapshots", async () => {
  const fhir = new FeeFhir();
  fhir.resources.push({ ...buildProcedureFeeDefinition({ procedureConceptKey: "old-custom", display: "Old custom" }), id: "old-fee", version: "5" });
  for (const [key, version] of [["old-custom", "5"], ["missing-custom", "none"]]) {
    const reply = await createAcceptedManualProcedureCharge({ fhir: fhir as never, encounterId: "e1", procedureConceptKey: key,
      dxPointers: [], actor: "Practitioner/doc", proposalId: `manual-procedure-charge:${key}`, now: () => NOW });
    assert.equal(reply.status, 201);
    assert.deepEqual((reply.body as { proposal: ChargeProposal }).proposal.interpretation,
      { answer: "unanswered", feeVersion: version, at: NOW });
  }
  assert.equal((await charges(fhir).list()).length, 2);
});

test("S3c2c2b2 G4b Restore takes a fresh snapshot after the fee answer changes", async () => {
  const fhir = new FeeFhir();
  fhir.resources.push(encounter(), { ...buildProcedureFeeDefinition({ procedureConceptKey: "custom-oct", display: "Custom OCT",
    billingCode: "SYNTH", interpretation: "oct" }), id: "custom-fee", version: "7" });
  const id = "manual-procedure-charge:restore";
  const original = await createAcceptedManualProcedureCharge({ fhir: fhir as never, encounterId: "e1", procedureConceptKey: "custom-oct",
    dxPointers: [], actor: "Practitioner/doc", proposalId: id, now: () => NOW });
  assert.equal(original.status, 201);
  const deps = { authenticate: async () => ({ staffReference: "Practitioner/doc", actorRole: "provider" as const, fhir: fhir as never }),
    now: () => "2026-09-22T15:00:00.000Z" };
  const patch = (state: "removed" | "accepted") => handleProcedureChargePatchRequest(deps, {
    authHeader: "Bearer doctor", params: { encounterId: "e1", proposalId: id }, body: { state },
  });
  assert.equal((await patch("removed")).status, 200);
  const changed = await saveProcedureFeeScheduleItem(fhir, { procedureConceptKey: "custom-oct", interpretation: "not-required", active: true });
  assert.equal(changed.version, "8");
  assert.equal((await patch("accepted")).status, 200);
  assert.deepEqual((await charges(fhir).get(id))?.interpretation,
    { answer: "not-required", feeVersion: "8", at: "2026-09-22T15:00:00.000Z" });
});

test("S3c2c2b2 G4d Visit charge create and concept change take fresh snapshots while diagnosis edits keep one", async () => {
  const fhir = new FeeFhir();
  fhir.resources.push(encounter());
  let at = NOW;
  const deps = { authenticate: async () => ({ staffReference: "Practitioner/doc", actorRole: "provider" as const, fhir: fhir as never }),
    now: () => at };
  const mutate = (body: Record<string, unknown>) => handleVisitChargeMutationRequest(deps, {
    authHeader: "Bearer doctor", params: { encounterId: "e1" }, body,
  });
  const created = await mutate({ procedureConceptKey: "comprehensive-exam-new" });
  assert.equal(created.status, 200);
  assert.deepEqual((created.body as { proposal: ChargeProposal }).proposal.interpretation,
    { answer: "not-required", feeVersion: "1", at: NOW });
  at = "2026-09-22T15:00:00.000Z";
  const diagnosis = await mutate({ dxPointer: "Condition/dx2" });
  assert.equal(diagnosis.status, 200);
  assert.deepEqual((diagnosis.body as { proposal: ChargeProposal }).proposal.interpretation,
    { answer: "not-required", feeVersion: "1", at: NOW });
  const changed = await mutate({ procedureConceptKey: "intermediate-exam-new" });
  assert.equal(changed.status, 200);
  assert.deepEqual((changed.body as { proposal: ChargeProposal }).proposal.interpretation,
    { answer: "not-required", feeVersion: "1", at });
});

test("S3c2c2b2 G5 diagnosis patches preserve a charge snapshot through answer change and fee retirement", async () => {
  const fhir = new FeeFhir();
  fhir.resources.push(encounter(), { ...buildProcedureFeeDefinition({ procedureConceptKey: "custom-oct", display: "Custom OCT",
    billingCode: "SYNTH", interpretation: "oct" }), id: "custom-fee", version: "7" });
  const id = "manual-procedure-charge:retire";
  assert.equal((await createAcceptedManualProcedureCharge({ fhir: fhir as never, encounterId: "e1", procedureConceptKey: "custom-oct",
    dxPointers: ["Condition/dx1"], actor: "Practitioner/doc", proposalId: id, now: () => NOW })).status, 201);
  const original = { answer: "oct", feeVersion: "7", at: NOW };
  const patch = (dxPointer: string) => handleProcedureChargePatchRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doc", actorRole: "provider" as const, fhir: fhir as never }),
    now: () => "2026-09-22T15:00:00.000Z",
  }, { authHeader: "Bearer doctor", params: { encounterId: "e1", proposalId: id }, body: { dxPointer } });

  assert.equal((await patch("Condition/dx2")).status, 200);
  assert.deepEqual((await charges(fhir).get(id))?.interpretation, original);
  assert.equal((await saveProcedureFeeScheduleItem(fhir, { procedureConceptKey: "custom-oct", interpretation: "not-required", active: true })).version, "8");
  assert.equal((await patch("Condition/dx1")).status, 200);
  assert.deepEqual((await charges(fhir).get(id))?.interpretation, original);
  assert.equal((await saveProcedureFeeScheduleItem(fhir, { procedureConceptKey: "custom-oct", active: false })).active, false);
  assert.deepEqual((await charges(fhir).get(id))?.interpretation, original);
});

test("S3c2c2b2 G7 charge materialization remains byte-identical with or without the snapshot", async () => {
  const base: ChargeProposal = { id: "manual-procedure-charge:billing", encounterId: "e1", planActionRef: "manual-procedure-charge:billing",
    procedureConceptKey: "fundus-photography", units: 1, dxPointers: ["Condition/dx1"], evidenceRefs: [], coverageEvaluations: [],
    state: "accepted", provenance: { source: "clinician-entered", actor: "Practitioner/doc", at: NOW } };
  const run = async (proposal: ChargeProposal) => {
    const fhir = new FeeFhir();
    fhir.resources.push(encounter(), { ...buildProcedureFeeDefinition({ procedureConceptKey: "fundus-photography",
      display: "Fundus photography", billingCode: "SYNTH", priceCents: 7500 }), id: "fee-photo" });
    let current = proposal;
    const result = await materializeAcceptedChargeProposals({ fhir, feeScheduleFhir: fhir, encounterId: "e1",
      actorReference: "Practitioner/doc", now: () => NOW,
      charges: { list: async () => [current], save: async value => (current = value) },
      applications: { list: async () => [] as ProtocolApplication[], save: async value => value },
    });
    assert.deepEqual(result, { materialized: 1, finalized: 1 });
    return fhir.resources.find(row => row.resourceType === "ChargeItem");
  };
  const withSnapshot = await run({ ...base, interpretation: { answer: "fundus-photo", feeVersion: "1", at: NOW } });
  const withoutSnapshot = await run(base);
  assert.ok(withSnapshot && withoutSnapshot);
  assert.deepEqual(withSnapshot, withoutSnapshot);
});

test("S3c2c2b2 G4c protocol acceptCharges snapshots each staged proposal when it becomes accepted", async () => {
  const fhir = new FeeFhir();
  fhir.resources.push(encounter(), { resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" }, code: { coding: [{ code: "H40.021" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] } } satisfies Condition);
  const response = await handleProtocolApplyRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doc", actorRole: "provider" as const, fhir: fhir as never }),
    now: () => NOW,
  }, { authHeader: "Bearer doctor", body: { protocolId: GLAUCOMA_SUSPECT_PROTOCOL_V1.id,
    encounterId: "e1", patientId: "p1", diagnosis: { reference: "Condition/c1", code: "H40.021", confirmed: true },
    acceptCharges: true } });
  assert.equal(response.status, 200);
  const accepted = (await charges(fhir).list()).filter(row => row.state === "accepted");
  assert.equal(accepted.length, 5);
  for (const charge of accepted) {
    assert.deepEqual(charge.interpretation, { answer: charge.procedureConceptKey === "scodi-optic-nerve" ? "oct"
      : charge.procedureConceptKey === "visual-field-threshold" ? "visual-field"
        : charge.procedureConceptKey === "fundus-photography" ? "fundus-photo" : "not-required", feeVersion: "1", at: NOW },
    charge.procedureConceptKey);
  }
});
