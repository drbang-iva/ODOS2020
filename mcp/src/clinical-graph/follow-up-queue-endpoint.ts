import { z } from "zod";
import { collectBoundedSearch } from "../fhir-search.js";
import { randomUUID } from "node:crypto";
import type { Bundle, Condition, DiagnosticReport, Encounter, Media, Provenance, ServiceRequest } from "@medplum/fhirtypes";
import { staffHasBusinessAction } from "../authz/roles.js";
import { conditionClinicalFamily, normalizeClinicalFamily, practitionerNamesByReference, type ExamOverviewEndpointDeps, type ExamOverviewFhirClient } from "./exam-overview-endpoint.js";
import { FhirEncounterExamScopeStore, type ProposedExamTest } from "./exam-scope-store.js";
import { isVisitProcedureConceptKey, listProcedureFeeScheduleSnapshot, type ProcedureFeeScheduleItem } from "./procedure-fee-schedule.js";
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES } from "./protocol-store.js";
import type { PlanActionInstance } from "./protocol-types.js";
import { FhirFollowUpDecisionStore, followUpDecisionKey, type FollowUpDecisions } from "./follow-up-decision-store.js";
import { PENDING_ORDERABLES } from "./plan-sets/glaucoma.js";
import { encounterDiagnoses, isManualProcedureProposal } from "./manual-procedure-charge-endpoint.js";
import type { ChargeProposal } from "./protocol-types.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import { FhirFollowUpProfileStore } from "./follow-up-profile-store.js";
import { imagingCategory, isImagingReadSurfaceMedia, searchImagingMedia, type ImagingFhirClient } from "./imaging-endpoint.js";
import { resultKind } from "./follow-up-result-kinds.js";
import { odosConcept, reference } from "../fhir/ophthalmology/extensions.js";

export interface FollowUpQueueRow {
  orderable: string;
  focus?: string;
  label: string;
  sources: string[];
  state: "for-review" | "already-ordered" | "unavailable" | "not-today";
  decidedBy?: string;
  decidedAt?: string;
  actionIds?: string[];
  reason?: string;
  charge?: FollowUpRowCharge;
  result?: { orderReference?: string; category: string; status: "none" | "needs-interpretation" | "interpreted"; items: FollowUpResultItem[]; candidates: FollowUpResultItem[]; draftConclusion?: string };
  unreviewedResult?: true;
}
type FollowUpResultItem = { mediaReference: string; title: string; date: string };
export type FollowUpRowCharge =
  | { status: "billed"; proposalId: string; dxPointer?: string; dxDisplay?: string }
  | { status: "removed"; proposalId: string; removedBy: string }
  | { status: "none" | "uncoded" | "protocol-pending" | "charged-elsewhere" | "finalized" };
export type FollowUpQueue = { recorded: false } | { recorded: true; rows: FollowUpQueueRow[]; canDecide?: boolean; canAccept?: boolean; diagnoses?: Array<{ reference: string; display: string; rank?: number; matches: boolean }> };

export function deriveFollowUpQueue(
  testsProposed: readonly ProposedExamTest[] | undefined,
  fees: readonly ProcedureFeeScheduleItem[],
  actions: readonly PlanActionInstance[],
  encounterId: string,
  patientId: string,
  decisions: FollowUpDecisions = {},
): FollowUpQueue {
  if (testsProposed === undefined) return { recorded: false };
  const active = new Map(fees.filter(fee => fee.active).map(fee => [fee.procedureConceptKey, fee]));
  return { recorded: true, rows: testsProposed.map(test => {
    const fee = active.get(test.orderable);
    const row = {
      orderable: test.orderable, ...(test.focus ? { focus: test.focus } : {}),
      label: test.label ?? (fee ? `${fee.display}${test.focus ? ` — ${test.focus}` : ""}` : test.orderable),
      sources: test.sources.map(source => source.kind === "profile"
        ? `from the ${source.profileLabel ?? source.profileKey} shape`
        : `from the ${source.planSetKey} plan set`),
    };
    const actionIds = actions.filter(action => action.encounterId === encounterId && action.patientId === patientId &&
      action.actionType === "order" && !["removed", "cancelled"].includes(action.state) &&
      action.payload.orderableKey === test.orderable && (action.payload.focus ?? "") === (test.focus ?? "")
    ).map(action => action.id);
    if (actionIds.length) return { ...row, state: "already-ordered", actionIds };
    const decision = decisions[followUpDecisionKey(test)];
    if (decision) return { ...row, state: "not-today", decidedBy: decision.by.display ?? decision.by.reference, decidedAt: decision.at };
    if (!fee) return { ...row, state: "unavailable", reason: test.unavailableReason ?? (PENDING_ORDERABLES.has(test.orderable)
      ? "This test can't be ordered in ODOS yet." : "Not in the practice catalogue.") };
    return { ...row, state: "for-review" };
  }) };
}

const paramsSchema = z.object({ encounterId: z.string().regex(/^[A-Za-z0-9.-]+$/) }).strict();
const commandSchema = z.object({ orderable: z.string().min(1), focus: z.string().optional(), decision: z.enum(["not-today", "put-back"]) }).strict();
const loadFailure = () => ({ status: 502, body: { error: "The tests for this visit could not be loaded." } });
type Deps = Pick<ExamOverviewEndpointDeps, "authenticate" | "serviceFhir">;

export async function encounterForCaller(fhir: ExamOverviewFhirClient, encounterId: string): Promise<Encounter | { status: number; body: { error: string } }> {
  try {
    return await fhir.read<Encounter>("Encounter", encounterId);
  } catch (error) {
    const status = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
    if (status === 401 || status === 403) return { status: 403, body: { error: "Encounter is outside the caller's patient compartment." } };
    if (status === 404 || status === 410) return { status: 404, body: { error: "Encounter was not found." } };
    return loadFailure();
  }
}

export async function readQueue(serviceFhir: ExamOverviewFhirClient, staffFhir: ExamOverviewFhirClient, encounter: Encounter, encounterId: string, patientId: string, canDecide: boolean) {
  const [scope, fees, actions, decisions] = await Promise.all([
    new FhirEncounterExamScopeStore(serviceFhir).get(encounterId),
    listProcedureFeeScheduleSnapshot(serviceFhir),
    new ProtocolBasicStore<PlanActionInstance>(staffFhir, PROTOCOL_BASIC_CODES.planActionInstance).list(),
    new FhirFollowUpDecisionStore(serviceFhir).get(encounterId),
  ]);
  const proposals = scope.testsProposed === undefined ? [] :
    (await new ProtocolBasicStore<ChargeProposal>(staffFhir, PROTOCOL_BASIC_CODES.chargeProposal).list())
      .filter(proposal => proposal.encounterId === encounterId);
  const diagnoses = scope.testsProposed === undefined ? [] : await encounterDiagnoses(staffFhir, encounter);
  const profileKeys = new Set(scope.testsProposed?.flatMap(test => test.sources.flatMap(source => source.kind === "profile" ? [source.profileKey] : [])) ?? []);
  const [catalog, profiles] = diagnoses.length ? await Promise.all([
    new FhirDiagnosisCatalogStore(serviceFhir).list(), new FhirFollowUpProfileStore(serviceFhir).list(),
  ]) : [[], []];
  const matchedFamilies = new Set(profiles.filter(profile => profile.active && profileKeys.has(profile.profileKey))
    .flatMap(profile => profile.matchesDiagnosisFamilies.map(normalizeClinicalFamily)));
  const conditionFamilyByReference = new Map<string, string | undefined>();
  const diagnosed = await Promise.all(diagnoses.map(async diagnosis => {
    const condition = await staffFhir.read<Condition>("Condition", diagnosis.reference.slice(10));
    const family = conditionClinicalFamily(condition, encounterId, catalog);
    conditionFamilyByReference.set(diagnosis.reference, family);
    return { ...diagnosis, matches: family !== undefined && matchedFamilies.has(family) };
  }));
  const actorNames = await practitionerNamesByReference(staffFhir, proposals.filter(proposal => proposal.state === "removed")
    .map(proposal => ({ reference: proposal.lastAmendment?.actor ?? proposal.provenance.actor })));
  const derive = (currentDecisions = decisions): FollowUpQueue => {
    const queue = deriveFollowUpQueue(scope.testsProposed, fees, actions, encounterId, patientId, currentDecisions);
    if (!queue.recorded) return queue;
    const rows = queue.rows.map(row => row.state === "already-ordered"
      ? { ...row, charge: rowCharge(row, actions, proposals, fees, encounterId, diagnosed, actorNames) }
      : row);
    return { ...queue, rows, canDecide, canAccept: canDecide && encounter.status !== "finished", diagnoses: diagnosed };
  };
  return { queue: derive(), derive, scope, fees, actions, profiles, conditionFamilyByReference };
}

function rowCharge(
  row: FollowUpQueueRow,
  actions: readonly PlanActionInstance[],
  proposals: readonly ChargeProposal[],
  fees: readonly ProcedureFeeScheduleItem[],
  encounterId: string,
  diagnoses: readonly { reference: string; display: string }[],
  actorNames: ReadonlyMap<string, string>,
): FollowUpRowCharge {
  const matching = proposals.filter(proposal => proposal.encounterId === encounterId && proposal.procedureConceptKey === row.orderable);
  const live = matching.find(proposal => proposal.state !== "removed");
  if (live?.state === "finalized") return { status: "finalized" };
  if (live?.state === "staged") return { status: "protocol-pending" };
  if (live?.state === "accepted" && isManualProcedureProposal(live, encounterId)) {
    const dxPointer = live.dxPointers[0];
    const dxDisplay = diagnoses.find(diagnosis => diagnosis.reference === dxPointer)?.display;
    return { status: "billed", proposalId: live.id, ...(dxPointer ? { dxPointer } : {}), ...(dxDisplay ? { dxDisplay } : {}) };
  }
  if (live) return { status: "charged-elsewhere" };
  const linked = new Set(actions.filter(action => row.actionIds?.includes(action.id)).map(action => action.chargeProposalRef));
  const removed = matching.find(proposal => proposal.state === "removed" && linked.has(proposal.id) && isManualProcedureProposal(proposal, encounterId));
  if (removed) {
    const actor = removed.lastAmendment?.actor ?? removed.provenance.actor;
    return { status: "removed", proposalId: removed.id, removedBy: actorNames.get(actor) ?? actor };
  }
  const coded = !isVisitProcedureConceptKey(row.orderable) && fees.some(fee => fee.procedureConceptKey === row.orderable && fee.active && fee.billingCode?.trim());
  return { status: coded ? "none" : "uncoded" };
}

export async function handleFollowUpQueueRequest(deps: Deps, input: { authHeader: string | undefined; params: unknown }): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const params = paramsSchema.safeParse(input.params);
  if (!params.success) return { status: 400, body: { error: "A valid encounter id is required." } };
  const { encounterId } = params.data;
  const encounter = await encounterForCaller(staff.fhir, encounterId);
  if ("body" in encounter) return encounter;
  if (!encounter.subject?.reference?.match(/^Patient\/[^/]+$/)) return { status: 400, body: { error: "Encounter patient required." } };
  try {
    const { queue, actions } = await readQueue(deps.serviceFhir ?? staff.fhir, staff.fhir, encounter, encounterId, encounter.subject.reference.slice(8), staffHasBusinessAction(staff, "chart.write"));
    return { status: 200, body: await withImagingResults(staff.fhir, queue, actions, encounterId) };
  } catch { return loadFailure(); }
}

export async function handleFollowUpDecisionRequest(deps: Deps, input: { authHeader: string | undefined; params: unknown; body: unknown }): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const params = paramsSchema.safeParse(input.params), command = commandSchema.safeParse(input.body);
  if (!params.success || !command.success) return { status: 400, body: { error: "A valid encounter and follow-up decision are required." } };
  const { encounterId } = params.data;
  const encounter = await encounterForCaller(staff.fhir, encounterId);
  if ("body" in encounter) return encounter;
  if (encounter.status === "finished") return { status: 409, body: { error: "Signed encounter cannot be edited." } };
  if (!encounter.subject?.reference?.match(/^Patient\/[^/]+$/)) return { status: 400, body: { error: "Encounter patient required." } };
  const serviceFhir = deps.serviceFhir ?? staff.fhir;
  let loaded;
  try {
    loaded = await readQueue(serviceFhir, staff.fhir, encounter, encounterId, encounter.subject.reference.slice(8), true);
  } catch { return loadFailure(); }
  const row = loaded.queue.recorded ? loaded.queue.rows.find(row => followUpDecisionKey(row) === followUpDecisionKey(command.data)) : undefined;
  if (command.data.decision === "not-today") {
    if (row?.state === "not-today") return { status: 200, body: loaded.queue };
    if (row?.state !== "for-review") return { status: 409, body: { error: "This test can no longer be marked Not today." } };
  } else if (row?.state !== "not-today") return { status: 200, body: loaded.queue };
  try {
    const names = await practitionerNamesByReference(staff.fhir, [{ reference: staff.staffReference }]);
    const display = names.get(staff.staffReference);
    const decisions = await new FhirFollowUpDecisionStore(serviceFhir).apply(encounterId, command.data, { reference: staff.staffReference, ...(display ? { display } : {}) });
    return { status: 200, body: loaded.derive(decisions) };
  } catch (error) {
    if ((error as { code?: string })?.code === "concurrent-edit") return { status: 409, body: { code: "concurrent-edit", error: "The follow-up decisions changed concurrently. Reload and retry." } };
    return loadFailure();
  }
}

const linkResultCommandSchema = z.object({
  orderable: z.string().min(1),
  focus: z.string().min(1).optional(),
  mediaReference: z.string().regex(/^Media\/[A-Za-z0-9.-]+$/),
  action: z.enum(["link", "unlink"]),
}).strict();
const interpretResultCommandSchema = z.object({
  action: z.literal("interpret"),
  orderable: z.string().min(1),
  focus: z.string().min(1).optional(),
  conclusion: z.string().trim().min(1).max(5000),
}).strict();
const resultCommandSchema = z.union([linkResultCommandSchema, interpretResultCommandSchema]);

function orderReferences(row: FollowUpQueueRow, actions: readonly PlanActionInstance[]): string[] {
  const ids = new Set(row.actionIds ?? []);
  return [...new Set(actions.filter(action => ids.has(action.id))
    .flatMap(action => action.materializedFhirRef?.match(/^ServiceRequest\/[A-Za-z0-9.-]+$/) ? [action.materializedFhirRef] : []))];
}

function liveOrderReferences(actions: readonly PlanActionInstance[], encounterId: string): Set<string> {
  return new Set(actions.filter(action => action.encounterId === encounterId && action.actionType === "order" &&
    !["removed", "cancelled"].includes(action.state))
    .flatMap(action => action.materializedFhirRef?.match(/^ServiceRequest\/[A-Za-z0-9.-]+$/) ? [action.materializedFhirRef] : []));
}

function conceptOrderReferences(row: FollowUpQueueRow, rows: readonly FollowUpQueueRow[], actions: readonly PlanActionInstance[], encounterId: string): string[] {
  const live = liveOrderReferences(actions, encounterId);
  return [...new Set(rows.filter(candidate => candidate.state === "already-ordered" && candidate.orderable === row.orderable)
    .flatMap(candidate => orderReferences(candidate, actions)).filter(reference => live.has(reference)))];
}

function reportAttached(report: DiagnosticReport, orders: ReadonlySet<string>, mediaReferences: ReadonlySet<string>): boolean {
  return Boolean(report.basedOn?.some(link => link.reference && orders.has(link.reference)) ||
    report.media?.some(link => link.link.reference && mediaReferences.has(link.link.reference)));
}

function assertInterpretationTransaction(request: Bundle, response: Bundle): void {
  if (response.type !== "transaction-response" || response.entry?.length !== request.entry?.length) {
    throw new Error("Interpretation transaction did not return a complete response.");
  }
  for (const entry of response.entry ?? []) {
    const status = Number.parseInt(entry.response?.status ?? "", 10);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw Object.assign(new Error("Interpretation transaction entry failed."), { status });
    }
  }
}

async function readImagingResources(staffFhir: ExamOverviewFhirClient, encounterId: string) {
  const encounterReference = `Encounter/${encounterId}`;
  const mediaRows = (await searchImagingMedia(staffFhir as unknown as ImagingFhirClient, {
    encounter: encounterReference, status: "completed", _sort: "-created", _count: "50",
  })).filter(media => media.encounter?.reference === encounterReference && isImagingReadSurfaceMedia(media));
  const reportBundle = await staffFhir.search<DiagnosticReport>("DiagnosticReport", { encounter: encounterReference, _count: "50" });
  const seenReportPages = new Set<string>();
  const reports = (await collectBoundedSearch<DiagnosticReport>({
    baseUrl: staffFhir.baseUrl,
    search: staffFhir.search.bind(staffFhir),
    searchUrl: staffFhir.searchUrl ? async (url, type) => {
      if (seenReportPages.has(url)) throw new Error("DiagnosticReport search returned a pagination cycle.");
      seenReportPages.add(url);
      return staffFhir.searchUrl!(url, type);
    } : undefined,
  }, "DiagnosticReport", reportBundle, { maxPages: 100, maxRows: 5_000 }))
    .filter(report => report.encounter?.reference === encounterReference);
  return { mediaRows, reports };
}

async function withImagingResults(
  staffFhir: ExamOverviewFhirClient,
  queue: FollowUpQueue,
  actions: readonly PlanActionInstance[],
  encounterId: string,
): Promise<FollowUpQueue> {
  if (!queue.recorded) return queue;
  const { mediaRows, reports } = await readImagingResources(staffFhir, encounterId);
  const summary = (media: Media): FollowUpResultItem => ({
    mediaReference: `Media/${media.id}`,
    title: media.content.title ?? "Imaging result",
    date: media.createdDateTime ?? media.issued ?? media.meta?.lastUpdated ?? "",
  });
  const liveReferences = liveOrderReferences(actions, encounterId);
  const rows = queue.rows.map(row => {
    const kind = resultKind(row.orderable, row.focus);
    if (kind.kind !== "image") return row;
    const candidates = mediaRows.filter(media => !media.basedOn?.some(link => link.reference && liveReferences.has(link.reference)) && imagingCategory(media) === kind.category);
    if (row.state === "for-review") return candidates.length ? { ...row, unreviewedResult: true as const } : row;
    if (row.state !== "already-ordered") return row;
    const references = new Set(orderReferences(row, actions));
    const items = mediaRows.filter(media => media.basedOn?.some(link => link.reference && references.has(link.reference)));
    const conceptOrders = new Set(conceptOrderReferences(row, queue.rows, actions, encounterId));
    const conceptMediaReferences = new Set(mediaRows.filter(media => media.basedOn?.some(link => link.reference && conceptOrders.has(link.reference)))
      .map(media => `Media/${media.id}`));
    const attached = (report: DiagnosticReport) => Boolean(report.conclusion?.trim()) && reportAttached(report, conceptOrders, conceptMediaReferences);
    const interpreted = reports.some(report => ["final", "amended", "corrected"].includes(report.status) && attached(report));
    const draft = interpreted ? undefined : reports.filter(report => report.status === "preliminary" && attached(report))
      .sort((a, b) => (b.issued ?? "").localeCompare(a.issued ?? "") || (b.meta?.lastUpdated ?? "").localeCompare(a.meta?.lastUpdated ?? ""))[0]?.conclusion?.trim();
    return { ...row, result: {
      orderReference: [...references][0], category: kind.category,
      status: interpreted ? "interpreted" as const : items.length ? "needs-interpretation" as const : "none" as const,
      items: items.map(summary), candidates: candidates.map(summary),
      ...(draft ? { draftConclusion: draft } : {}),
    } };
  });
  return { ...queue, rows };
}

export async function handleFollowUpResultRequest(deps: Deps, input: { authHeader: string | undefined; params: unknown; body: unknown }): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  if ((input.body as { action?: unknown } | null)?.action === "interpret" && !staffHasBusinessAction(staff, "clinical.sign")) {
    return { status: 403, body: { code: "interpretation-requires-signer", error: "Only a doctor can save an interpretation." } };
  }
  const params = paramsSchema.safeParse(input.params), command = resultCommandSchema.safeParse(input.body);
  if (!params.success || !command.success) return { status: 400, body: { error: "A valid encounter and result link are required." } };
  const { encounterId } = params.data;
  const encounter = await encounterForCaller(staff.fhir, encounterId);
  if ("body" in encounter) return encounter;
  if (encounter.status === "finished") return { status: 409, body: { error: "Signed encounter cannot be edited." } };
  if (!encounter.subject?.reference?.match(/^Patient\/[^/]+$/)) return { status: 400, body: { error: "Encounter patient required." } };
  const serviceFhir = deps.serviceFhir ?? staff.fhir;
  let loaded: Awaited<ReturnType<typeof readQueue>>;
  try { loaded = await readQueue(serviceFhir, staff.fhir, encounter, encounterId, encounter.subject.reference.slice(8), true); }
  catch { return loadFailure(); }
  const { orderable, focus, action } = command.data;
  const row = loaded.queue.recorded ? loaded.queue.rows.find(item => item.orderable === orderable && (item.focus ?? "") === (focus ?? "")) : undefined;
  const kind = resultKind(orderable, focus);
  if (action === "interpret") {
    if (row?.state !== "already-ordered" || kind.kind !== "image") {
      return { status: 409, body: { code: "interpretation-refused", error: "This test has no result to interpret." } };
    }
    const conceptRows = loaded.queue.recorded ? loaded.queue.rows.filter(candidate => candidate.state === "already-ordered" && candidate.orderable === orderable) : [];
    const liveActions = liveOrderReferences(loaded.actions, encounterId);
    const conceptOrders = new Map<string, FollowUpQueueRow>();
    for (const candidate of conceptRows) {
      for (const orderReference of orderReferences(candidate, loaded.actions)) {
        if (liveActions.has(orderReference)) conceptOrders.set(orderReference, candidate);
      }
    }
    let requests: ServiceRequest[];
    try { requests = await Promise.all([...conceptOrders.keys()].map(orderReference => staff.fhir.read<ServiceRequest>("ServiceRequest", orderReference.slice(15)))); }
    catch (error) {
      const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
      if (status === 401 || status === 403) return { status: 403, body: { error: "ServiceRequest is outside the caller's patient compartment." } };
      if (status === 404 || status === 410) return { status: 404, body: { error: "ServiceRequest was not found." } };
      return loadFailure();
    }
    const verified = new Set([...conceptOrders.keys()].filter((orderReference, index) => {
      const request = requests[index]!, ownRow = conceptOrders.get(orderReference)!;
      return request.status === "active" && request.subject?.reference === encounter.subject?.reference &&
        request.encounter?.reference === `Encounter/${encounterId}` && request.code?.text === ownRow.orderable &&
        (request.bodySite?.[0]?.text ?? "") === (ownRow.focus ?? "");
    }));
    if (!verified.size) return { status: 409, body: { code: "interpretation-refused", error: "Record the result before interpreting it." } };
    let resources: Awaited<ReturnType<typeof readImagingResources>>;
    try { resources = await readImagingResources(staff.fhir, encounterId); }
    catch { return loadFailure(); }
    const linkedMedia = resources.mediaRows.filter(media => media.subject?.reference === encounter.subject?.reference &&
      media.basedOn?.some(link => link.reference && verified.has(link.reference)));
    if (!linkedMedia.length) return { status: 409, body: { code: "interpretation-refused", error: "Record the result before interpreting it." } };
    const mediaReferences = new Set(linkedMedia.map(media => `Media/${media.id}`));
    if (resources.reports.some(report => ["final", "amended", "corrected"].includes(report.status) &&
      Boolean(report.conclusion?.trim()) && reportAttached(report, verified, mediaReferences))) {
      return { status: 409, body: { code: "already-interpreted", error: "This test is already interpreted." } };
    }
    const recordedAt = new Date().toISOString();
    const linkedOrders = [...verified].filter(orderReference => linkedMedia.some(media => media.basedOn?.some(link => link.reference === orderReference)));
    const report: DiagnosticReport = {
      resourceType: "DiagnosticReport", status: "preliminary",
      code: odosConcept("manual-imaging-interpretation", "Manual imaging interpretation"),
      subject: reference(encounter.subject.reference), encounter: reference(`Encounter/${encounterId}`),
      basedOn: linkedOrders.map(orderReference => ({ reference: orderReference })), effectiveDateTime: recordedAt, issued: recordedAt,
      resultsInterpreter: [reference(staff.staffReference)],
      media: linkedMedia.map(media => ({ link: reference(`Media/${media.id}`) })),
      conclusion: command.data.conclusion,
    };
    try {
      let createdReport: DiagnosticReport | undefined;
      for (const phase of ["create", "attest"] as const) {
        const provenance: Provenance | undefined = createdReport?.id ? {
          resourceType: "Provenance", target: [reference(`DiagnosticReport/${createdReport.id}`), reference(encounter.subject.reference)],
          recorded: recordedAt, agent: [{ who: reference(staff.staffReference) }],
        } : undefined;
        const request: Bundle = { resourceType: "Bundle", type: "transaction", entry: phase === "create"
          ? [{ fullUrl: `urn:uuid:${randomUUID()}`, resource: report, request: { method: "POST", url: "DiagnosticReport" } }]
          : [
            { resource: { ...createdReport!, status: "final" }, request: { method: "PUT", url: `DiagnosticReport/${createdReport!.id}`, ifMatch: `W/"${createdReport!.meta!.versionId}"` } },
            { resource: provenance!, request: { method: "POST", url: "Provenance" } },
          ] };
        const response = await (staff.fhir as ExamOverviewFhirClient & { executeTransaction(bundle: Bundle, headers?: Record<string, string>): Promise<Bundle> })
          .executeTransaction(request, { "X-ODOS-Source": "mcp/follow-up-interpretation" });
        assertInterpretationTransaction(request, response);
        if (phase === "create") {
          const createdId = response.entry?.[0]?.response?.location?.match(/^DiagnosticReport\/([A-Za-z0-9.-]+)(?:\/_history\/[A-Za-z0-9.-]+)?$/)?.[1];
          if (!createdId) throw new Error("Interpretation transaction did not identify the created report.");
          createdReport = await staff.fhir.read<DiagnosticReport>("DiagnosticReport", createdId);
          if (createdReport.status !== "preliminary" || !createdReport.meta?.versionId) {
            throw new Error("Interpretation report could not be attested.");
          }
        }
      }
    } catch (error) {
      const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
      if (status === 409 || status === 412) return { status: 409, body: { code: "concurrent-edit", error: "The imaging result changed concurrently. Reload and retry." } };
      return loadFailure();
    }
    try {
      const fresh = await readQueue(serviceFhir, staff.fhir, encounter, encounterId, encounter.subject.reference.slice(8), true);
      return { status: 200, body: await withImagingResults(staff.fhir, fresh.queue, fresh.actions, encounterId) };
    } catch { return { status: 200, body: { committed: true, reloadRequired: true } }; }
  }
  const { mediaReference } = command.data;
  if (row?.state !== "already-ordered" || kind.kind !== "image") {
    return { status: 409, body: { code: "result-link-refused", error: "This test has no result to link." } };
  }
  const references = orderReferences(row, loaded.actions);
  if (!references.length) return { status: 409, body: { code: "result-link-refused", error: "This test has no result to link." } };
  const readFailure = (resourceType: string, error: unknown) => {
    const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
    if (status === 401 || status === 403) return { status: 403, body: { error: `${resourceType} is outside the caller's patient compartment.` } };
    if (status === 404 || status === 410) return { status: 404, body: { error: `${resourceType} was not found.` } };
    return loadFailure();
  };
  let requests: ServiceRequest[];
  try { requests = await Promise.all(references.map(reference => staff.fhir.read<ServiceRequest>("ServiceRequest", reference.slice(15)))); }
  catch (error) { return readFailure("ServiceRequest", error); }
  const live = references.filter((reference, index) => {
    const request = requests[index]!;
    return request.status === "active" && request.subject?.reference === encounter.subject?.reference &&
      request.encounter?.reference === `Encounter/${encounterId}` && request.code?.text === row.orderable &&
      (request.bodySite?.[0]?.text ?? "") === (row.focus ?? "");
  });
  if (!live.length) return { status: 409, body: { code: "result-link-refused", error: "This test has no result to link." } };
  let media: Media;
  try { media = await staff.fhir.read<Media>("Media", mediaReference.slice(6)); }
  catch (error) { return readFailure("Media", error); }
  const sameTestMedia = media.status === "completed" && media.encounter?.reference === `Encounter/${encounterId}` &&
    media.subject?.reference === encounter.subject.reference && isImagingReadSurfaceMedia(media) && imagingCategory(media) === kind.category;
  const allowed = sameTestMedia && (action === "link"
    ? !media.basedOn?.some(link => link.reference && liveOrderReferences(loaded.actions, encounterId).has(link.reference))
    : media.basedOn?.length === 1 && live.includes(media.basedOn[0]?.reference ?? ""));
  if (!allowed) return { status: 409, body: { code: "result-link-refused", error: "This image cannot be linked to that test." } };
  if (!media.id || !media.meta?.versionId) return loadFailure();
  const updated: Media = { ...media };
  if (action === "link") updated.basedOn = [{ reference: live[0] }];
  else delete updated.basedOn;
  try {
    await staff.fhir.update<Media>("Media", media.id, updated, { "If-Match": `W/"${media.meta.versionId}"`, "X-ODOS-Source": "mcp/follow-up-result-link" });
  } catch (error) {
    const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
    if (status === 409 || status === 412) return { status: 409, body: { code: "concurrent-edit", error: "The imaging result changed concurrently. Reload and retry." } };
    return loadFailure();
  }
  try {
    const fresh = await readQueue(serviceFhir, staff.fhir, encounter, encounterId, encounter.subject.reference.slice(8), true);
    return { status: 200, body: await withImagingResults(staff.fhir, fresh.queue, fresh.actions, encounterId) };
  } catch { return { status: 200, body: { committed: true, reloadRequired: true } }; }
}
