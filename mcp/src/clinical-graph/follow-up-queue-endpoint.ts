import { z } from "zod";
import type { Condition, DiagnosticReport, Encounter, Media, ServiceRequest } from "@medplum/fhirtypes";
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
  result?: { status: "none" | "needs-interpretation" | "interpreted"; items: FollowUpResultItem[]; candidates: FollowUpResultItem[] };
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

const resultCommandSchema = z.object({
  orderable: z.string().min(1),
  focus: z.string().min(1).optional(),
  mediaReference: z.string().regex(/^Media\/[A-Za-z0-9.-]+$/),
  action: z.enum(["link", "unlink"]),
}).strict();

function orderReferences(row: FollowUpQueueRow, actions: readonly PlanActionInstance[]): string[] {
  const ids = new Set(row.actionIds ?? []);
  return [...new Set(actions.filter(action => ids.has(action.id))
    .flatMap(action => action.materializedFhirRef?.match(/^ServiceRequest\/[A-Za-z0-9.-]+$/) ? [action.materializedFhirRef] : []))];
}

async function withImagingResults(
  staffFhir: ExamOverviewFhirClient,
  queue: FollowUpQueue,
  actions: readonly PlanActionInstance[],
  encounterId: string,
): Promise<FollowUpQueue> {
  if (!queue.recorded) return queue;
  const encounterReference = `Encounter/${encounterId}`;
  const mediaRows = (await searchImagingMedia(staffFhir as unknown as ImagingFhirClient, {
    encounter: encounterReference, status: "completed", _sort: "-created", _count: "50",
  })).filter(media => media.encounter?.reference === encounterReference && isImagingReadSurfaceMedia(media));
  const reportBundle = await staffFhir.search<DiagnosticReport>("DiagnosticReport", { encounter: encounterReference, _count: "50" });
  const reports = (reportBundle.entry ?? []).flatMap(entry => entry.resource && entry.resource.encounter?.reference === encounterReference ? [entry.resource] : []);
  const summary = (media: Media): FollowUpResultItem => ({
    mediaReference: `Media/${media.id}`,
    title: media.content.title ?? "Imaging result",
    date: media.createdDateTime ?? media.issued ?? media.meta?.lastUpdated ?? "",
  });
  const rows = queue.rows.map(row => {
    const kind = resultKind(row.orderable, row.focus);
    if (kind.kind !== "image") return row;
    const candidates = mediaRows.filter(media => !media.basedOn?.length && imagingCategory(media) === kind.category);
    if (row.state === "for-review") return candidates.length ? { ...row, unreviewedResult: true as const } : row;
    if (row.state !== "already-ordered") return row;
    const references = new Set(orderReferences(row, actions));
    const items = mediaRows.filter(media => media.basedOn?.some(link => link.reference && references.has(link.reference)));
    const itemReferences = new Set(items.map(media => `Media/${media.id}`));
    const interpreted = reports.some(report => report.status !== "entered-in-error" && report.status !== "cancelled" &&
      Boolean(report.conclusion?.trim()) &&
      (report.basedOn?.some(link => link.reference && references.has(link.reference)) ||
        report.media?.some(link => link.link.reference && itemReferences.has(link.link.reference))));
    return { ...row, result: {
      status: interpreted ? "interpreted" as const : items.length ? "needs-interpretation" as const : "none" as const,
      items: items.map(summary), candidates: candidates.map(summary),
    } };
  });
  return { ...queue, rows };
}

export async function handleFollowUpResultRequest(deps: Deps, input: { authHeader: string | undefined; params: unknown; body: unknown }): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
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
  const { orderable, focus, mediaReference, action } = command.data;
  const row = loaded.queue.recorded ? loaded.queue.rows.find(item => item.orderable === orderable && (item.focus ?? "") === (focus ?? "")) : undefined;
  const kind = resultKind(orderable, focus);
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
    ? !media.basedOn?.length
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
  } catch { return loadFailure(); }
}
