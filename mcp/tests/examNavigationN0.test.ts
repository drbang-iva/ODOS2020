import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Encounter, Observation, Resource } from "@medplum/fhirtypes";
import { handleEncounterComplaintMutationRequest } from "../src/clinical-graph/complaint-endpoint.js";
import type { EncounterComplaint } from "../src/clinical-graph/complaint-model.js";
import { handleExamOverviewRequest } from "../src/clinical-graph/exam-overview-endpoint.js";
import { buildExamOverviewProjection, type ExamOverviewProjection } from "../src/clinical-graph/exam-overview-projection.js";
import { buildHpiFindingDefinition } from "../src/clinical-graph/hpi-definition.js";
import { handleHpiCaptureRequest } from "../src/clinical-graph/hpi-endpoint.js";
import { isHistoryAnswerObservation, parseHistoryAnswerObservation } from "../src/clinical-graph/history-answer-observation.js";
import type { HistoryTemplateAnswer } from "../src/clinical-graph/history-template-engine.js";

const recordedAt = "2026-09-25T12:00:00.000Z";
const patientReference = "Patient/n0-patient";
const encounterReference = "Encounter/n0-encounter";
const actorReference = "Practitioner/n0-provider";
const definition = buildHpiFindingDefinition({ source: "manual", recordedAt, actorReference });
const history: Observation = {
  resourceType: "Observation", id: "n0-history", status: "preliminary",
  code: { coding: [{ code: "hpi_ros" }] }, subject: { reference: patientReference },
  encounter: { reference: encounterReference }, valueString: "Synthetic History capture",
};
const projectInput = {
  encounterReference, patientReference, definitions: [definition], currentObservations: [history],
  priorObservationCandidates: [], assessmentRows: [],
};
function assertHistory(projection: ExamOverviewProjection, state: string, resolved: boolean) {
  assert.equal(projection.sections.find(row => row.sectionKey === "history")?.state, state);
  const trace = projection.completeness.trace.find(row => row.sectionKey === "history");
  assert.equal(trace?.state, state);
  assert.equal(trace?.resolved, resolved);
  assert.equal(projection.completeness.resolvedSectionCount, resolved ? 1 : 0);
}

test("N0 G1 summary plus an unanswered template complaint is partial and unresolved", () => {
  for (const examScope of ["comprehensive", "office-visit"]) {
    const base = buildExamOverviewProjection({ ...projectInput, examScope });
    const result = buildExamOverviewProjection({ ...projectInput, examScope,
      historyComplaintRows: [{ complaintId: "c1", charted: false, hasLiveAnswers: false }],
    });
    assertHistory(result, "partial", false);
    assert.deepEqual(result.findings, base.findings);
    assert.deepEqual(result.sections.filter(row => row.sectionKey !== "history"), base.sections.filter(row => row.sectionKey !== "history"));
    assert.deepEqual(Object.keys(result), Object.keys(base));
  }
});

test("N0 G2 presentation and every required section resolve History", async () => {
  const setup = await fixture();
  const complaintId = await setup.complaint();
  await setup.capture(completeAnswers(complaintId));
  assertHistory(await setup.overview(), "examined", true);
});

test("N0 G3 presentation with a missing required section remains partial", async () => {
  const setup = await fixture();
  const complaintId = await setup.complaint();
  await setup.capture(completeAnswers(complaintId).filter(answer => answer.sectionId !== "risk-factors"));
  assertHistory(await setup.overview(), "partial", false);
});

test("N0 G4 an entered-in-error presentation cannot complete History", async () => {
  const setup = await fixture();
  const complaintId = await setup.complaint();
  await setup.capture(completeAnswers(complaintId));
  const presentation = setup.fhir.resources.find(row => row.resourceType === "Observation" && isHistoryAnswerObservation(row) && parseHistoryAnswerObservation(row).id === `${complaintId}-presentation`) as Observation;
  assert.ok(presentation);
  presentation.status = "entered-in-error";
  assertHistory(await setup.overview(), "partial", false);
});

test("N0 G5 free-text, no complaint, and absent optional input keep the base result", async () => {
  const freeText = await fixture();
  await freeText.complaint(false);
  await freeText.capture();
  assertHistory(await freeText.overview(), "examined", true);
  const noComplaint = await fixture();
  noComplaint.fhir.resources.push(structuredClone(history));
  assertHistory(await noComplaint.overview(), "examined", true);
  assertHistory(buildExamOverviewProjection(projectInput), "examined", true);
  assert.deepEqual(buildExamOverviewProjection({ ...projectInput, historyComplaintRows: [] }), buildExamOverviewProjection(projectInput));
});

test("N0 G6 real complaint, capture, and overview handlers change unresolved to resolved", async () => {
  const setup = await fixture();
  const complaintId = await setup.complaint();
  await setup.capture();
  assertHistory(await setup.overview(), "partial", false);
  await setup.capture(completeAnswers(complaintId));
  assertHistory(await setup.overview(), "examined", true);
});

test("N0 projection distinguishes untouched, started, fully charted, and mixed complaints without summary evidence", () => {
  const input = { ...projectInput, currentObservations: [] };
  for (const [rows, state, resolved] of [
    [[{ complaintId: "c1", charted: false, hasLiveAnswers: false }], "not-examined", false],
    [[{ complaintId: "c1", charted: false, hasLiveAnswers: true }], "partial", false],
    [[{ complaintId: "c1", charted: true, hasLiveAnswers: true }], "examined", true],
    [[{ complaintId: "c1", charted: true, hasLiveAnswers: true }, { complaintId: "c2", charted: false, hasLiveAnswers: false }], "partial", false],
  ] as const) assertHistory(buildExamOverviewProjection({ ...input, historyComplaintRows: rows }), state, resolved);
});

test("N0 retired or unrelated answers cannot resolve History; foreign subjects are refused", async () => {
  for (const patch of [
    { status: "cancelled" }, { encounter: { reference: "Encounter/other" } },
    { subject: { reference: "Patient/other" } }, { code: { text: "Not a History answer" } },
  ] satisfies Partial<Observation>[]) {
    const setup = await fixture();
    const complaintId = await setup.complaint();
    await setup.capture(completeAnswers(complaintId));
    const presentation = setup.fhir.resources.find(row => row.resourceType === "Observation" && isHistoryAnswerObservation(row) && parseHistoryAnswerObservation(row).id === `${complaintId}-presentation`) as Observation;
    Object.assign(presentation, patch);
    if ("subject" in patch) {
      const result = await handleExamOverviewRequest(setup.deps, { authHeader: "synthetic", params: { encounterId: "n0-encounter" } });
      assert.equal(result.status, 502);
    } else assertHistory(await setup.overview(), "partial", false);
  }
});

test("N0 answers belong to their complaint and inactive complaints add no requirements", async () => {
  const setup = await fixture();
  const first = await setup.complaint();
  await setup.capture(completeAnswers(first));
  const second = await setup.complaint();
  assertHistory(await setup.overview(), "partial", false);
  const result = await handleEncounterComplaintMutationRequest(setup.deps, {
    authHeader: "synthetic", params: { encounterId: "n0-encounter" }, body: { action: "remove", complaintId: second },
  });
  assert.equal(result.status, 200);
  assertHistory(await setup.overview(), "examined", true);
});

function completeAnswers(complaintId: string): HistoryTemplateAnswer[] {
  const answer = (sectionId: string, value: HistoryTemplateAnswer["value"], optionCode?: string): HistoryTemplateAnswer => ({
    id: `${complaintId}-${sectionId}`, complaintId, templateKey: "glaucoma", sectionId, value,
    ...(optionCode ? { optionCode } : {}), ...(sectionId === "current-treatment" ? { eye: "OD" as const } : {}),
  });
  return [
    answer("presentation", { kind: "selection", code: "follow-up" }),
    answer("symptoms", { kind: "tri-state", status: "positive" }, "no-symptoms"),
    answer("risk-factors", { kind: "tri-state", status: "negative" }, "family-history-of-glaucoma"),
    answer("current-treatment", { kind: "tri-state", status: "positive" }, "no-treatment"),
    answer("presents-for", { kind: "tri-state", status: "positive" }, "iop-check"),
  ];
}

async function fixture() {
  const encounter: Encounter = { resourceType: "Encounter", id: "n0-encounter", status: "in-progress",
    class: { code: "AMB" }, subject: { reference: patientReference }, period: { start: recordedAt }, meta: { versionId: "1" } };
  const fhir = new SyntheticFhir([encounter]);
  let sequence = 0;
  const deps = { authenticate: async () => ({ staffReference: actorReference, actorRole: "provider" as const, fhir }),
    findingDefinitions: () => [definition], now: () => recordedAt, id: () => `n0-complaint-${++sequence}` };
  return {
    fhir, deps,
    async complaint(template = true) {
      const body = template ? { action: "create-template", patientReference, templateKey: "glaucoma" } : {
        action: "create", patientReference, complaint: { freeTextLabel: "Synthetic complaint", conditions: [],
          eyeLocation: "not-applicable", qualities: [], treatmentsTried: [], additionalHistory: "", narrative: { mode: "automated" } },
      };
      const result = await handleEncounterComplaintMutationRequest(deps, { authHeader: "synthetic", params: { encounterId: "n0-encounter" }, body });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return (result.body as { complaints: EncounterComplaint[] }).complaints.at(-1)!.id;
    },
    async capture(templateAnswers?: HistoryTemplateAnswer[]) {
      const result = await handleHpiCaptureRequest(deps, { authHeader: "synthetic", body: {
        patientReference, encounterReference, reviewOfSystems: [], reviewAttestations: [],
        ...(templateAnswers ? { templateAnswers } : {}),
      } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    },
    async overview() {
      const result = await handleExamOverviewRequest(deps, { authHeader: "synthetic", params: { encounterId: "n0-encounter" } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body as ExamOverviewProjection;
    },
  };
}

class SyntheticFhir {
  readonly baseUrl = "http://localhost/";
  constructor(readonly resources: Resource[]) {}
  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find(row => row.resourceType === type && row.id === id);
    if (!resource) throw Object.assign(new Error("Synthetic resource missing"), { status: 404 });
    return structuredClone(resource as T);
  }
  async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const rows = this.resources.filter(resource => {
      if (resource.resourceType !== type) return false;
      const row = resource as Observation | Basic;
      if (params.code && !row.code?.coding?.some(c => `${c.system}|${c.code}` === params.code)) return false;
      if (params.identifier && !row.identifier?.some(i => `${i.system}|${i.value}` === params.identifier)) return false;
      if (params.subject && row.subject?.reference !== params.subject) return false;
      if (params.patient && row.subject?.reference !== params.patient) return false;
      if (params.encounter && (row as Observation).encounter?.reference !== params.encounter) return false;
      return true;
    });
    return { resourceType: "Bundle", type: "searchset", entry: rows.map(row => ({ resource: structuredClone(row as T) })) };
  }
  async create<T extends Resource>(resource: T): Promise<T> {
    const row = { ...structuredClone(resource), id: resource.id ?? `n0-resource-${this.resources.length}`, meta: { versionId: "1" } };
    this.resources.push(row);
    return structuredClone(row);
  }
  async update<T extends Resource>(_type: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex(row => row.resourceType === resource.resourceType && row.id === id);
    const row = { ...structuredClone(resource), id, meta: { versionId: String(Number(this.resources[index]?.meta?.versionId ?? 0) + 1) } };
    if (index >= 0) this.resources[index] = row; else this.resources.push(row);
    return structuredClone(row);
  }
  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    const entry: NonNullable<Bundle["entry"]> = [];
    for (const request of bundle.entry ?? []) {
      if (!request.resource) continue;
      const resource = request.resource;
      const identifier = new URL(request.request!.url!, this.baseUrl).searchParams.get("identifier");
      const existing = this.resources.find(row => row.resourceType === resource.resourceType && (identifier
        ? (row as Observation).identifier?.some(i => `${i.system}|${i.value}` === identifier)
        : resource.id && row.id === resource.id));
      const saved = existing?.id ? await this.update(resource.resourceType, existing.id, resource) : await this.create(resource);
      entry.push({ response: { status: existing ? "200 OK" : "201 Created", location: `${saved.resourceType}/${saved.id}/_history/${saved.meta?.versionId}` } });
    }
    return { resourceType: "Bundle", type: "transaction-response", entry };
  }
}
