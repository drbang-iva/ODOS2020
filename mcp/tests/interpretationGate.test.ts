import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, DiagnosticReport, Encounter, Media, Resource } from "@medplum/fhirtypes";
import { interpretationBlocks, loadInterpretationBlocks } from "../src/clinical-graph/interpretation-gate.js";
import type { ProcedureFeeScheduleItem } from "../src/clinical-graph/procedure-fee-schedule.js";
import type { ChargeProposal, PlanActionInstance, ProtocolApplication } from "../src/clinical-graph/protocol-types.js";
import { materializeAcceptedChargeProposals } from "../src/clinical-graph/procedure-fee-schedule.js";
import { InterpretationRequiredError } from "../src/clinical-graph/interpretation-gate.js";
import { ProtocolService } from "../src/clinical-graph/protocol-service.js";
import { handleProtocolSignCleanupRequest } from "../src/clinical-graph/protocol-endpoint.js";

const at = "2026-09-22T12:00:00.000Z";
const proposal = (key: string, answer?: NonNullable<ChargeProposal["interpretation"]>["answer"]): ChargeProposal => ({
  id: `p-${key}`, encounterId: "e1", planActionRef: "synthetic", procedureConceptKey: key,
  units: 1, dxPointers: [], evidenceRefs: [], coverageEvaluations: [], state: "accepted",
  ...(answer ? { interpretation: { answer, feeVersion: "1", at } } : {}),
  provenance: { source: "clinician-entered", actor: "Practitioner/synthetic", at },
});
const fee = (key: string, interpretation?: ProcedureFeeScheduleItem["interpretation"]): ProcedureFeeScheduleItem => ({
  id: key, procedureConceptKey: key, display: key, active: true, version: "1", interpretation,
});
const order = (id: string, key: string, state: PlanActionInstance["state"] = "selected"): PlanActionInstance => ({
  id, encounterId: "e1", patientId: "p1", protocolApplicationId: null,
  actionType: "order", state, payload: { orderableKey: key },
  linkedDx: [], linkedFindings: [], modifiedFields: [], materializedFhirRef: `ServiceRequest/${id}`,
  provenance: { source: "clinician-entered", actor: "Practitioner/synthetic", at },
});
const media = (id: string, type: string, basedOn?: string): Media => ({
  resourceType: "Media", id, status: "completed", subject: { reference: "Patient/p1" },
  encounter: { reference: "Encounter/e1" }, modality: { coding: [{ code: type }] },
  content: { contentType: "image/jpeg", url: `Binary/${id}` },
  ...(basedOn ? { basedOn: [{ reference: basedOn }] } : {}),
});
const report = (id: string, status: DiagnosticReport["status"], mediaId: string, conclusion = "Interpretation"): DiagnosticReport => ({
  resourceType: "DiagnosticReport", id, status, code: { text: "Synthetic" },
  subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
  conclusion, media: [{ link: { reference: `Media/${mediaId}` } }],
});
const input = (overrides: Partial<Parameters<typeof interpretationBlocks>[0]> = {}) => ({
  encounterId: "e1", proposals: [proposal("fundus-photography")], actions: [] as PlanActionInstance[],
  fees: [fee("fundus-photography", "fundus-photo")], mediaRows: [] as Media[], reports: [] as DiagnosticReport[],
  ...overrides,
});

test("G1/G2/G3 ordered imaging requires a counting report on any live order of its concept", () => {
  const actions = [order("optic", "fundus-photography"), order("retina", "fundus-photography")];
  const mediaRows = [media("photo", "fundus-photo", "ServiceRequest/retina")];
  assert.deepEqual(interpretationBlocks(input({ actions, mediaRows })).map(x => x.reason), ["needs-interpretation"]);
  assert.deepEqual(interpretationBlocks(input({ actions, mediaRows, reports: [report("r", "preliminary", "photo")] })).map(x => x.reason), ["needs-interpretation"]);
  assert.deepEqual(interpretationBlocks(input({ actions, mediaRows, reports: [report("r", "final", "photo")] })), []);
  assert.deepEqual(interpretationBlocks(input({ actions, mediaRows, reports: [report("r", "entered-in-error", "photo")] })).map(x => x.reason), ["needs-interpretation"]);
  assert.deepEqual(interpretationBlocks(input({ actions, mediaRows, reports: [report("r", "final", "photo", "  ")] })).map(x => x.reason), ["needs-interpretation"]);
});

test("G4 unordered imaging requires an interpreted result of the same type on this encounter", () => {
  const mediaRows = [media("field", "visual-field")], reports = [report("r", "final", "field")];
  assert.deepEqual(interpretationBlocks(input({ mediaRows, reports })).map(x => x.reason), ["no-interpreted-result"]);
  assert.deepEqual(interpretationBlocks(input({ mediaRows: [media("photo", "fundus-photo")], reports: [report("r", "final", "photo")] })), []);
});

test("G15 an interpreted order of another concept cannot release an uninterpreted fundus order", () => {
  const actions = [order("fundus", "fundus-photography"), order("field", "visual-field-threshold")];
  const mediaRows = [media("field-photo", "visual-field", "ServiceRequest/field")];
  const reports = [report("field-report", "final", "field-photo")];
  assert.deepEqual(interpretationBlocks(input({ actions, mediaRows, reports })).map(x => x.reason), ["needs-interpretation"]);
});

test("G16a an unordered fundus charge rejects a preliminary report with a conclusion", () => {
  const mediaRows = [media("photo", "fundus-photo")];
  const reports = [report("draft", "preliminary", "photo")];
  assert.deepEqual(interpretationBlocks(input({ mediaRows, reports })).map(x => x.reason), ["no-interpreted-result"]);
});

test("G16b an unordered fundus charge rejects a final report with a blank conclusion", () => {
  const mediaRows = [media("photo", "fundus-photo")];
  const reports = [report("blank", "final", "photo", "  ")];
  assert.deepEqual(interpretationBlocks(input({ mediaRows, reports })).map(x => x.reason), ["no-interpreted-result"]);
});

test("G17 a removed fundus order cannot release a live uninterpreted fundus order", () => {
  const actions = [order("removed", "fundus-photography", "removed"), order("live", "fundus-photography")];
  const mediaRows = [media("old-photo", "fundus-photo", "ServiceRequest/removed")];
  const reports = [report("old-report", "final", "old-photo")];
  assert.deepEqual(interpretationBlocks(input({ actions, mediaRows, reports })).map(x => x.reason), ["needs-interpretation"]);
});

test("G5/G6 snapshot or live imaging gates; unanswered non-imaging refuses", () => {
  for (const [snapshot, live] of [["oct", "not-required"], [undefined, "fundus-photo"], ["not-required", "oct"]] as const) {
    const key = "custom";
    assert.deepEqual(interpretationBlocks(input({ proposals: [proposal(key, snapshot)], fees: [fee(key, live)] })).map(x => x.reason), ["no-interpreted-result"]);
  }
  assert.deepEqual(interpretationBlocks(input({ proposals: [proposal("custom")], fees: [] })).map(x => x.reason), ["unclassified-fee"]);
  assert.deepEqual(interpretationBlocks(input({ proposals: [proposal("custom", "unanswered")], fees: [fee("custom", "not-required")] })).map(x => x.reason), ["unclassified-fee"]);
});

test("G7/G8/G13 duplicate persisted fees refuse; non-imaging and virtual seeds use their answers", () => {
  assert.deepEqual(interpretationBlocks(input({ fees: [fee("fundus-photography", "fundus-photo"), fee("fundus-photography", "fundus-photo")] })).map(x => x.reason), ["duplicate-fee"]);
  assert.deepEqual(interpretationBlocks(input({ proposals: [proposal("gonioscopy")], fees: [fee("gonioscopy", "not-required")] })), []);
  assert.deepEqual(interpretationBlocks(input({ proposals: [proposal("fundus-photography")], fees: [fee("fundus-photography", "fundus-photo")] })).map(x => x.reason), ["no-interpreted-result"]);
  assert.deepEqual(interpretationBlocks(input({ proposals: [proposal("not-seeded")], fees: [] })).map(x => x.reason), ["unclassified-fee"]);
});

test("G13 loader uses virtual seed answers and leaves unknown concepts unanswered", async () => {
  const fhir = {
    baseUrl: "http://localhost:18103/",
    search: async () => ({ resourceType: "Bundle" as const, type: "searchset" as const, entry: [] }),
  } as never;
  const blocks = await loadInterpretationBlocks({
    encounterId: "e1", proposals: [proposal("gonioscopy"), proposal("fundus-photography"), proposal("unknown-concept")],
    actions: { list: async () => [] }, fhir, feeScheduleFhir: fhir,
  });
  assert.deepEqual(blocks.map(row => [row.procedureConceptKey, row.reason]), [
    ["fundus-photography", "no-interpreted-result"],
    ["unknown-concept", "unclassified-fee"],
  ]);
});

test("G9 materializer checks the exact second list before any fee definition or ChargeItem write", async () => {
  let lists = 0, writes = 0;
  const accepted = proposal("fundus-photography");
  const charges = { list: async () => (++lists === 1 ? [proposal("gonioscopy")] : [proposal("gonioscopy"), accepted]), save: async (x: ChargeProposal) => x };
  assert.deepEqual((await charges.list()).map(row => row.procedureConceptKey), ["gonioscopy"]);
  await assert.rejects(() => materializeAcceptedChargeProposals({
    fhir: {
      read: async () => ({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p1" } }),
      create: async () => { writes++; throw new Error("unexpected ChargeItem write"); },
    } as never,
    feeScheduleFhir: { search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }), create: async () => { writes++; throw new Error("unexpected fee write"); } } as never,
    encounterId: "e1", actorReference: "Practitioner/synthetic",
    charges,
    applications: { list: async () => [], save: async x => x },
    beforeWrite: async rows => {
      const blocks = interpretationBlocks(input({ proposals: rows, fees: [fee("gonioscopy", "not-required"), fee("fundus-photography", "fundus-photo")] }));
      if (blocks.length) throw new InterpretationRequiredError(blocks);
    },
  }), (error: unknown) => error instanceof InterpretationRequiredError && error.tests[0]?.proposalId === accepted.id);
  assert.equal(lists, 2);
  assert.equal(writes, 0);
});

test("G14 sign handler re-checks the materializer's charge list before ChargeItem or recall writes", async () => {
  const resources: Resource[] = [{
    resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
  } satisfies Encounter];
  let chargeLists = 0;
  const fhir = {
    baseUrl: "http://localhost:18103/",
    read: async <T extends Resource>(type: T["resourceType"], id: string): Promise<T> => {
      const row = resources.find(x => x.resourceType === type && x.id === id);
      if (!row) throw new Error(`${type}/${id} missing`);
      return structuredClone(row) as T;
    },
    search: async <T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      let matches = resources.filter(row => row.resourceType === type &&
        (!params.code || (row as Basic).code?.coding?.some(code => `${code.system}|${code.code}` === params.code)) &&
        (!params.identifier || (row as Basic).identifier?.some(id => `${id.system}|${id.value}` === params.identifier)) &&
        (!params.encounter || (row as Media | DiagnosticReport).encounter?.reference === params.encounter) &&
        (!params.status || (row as Media).status === params.status));
      if (type === "Basic" && params.code?.endsWith("|odos-charge-proposal") && !params.identifier && ++chargeLists === 1) {
        matches = matches.filter(row => !(row as Basic).identifier?.some(id => id.value === "p-fundus-photography"));
      }
      return { resourceType: "Bundle", type: "searchset", entry: matches.map(resource => ({ resource: structuredClone(resource) as T })) };
    },
    create: async <T extends Resource>(row: T): Promise<T> => {
      const saved = { ...structuredClone(row), id: row.id ?? `r-${resources.length + 1}`, meta: { versionId: "1" } } as T;
      resources.push(saved);
      return saved;
    },
    update: async <T extends Resource>(type: T["resourceType"], id: string, row: T): Promise<T> => {
      const index = resources.findIndex(x => x.resourceType === type && x.id === id);
      if (index < 0) throw new Error(`${type}/${id} missing`);
      const saved = { ...structuredClone(row), id, meta: { versionId: "2" } } as T;
      resources[index] = saved;
      return saved;
    },
  };
  const service = new ProtocolService(fhir as never, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  await service.charges.save(proposal("gonioscopy"));
  await service.charges.save(proposal("fundus-photography"));
  const reply = await handleProtocolSignCleanupRequest({
    authenticate: async () => ({ staffReference: "Practitioner/synthetic", actorRole: "provider" as const, fhir: fhir as never }),
    feeScheduleFhir: fhir as never, now: () => at,
  }, { authHeader: "Bearer synthetic", params: { encounterId: "e1" } });
  assert.equal(reply.status, 409);
  assert.equal((reply.body as { code?: string }).code, "interpretation-required");
  assert.deepEqual((reply.body as { tests: { proposalId: string; reason: string }[] }).tests.map(x => [x.proposalId, x.reason]), [
    ["p-fundus-photography", "no-interpreted-result"],
  ]);
  assert.equal(chargeLists, 2);
  assert.equal(resources.some(row => row.resourceType === "ChargeItem"), false);
  assert.equal(resources.some(row => row.resourceType === "ServiceRequest"), false);
});

test("G10 sign cleanup takes one lock and waits for a staged-charge accept flip", async () => {
  const resources: Basic[] = [];
  const fhir = {
    search: async (_type: "Basic", params: Record<string, string> = {}): Promise<Bundle<Basic>> => ({
      resourceType: "Bundle", type: "searchset", entry: resources.filter(row =>
        (!params.code || row.code?.coding?.some(code => `${code.system}|${code.code}` === params.code)) &&
        (!params.identifier || row.identifier?.some(id => `${id.system}|${id.value}` === params.identifier)))
        .map(resource => ({ resource: structuredClone(resource) })),
    }),
    create: async (row: Basic) => { const saved = { ...structuredClone(row), id: `basic-${resources.length + 1}`, meta: { versionId: "1" } }; resources.push(saved); return saved; },
    update: async (_type: "Basic", id: string, row: Basic) => { const index = resources.findIndex(item => item.id === id); const saved = { ...structuredClone(row), id, meta: { versionId: "2" } }; resources[index] = saved; return saved; },
  };
  const service = new ProtocolService(fhir, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  const application: ProtocolApplication = {
    id: "app", encounterId: "e1", patientId: "p1", protocolId: "synthetic", protocolVersion: 1,
    appliedBy: "Practitioner/synthetic", appliedAt: at, stackedWith: [], dispositions: [], dedupResolutions: [],
    undoState: "active", confirmed: true,
  };
  await service.applications.save(application);
  await service.charges.save({ ...proposal("gonioscopy"), protocolApplicationId: application.id, state: "staged" });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let snapshotStarted!: () => void;
  const started = new Promise<void>(resolve => { snapshotStarted = resolve; });
  const events: string[] = [];
  const flip = service.acceptStagedCharges(application.id, async () => {
    events.push("snapshot-start"); snapshotStarted(); await held;
    events.push("snapshot-end");
    return { answer: "not-required" as const, feeVersion: "1", at };
  });
  await started;
  const signed = service.signCleanup("e1", {
    gate: async () => { events.push("gate"); assert.equal((await service.charges.list())[0]?.state, "accepted"); },
    materialize: async () => { events.push("materialize"); return 1; },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(events, ["snapshot-start"]);
  release();
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sign cleanup deadlocked")), 2_000));
  assert.deepEqual(await Promise.race([signed, deadline]), { abandoned: 0, charges: 1 });
  await flip;
  assert.deepEqual(events, ["snapshot-start", "snapshot-end", "gate", "materialize"]);
});

test("G1 ordered imaging without a report returns 409 before abandon, fee creation, charge, or recall", async () => {
  const resources: Resource[] = [{
    resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
  } satisfies Encounter, media("photo", "fundus-photo", "ServiceRequest/order")];
  let writes = 0;
  const fhir = {
    baseUrl: "http://localhost:18103/",
    read: async <T extends Resource>(type: T["resourceType"], id: string): Promise<T> => {
      const row = resources.find(x => x.resourceType === type && x.id === id);
      if (!row) throw new Error(`${type}/${id} missing`);
      return structuredClone(row) as T;
    },
    search: async <T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => ({
      resourceType: "Bundle", type: "searchset", entry: resources.filter(row => row.resourceType === type &&
        (!params.code || (row as Basic).code?.coding?.some(code => `${code.system}|${code.code}` === params.code)) &&
        (!params.identifier || (row as Basic).identifier?.some(id => `${id.system}|${id.value}` === params.identifier)) &&
        (!params.encounter || (row as Media | DiagnosticReport).encounter?.reference === params.encounter) &&
        (!params.status || (row as Media).status === params.status))
        .map(resource => ({ resource: structuredClone(resource) as T })),
    }),
    create: async <T extends Resource>(row: T): Promise<T> => { writes++; const saved = { ...structuredClone(row), id: row.id ?? `r-${resources.length + 1}`, meta: { versionId: "1" } } as T; resources.push(saved); return saved; },
    update: async <T extends Resource>(type: T["resourceType"], id: string, row: T): Promise<T> => { writes++; const index = resources.findIndex(x => x.resourceType === type && x.id === id); const saved = { ...structuredClone(row), id, meta: { versionId: "2" } } as T; resources[index] = saved; return saved; },
  };
  const service = new ProtocolService(fhir as never, { commitFinding: async () => undefined, materializeAction: async () => undefined });
  await service.applications.save({
    id: "open", encounterId: "e1", patientId: "p1", protocolId: "synthetic", protocolVersion: 1,
    appliedBy: "Practitioner/synthetic", appliedAt: at, stackedWith: [], dispositions: [], dedupResolutions: [],
    undoState: "active", confirmed: false,
  });
  await service.actions.save(order("order", "fundus-photography"));
  await service.charges.save(proposal("fundus-photography"));
  const before = writes;
  const reply = await handleProtocolSignCleanupRequest({
    authenticate: async () => ({ staffReference: "Practitioner/synthetic", actorRole: "provider" as const, fhir: fhir as never }),
    feeScheduleFhir: fhir as never, now: () => at,
  }, { authHeader: "Bearer synthetic", params: { encounterId: "e1" } });
  assert.equal(reply.status, 409);
  assert.equal((reply.body as { code?: string }).code, "interpretation-required");
  assert.match((reply.body as { error: string }).error, /needs an interpretation and report/);
  assert.equal(writes, before);
  assert.equal((await service.applications.get("open"))?.undoState, "active");
  assert.equal((await service.charges.get("p-fundus-photography"))?.state, "accepted");
  assert.equal(resources.some(row => row.resourceType === "ChargeItem"), false);
});
