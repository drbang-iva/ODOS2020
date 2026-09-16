import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export type FindingLaterality = "OD" | "OS" | "OU" | "UNKNOWN";
export type FindingEye = "OD" | "OS";
export interface CurrentFindingKey { v: 1; patientId: string; encounterId: string; stableKey: string; fieldCode: string; optionCode: string; eye: FindingEye }
export type FindingQualifierValue = string | number | { from: number; to: number; clockwise: boolean };
export type FindingBaseline = { kind: "canonical"; reference: string; versionId: string } | { kind: "absent"; key: CurrentFindingKey };
export interface AtomicFindingCatalogRow {
  atomicFindingId: string; findingDefinitionId: string; findingDefinitionKey: string; fieldCode: string;
  optionCode: string; display: string; sectionKey: string; gradeScale: string[]; diagnosisKeys: string[]; origin: "shipped" | "custom";
}
export interface EncounterFindingRow extends AtomicFindingCatalogRow {
  rowKey: string; kind: "fact" | "conflict" | "unresolved" | "offered"; eye: FindingEye | "UNKNOWN";
  laterality: FindingLaterality; presence?: "present" | "absent"; qualifiers: Record<string, FindingQualifierValue>;
  grade?: string; status: "live" | "retired" | "offered"; editable: boolean; readOnlyReason?: string; homes: string[];
  homeSources: Array<{ condition: string; sources: Array<{ kind: "finding-extension" | "condition-evidence" | "inferred"; contributor: { reference: string; versionId?: string } }> }>;
  conditionReference?: string; key?: CurrentFindingKey; baseline?: FindingBaseline;
  contributors: Array<{ reference: string; versionId?: string; effectiveDateTime?: string; kind: string; carried?: boolean }>;
  carried?: boolean; auditPending?: boolean; priorPresence?: "present" | "absent"; priorGrade?: string; priorLaterality?: FindingLaterality;
}
export interface DiagnosisFindingsPayload {
  encounterEditable: boolean; readOnlyReason?: string; canWrite: boolean; canWriteDiagnosis: boolean;
  diagnosis?: { id: string; stableKey: string; display: string; applicableFindingDefinitionIds: string[] };
  carryProvenance?: { pulledFromDate?: string; unchangedSinceDate?: string; edited: boolean; integrityWarning?: string };
  findings: EncounterFindingRow[]; catalog: AtomicFindingCatalogRow[]; searchIndex: EncounterFindingRow[];
  unassigned: EncounterFindingRow[]; bySection: Record<string, EncounterFindingRow[]>; auditDebt: EncounterFindingRow[];
  visitDiagnoses: Array<{ conditionReference: string; diagnosisKey: string; display: string; laterality: FindingLaterality }>;
}
export type FindingCommandTarget =
  | { kind: "fact"; key: CurrentFindingKey; baseline: FindingBaseline; state: { status: "live" | "retired"; presence: "present" | "absent"; qualifiers: Record<string, FindingQualifierValue>; homes: string[] } }
  | { kind: "reassert"; key: CurrentFindingKey; baseline: Extract<FindingBaseline, {kind:"canonical"}> };
export interface DiagnosisFindingMutation {
  commandId: string; patientReference: string; operation: "assert" | "clear" | "grade" | "eye-change" | "move" | "standalone" | "link" | "reassert";
  context?: { selectedConditionReference: string }; targets: FindingCommandTarget[]; eyes?: { from: FindingEye[]; to: FindingEye[] };
}
export interface FindingsUnavailable { result: "unavailable"; kind: "upstream" | "refused" | "missing" | "foreign-or-unscoped"; error: string; status?: number }
export interface FindingOutcome {
  clinicalWrite: "confirmed" | "unknown" | "none";
  cause?: "load" | "refresh" | "owner-search" | "verify-read" | "audit-lookup" | "audit-repair" | "halted-by-earlier-target";
  status: "applied" | "unchanged" | "already-applied" | "not-attempted" | "conflict" | "refused" | "unconfirmed";
  target: string; reference?: string; versionId?: string; auditPending?: boolean; reason?: string;
}
export type DiagnosisFindingResult =
  | { result: "command"; commandId: string; complete: boolean; executionOrder: number[]; outcomes: FindingOutcome[] }
  | FindingsUnavailable
  | { result: "invalid"; error: string; reason: string; targetIndex?: number }
  | { result: "precondition"; error: string; targetIndex: number }
  | { result: "unauthenticated" | "forbidden"; error: string };
export interface FindingHttpResult { status: number; body: DiagnosisFindingResult }
export const canMutateDiagnosisFinding = (payload: DiagnosisFindingsPayload, _mutation?: DiagnosisFindingMutation): boolean => payload.canWrite === true && payload.encounterEditable === true;
export const findingReadOnlyLabel = (reason?: string): string => ({
  "pre-rebuild-test-encounter": "Test data from before the rebuild", "signed-or-cancelled": "Signed — read only",
  conflict: "Conflicting records", "home-outside-encounter": "Linked to a diagnosis outside this visit",
}[reason ?? ""] ?? "Read only");
export function orderedFindingRows(rows: readonly EncounterFindingRow[]): EncounterFindingRow[] {
  return [...rows].sort((a,b) => Number(a.kind === "offered") - Number(b.kind === "offered") || a.display.localeCompare(b.display) || a.eye.localeCompare(b.eye));
}
export function orderedFindingSearchRows<T extends AtomicFindingCatalogRow>(rows: readonly T[], diagnosisKey: string | undefined): T[] {
  return [...rows].sort((a,b) => Number(!diagnosisKey || !a.diagnosisKeys.includes(diagnosisKey)) - Number(!diagnosisKey || !b.diagnosisKeys.includes(diagnosisKey)));
}
function url(encounterReference: string): string {
  return `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterReference.replace(/^Encounter\//,""))}/findings`;
}
export async function loadDiagnosisFindings(encounterReference: string, conditionReference?: string, fetchImpl: typeof fetch = fetch): Promise<DiagnosisFindingsPayload | FindingsUnavailable> {
  try {
    const response = await fetchImpl(url(encounterReference) + (conditionReference ? `?condition=${encodeURIComponent(conditionReference)}` : ""), { headers: authHeaders() });
    const body = await response.json();
    if (response.ok) return body;
    return { ...body, result: "unavailable", kind: body.kind ?? (response.status === 403 || response.status === 401 ? "refused" : response.status === 404 ? "missing" : "upstream"), error: body.error ?? "Findings unavailable", status: response.status };
  } catch { return { result: "unavailable", kind: "upstream", error: "Findings unavailable" }; }
}
async function send(encounterReference: string, body: unknown, repair: boolean, fetchImpl: typeof fetch): Promise<FindingHttpResult> {
  try {
    const response = await fetchImpl(url(encounterReference) + (repair ? "/audit-repair" : ""), {
      method: repair ? "POST" : "PUT", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as DiagnosisFindingResult };
  } catch {
    return { status: 502, body: { result: "command", commandId: (body as {commandId:string}).commandId, complete: false, executionOrder: [0], outcomes: [{ status: "unconfirmed", clinicalWrite: "unknown", target: encounterReference, reason: "Response could not be confirmed." }] } };
  }
}
export const mutateDiagnosisFinding = (encounterReference: string, mutation: DiagnosisFindingMutation, fetchImpl: typeof fetch = fetch): Promise<FindingHttpResult> => send(encounterReference,mutation,false,fetchImpl);
export const repairFindingAudits = (encounterReference: string, request: { commandId: string; patientReference: string }, fetchImpl: typeof fetch = fetch): Promise<FindingHttpResult> => send(encounterReference,request,true,fetchImpl);
export async function handleFindingOutcome(response: FindingHttpResult, options: { encounterReference: string; refresh: () => void | Promise<void>; eventTarget?: EventTarget }): Promise<{message?:string;retryIdentical:boolean;reloadChoice:boolean;auditPending:boolean}> {
  const body = response.body;
  const command = body.result === "command" ? body : undefined;
  const confirmed = command?.outcomes.some(o => o.clinicalWrite === "confirmed") === true;
  const causal = command?.executionOrder.map(i => command.outcomes[i]).find(o => o && !["applied","unchanged","already-applied"].includes(o.status) && o.cause !== "halted-by-earlier-target");
  const retryIdentical = response.status === 502 && causal?.status === "unconfirmed";
  const reloadChoice = body.result === "invalid" || body.result === "precondition" || causal?.status === "conflict" || causal?.status === "refused";
  const auditPending = command?.outcomes.some(o => o.auditPending) === true;
  if (confirmed || command?.complete || reloadChoice || auditPending) await options.refresh();
  if (confirmed) {
    const event = new Event("odos:encounter-findings-changed");
    Object.defineProperty(event,"detail",{value:{encounterReference:options.encounterReference}});
    (options.eventTarget ?? (typeof window !== "undefined" ? window : undefined))?.dispatchEvent(event);
  }
  return { retryIdentical, reloadChoice, auditPending, message: retryIdentical ? "Not confirmed — Retry" : body.result === "unavailable" ? "Findings unavailable" : reloadChoice ? "Current values reloaded. Your choice is kept; apply it as a new command." : command?.complete ? undefined : auditPending ? "Finding saved; audit repair pending." : "error" in body ? body.error : causal?.reason ?? "Finding command did not complete." };
}

export function groupFindingRows(rows: readonly EncounterFindingRow[]): EncounterFindingRow[][] {
  const groups: EncounterFindingRow[][] = [];
  for (const row of orderedFindingRows(rows)) {
    const peer = groups.find(group => group.length === 1 && group[0].atomicFindingId === row.atomicFindingId &&
      group[0].eye !== row.eye && row.eye !== "UNKNOWN" && group[0].eye !== "UNKNOWN" &&
      group[0].kind === row.kind && group[0].status === row.status && group[0].presence === row.presence &&
      equalQualifiers(group[0].qualifiers,row.qualifiers) && JSON.stringify([...group[0].homes].sort()) === JSON.stringify([...row.homes].sort()));
    if (peer) peer.push(row); else groups.push([row]);
  }
  return groups;
}
function equalQualifiers(a: EncounterFindingRow["qualifiers"], b: EncounterFindingRow["qualifiers"]): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}
export interface FindingCommandOptions {
  selectedConditionReference?: string; presence?: "present" | "absent"; grade?: string | null;
  toEyes?: FindingEye[]; searchIndex?: readonly EncounterFindingRow[]; liveConditionReferences?: readonly string[];
}
export function buildFindingCommand(rows: readonly EncounterFindingRow[], patientReference: string, operation: DiagnosisFindingMutation["operation"], options: FindingCommandOptions = {}): DiagnosisFindingMutation {
  const selected = options.selectedConditionReference;
  const liveHomes = (row: EncounterFindingRow) => row.homes.filter(home => !options.liveConditionReferences || options.liveConditionReferences.includes(home));
  const target = (row: EncounterFindingRow): FindingCommandTarget => {
    if (!row.key || !row.baseline) throw new Error("Choose an eye before recording this finding.");
    if (operation === "reassert") {
      if (row.baseline.kind !== "canonical") throw new Error("Only a recorded finding can be reasserted.");
      return { kind: "reassert", key: row.key, baseline: row.baseline };
    }
    const qualifiers = { ...row.qualifiers };
    if (operation === "grade") {
      if (options.grade) qualifiers.grade = options.grade; else delete qualifiers.grade;
    }
    const homes = operation === "standalone" ? [] : operation === "move" ? (selected ? [selected] : []) :
      operation === "assert" || operation === "link" ? [...new Set([...(row.status === "live" ? liveHomes(row) : []), ...(selected ? [selected] : [])])] : [...row.homes];
    return { kind: "fact", key: row.key, baseline: row.baseline, state: { status: operation === "clear" ? "retired" : "live", presence: options.presence ?? row.presence ?? "present", qualifiers, homes } };
  };
  let targets = rows.map(target);
  let eyes: DiagnosisFindingMutation["eyes"];
  if (operation === "eye-change") {
    const sources = options.searchIndex?.filter(r => r.atomicFindingId === rows[0].atomicFindingId && r.status === "live") ?? [...rows];
    if (sources.some(r => r.presence !== rows[0].presence || !equalQualifiers(r.qualifiers, rows[0].qualifiers))) throw new Error("The eyes have different findings. Review them before changing eyes.");
    const from = sources.map(r => r.eye).filter((eye): eye is FindingEye => eye !== "UNKNOWN");
    const to = options.toEyes ?? from;
    eyes = { from, to };
    targets = sources.filter(r => r.eye !== "UNKNOWN" && !to.includes(r.eye)).map(row => {
      const value = target(row) as Extract<FindingCommandTarget,{kind:"fact"}>;
      return { ...value, state: { ...value.state, status: "retired" } };
    });
    for (const eye of to.filter(eye => !from.includes(eye))) {
      const destination = options.searchIndex?.find(row => row.atomicFindingId === rows[0].atomicFindingId && row.eye === eye);
      if (!destination) throw new Error("Findings unavailable for the selected eye. Reload before changing eyes.");
      if (destination.status === "live") {
        if (destination.presence !== rows[0].presence || !equalQualifiers(destination.qualifiers, rows[0].qualifiers)) throw new Error("The other eye has different findings. Reload and review before changing eyes.");
        continue;
      }
      const value = target(destination) as Extract<FindingCommandTarget,{kind:"fact"}>;
      targets.push({ ...value, state: { status: "live", presence: rows[0].presence!, qualifiers: { ...rows[0].qualifiers }, homes: liveHomes(rows[0]) } });
    }
  }
  return { commandId: crypto.randomUUID(), patientReference, operation, ...(selected ? {context:{selectedConditionReference:selected}} : {}), targets, ...(eyes ? {eyes} : {}) };
}
