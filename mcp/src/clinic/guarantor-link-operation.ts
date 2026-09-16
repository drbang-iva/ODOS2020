import { createHash, randomUUID } from "node:crypto";
import type { Bundle, Extension, Patient, Person, Project, Reference, RelatedPerson, Resource, Task } from "@medplum/fhirtypes";
import { z } from "zod";
import { staffHasBusinessAction, type BusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { buildOdosAuditEventRow, type OdosAuditEventRecord, type OdosAuditEventType } from "../authz/odosAudit.js";
import type { MedplumClient } from "../fhir-client.js";
import { searchProjectAll } from "../fhir-search.js";
import { registrationProjectId, registrationResourceInProject } from "./patient-registration-endpoint.js";
import { hasResponsiblePartyRefusal, applyResponsiblePartyDemographics, projectResponsiblePartyDemographics } from "./responsible-party-demographics.js";

export const GUARANTOR_OPERATION_SYSTEM = "https://odos2020.com/fhir/CodeSystem/guarantor-link-operation";
export const GUARANTOR_CLAIM_URL = "https://odos2020.com/fhir/StructureDefinition/guarantor-link-claim";
export const GUARANTOR_EPOCH_URL = "https://odos2020.com/fhir/StructureDefinition/guarantor-link-epoch";
const JOURNAL_URL = "https://odos2020.com/fhir/StructureDefinition/guarantor-link-journal";
const IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/identifier/guarantor-link-operation";
const idSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const operationFields = {
  operationId: z.string().uuid(), relatedPersonIds: z.array(idSchema).min(1),
  expected: z.record(z.string().min(1)), reason: z.string().trim().min(1),
};
const startSchema = z.discriminatedUnion("kind", [
  z.object({ ...operationFields, kind: z.literal("transfer"), sourcePersonId: idSchema, destinationPersonId: idSchema }).strict(),
  z.object({ ...operationFields, kind: z.literal("consolidate"), sourcePersonId: idSchema, destinationPersonId: idSchema }).strict(),
  z.object({ ...operationFields, kind: z.literal("attach"), destinationPersonId: idSchema }).strict(),
]);
type Plan = {
  operationId: string; kind: "transfer" | "consolidate" | "attach" | "correct";
  sourcePersonId?: string; destinationPersonId?: string; relatedPersonIds: string[];
  expected: Record<string, string>; reason: string; originalTaskId?: string;
};
type Intent = { id: string; phase: string; target: string; expectedVersion: string; intendedContentHash: string; ownedHash?: string; disposition?: "landed" | "rejected" | "not-landed"; responseStatus?: number; writer?: string };
type Journal = { intents: Intent[]; generation?: string };
type Loaded = { source?: Person; destination?: Person; children: RelatedPerson[]; patients: Patient[] };

export interface GuarantorOperationStaff {
  staffReference: string; actorRole: PracticeRoleId; roles?: readonly PracticeRoleId[];
  businessActions?: readonly BusinessAction[]; project?: Reference<Project>;
}
export interface GuarantorOperationDeps {
  serviceFhir: Pick<MedplumClient, "baseUrl" | "readExtended" | "searchProject" | "searchProjectUrl" | "executeTransactionAsActor">;
  serviceReference: string;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
  now?: () => string;
}
export type GuarantorOperationResult = { status: number; body: unknown };
class Refusal extends Error { constructor(readonly status: number, message: string) { super(message); } }
class Paused extends Error { constructor(readonly phase: string, readonly target?: string) { super(phase === "destination-inactive" ? "The guarantor chosen for this change was discarded. Undo this change, then choose a guarantor." : "Pending: Complete or Correct."); } }
class Settled extends Error {}
const reference = (r: Resource) => `${r.resourceType}/${r.id}`;
function version(r: Resource): string { if (!r.id || !r.meta?.versionId) throw new Refusal(409, `Version missing for ${reference(r)}.`); return r.meta.versionId; }
function projectOf(r: Resource): string | undefined { return r.meta?.project?.replace(/^Project\//, ""); }
function claimReferences(r: RelatedPerson): string[] { return (r.extension ?? []).filter(e => e.url === GUARANTOR_CLAIM_URL).map(e => e.valueReference?.reference ?? ""); }
function withExtension<T extends Person | RelatedPerson>(r: T, url: string, value?: Extension): T {
  const extension = (r.extension ?? []).filter(e => e.url !== url);
  if (value) extension.push(value);
  return { ...r, extension: extension.length ? extension : undefined };
}
function claimed(r: RelatedPerson, taskId: string): RelatedPerson { return withExtension(r, GUARANTOR_CLAIM_URL, { url: GUARANTOR_CLAIM_URL, valueReference: { reference: `Task/${taskId}` } }); }
function ownClaim(r: RelatedPerson, taskId: string): boolean { const refs = claimReferences(r); return refs.length === 1 && refs[0] === `Task/${taskId}`; }
function linkedIds(p: Person): string[] {
  return (p.link ?? []).map(l => { const match = l.target.reference?.match(/^RelatedPerson\/([A-Za-z0-9.-]{1,64})$/); if (!match) throw new Refusal(422, `Person/${p.id} has an unsupported link.`); return match[1]; });
}
function equalIds(a: string[], b: string[]): boolean { return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) { const rows = value.map(canonical).filter(v => v !== undefined); return rows.length ? rows : undefined; }
  if (value && typeof value === "object") {
    const fields = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, v]) => { const normalized = canonical(v); return normalized === undefined ? [] : [[key, normalized]]; });
    return fields.length ? Object.fromEntries(fields) : undefined;
  }
  return value;
}
export function guarantorContentHash(resource: Resource): string {
  const { meta: _meta, ...body } = resource;
  const extension = "extension" in body ? body.extension?.filter(e => e.url !== GUARANTOR_EPOCH_URL) : undefined;
  return createHash("sha256").update(JSON.stringify(canonical({ ...body, ...("extension" in body ? { extension } : {}) }))).digest("hex");
}
function demographicsEqual(r: Person | RelatedPerson, p: Person): boolean {
  return JSON.stringify(canonical(projectResponsiblePartyDemographics(r))) === JSON.stringify(canonical(projectResponsiblePartyDemographics(p)));
}
function definiteStatus(error: unknown): number | undefined {
  const candidate = error as { status?: number; statusCode?: number; message?: string };
  return candidate?.status ?? candidate?.statusCode ?? (Number(candidate?.message?.match(/(?:FHIR|HTTP) (\d{3})\b/)?.[1]) || undefined);
}
function validateResponse(response: Bundle): void {
  const entry = response.entry?.[0]; const status = Number.parseInt(entry?.response?.status ?? "", 10);
  if (response.entry?.length !== 1 || !Number.isFinite(status)) throw new Error("The operation write response could not be determined.");
  if (status < 200 || status >= 300) throw new Refusal(status, `FHIR ${status}: operation write refused.`);
}
function taskInputs(plan: Plan): Task["input"] {
  return [
    { type: { text: "kind" }, valueCode: plan.kind },
    ...(plan.sourcePersonId ? [{ type: { text: "source" }, valueReference: { reference: `Person/${plan.sourcePersonId}` } }] : []),
    ...(plan.destinationPersonId ? [{ type: { text: "destination" }, valueReference: { reference: `Person/${plan.destinationPersonId}` } }] : []),
    ...plan.relatedPersonIds.map(id => ({ type: { text: "moved" }, valueReference: { reference: `RelatedPerson/${id}` } })),
    ...Object.entries(plan.expected).map(([target, expected]) => ({ type: { text: `expected:${target}` }, valueString: expected })),
    { type: { text: "reason" }, valueString: plan.reason },
  ];
}
function readPlan(task: Task): Plan {
  const inputs = task.input ?? [];
  const one = (name: string) => { const rows = inputs.filter(i => i.type.text === name); if (rows.length !== 1) throw new Refusal(422, "Operation plan is invalid."); return rows[0]; };
  const optional = (name: string) => { const rows = inputs.filter(i => i.type.text === name); if (rows.length > 1) throw new Refusal(422, "Operation plan is invalid."); return rows[0]; };
  const kind = one("kind").valueCode;
  const operationId = task.identifier?.find(i => i.system === IDENTIFIER_SYSTEM)?.value;
  const sourcePersonId = optional("source")?.valueReference?.reference?.replace(/^Person\//, "");
  const destinationPersonId = optional("destination")?.valueReference?.reference?.replace(/^Person\//, "");
  const relatedPersonIds = inputs.filter(i => i.type.text === "moved").map(i => i.valueReference?.reference?.replace(/^RelatedPerson\//, ""));
  const expected = Object.fromEntries(inputs.filter(i => i.type.text?.startsWith("expected:")).map(i => [i.type.text!.slice(9), i.valueString]));
  const reason = one("reason").valueString;
  const validBase = z.object(operationFields).safeParse({ operationId, relatedPersonIds, expected, reason });
  if (!validBase.success || !["transfer", "consolidate", "attach", "correct"].includes(kind ?? "")) throw new Refusal(422, "Operation plan is invalid.");
  const originalTaskId = task.basedOn?.[0]?.reference?.match(/^Task\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  if (kind === "correct" && !originalTaskId) throw new Refusal(422, "Correction has no original operation.");
  if (kind === "attach" && (sourcePersonId || !destinationPersonId || relatedPersonIds.length !== 1)) throw new Refusal(422, "Operation plan is invalid.");
  if ((kind === "transfer" || kind === "consolidate") && (!sourcePersonId || !destinationPersonId)) throw new Refusal(422, "Operation plan is invalid.");
  if (kind === "correct" && ((!sourcePersonId && !destinationPersonId) || (!sourcePersonId && destinationPersonId))) throw new Refusal(422, "Operation plan is invalid.");
  return { ...validBase.data, kind: kind as Plan["kind"], ...(sourcePersonId ? { sourcePersonId } : {}), ...(destinationPersonId ? { destinationPersonId } : {}), ...(originalTaskId ? { originalTaskId } : {}) };
}

class Operation {
  readonly project: string;
  constructor(readonly deps: GuarantorOperationDeps, readonly staff: GuarantorOperationStaff) {
    if (!staffHasBusinessAction(staff, "guarantor.link")) throw new Refusal(403, "guarantor.link action required.");
    if (!staff.project) throw new Refusal(422, "Staff practice is unavailable.");
    this.project = registrationProjectId(staff.project);
  }
  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    const r = await this.deps.serviceFhir.readExtended<T>(type, id);
    if (projectOf(r) !== this.project) throw new Refusal(422, `${type}/${id} is outside this practice.`);
    return r;
  }
  async owners(id: string): Promise<Person[]> { return searchProjectAll<Person>(this.deps.serviceFhir, "Person", this.project, { link: `RelatedPerson/${id}` }); }
  trusted(task: Task): boolean { return projectOf(task) === this.project && task.meta?.author?.reference === this.deps.serviceReference && Boolean(task.code?.coding?.some(c => c.system === GUARANTOR_OPERATION_SYSTEM)); }
  async plan(task: Task): Promise<Plan> {
    const plan = readPlan(task);
    if (plan.kind !== "correct") return plan;
    const original = await this.read<Task>("Task", plan.originalTaskId!);
    if (!this.trusted(original)) throw new Refusal(403, "Original operation record is not service-authored.");
    const originalPlan = readPlan(original);
    if (originalPlan.kind === "attach") {
      if (plan.destinationPersonId || plan.sourcePersonId !== originalPlan.destinationPersonId) throw new Refusal(422, "Operation plan is invalid.");
    } else if (!plan.sourcePersonId || !plan.destinationPersonId) throw new Refusal(422, "Operation plan is invalid.");
    return plan;
  }
  async activeClaim(child: RelatedPerson): Promise<Task | undefined> {
    for (const ref of claimReferences(child)) {
      const id = ref.match(/^Task\/([A-Za-z0-9.-]{1,64})$/)?.[1]; if (!id) continue;
      let task: Task;
      try { task = await this.deps.serviceFhir.readExtended<Task>("Task", id); } catch (error) { if (definiteStatus(error) === 404) continue; throw error; }
      if (this.trusted(task) && task.status === "in-progress" && (await this.plan(task)).relatedPersonIds.includes(child.id!)) return task;
    }
    return undefined;
  }
  async existing(operationId: string): Promise<Task | undefined> {
    const tasks = await searchProjectAll<Task>(this.deps.serviceFhir, "Task", this.project, { identifier: `${IDENTIFIER_SYSTEM}|${operationId}` });
    if (tasks.length > 1) throw new Refusal(409, "Operation identifier is ambiguous.");
    if (tasks[0] && !this.trusted(tasks[0])) throw new Refusal(403, "Operation record is not service-authored.");
    return tasks[0];
  }
  async load(plan: Plan): Promise<Loaded> {
    const source = plan.sourcePersonId ? await this.read<Person>("Person", plan.sourcePersonId) : undefined;
    const destination = plan.destinationPersonId ? await this.read<Person>("Person", plan.destinationPersonId) : undefined;
    const children: RelatedPerson[] = [], patients: Patient[] = [];
    for (const id of plan.relatedPersonIds) {
      const child = await this.read<RelatedPerson>("RelatedPerson", id);
      const patientId = child.patient.reference?.match(/^Patient\/([A-Za-z0-9.-]{1,64})$/)?.[1];
      if (!patientId) throw new Refusal(422, `RelatedPerson/${id} has an unsupported patient.`);
      children.push(child); patients.push(await this.read<Patient>("Patient", patientId));
    }
    return { source, destination, children, patients };
  }
  async validate(plan: Plan): Promise<Loaded> {
    if ((plan.sourcePersonId && plan.sourcePersonId === plan.destinationPersonId) || new Set(plan.relatedPersonIds).size !== plan.relatedPersonIds.length) throw new Refusal(422, "Choose distinct guarantors and unique responsible parties.");
    const loaded = await this.load(plan);
    for (const r of [loaded.source, loaded.destination, ...loaded.children].filter((resource): resource is Person | RelatedPerson => Boolean(resource))) if (plan.expected[reference(r)] !== version(r)) throw new Refusal(409, `${reference(r)} changed; preview again.`);
    if (plan.kind === "attach") {
      linkedIds(loaded.destination!);
      if (loaded.destination!.active === false) throw new Refusal(422, "Destination guarantor is inactive.");
      for (const child of loaded.children) {
        if ((await this.owners(child.id!)).length) throw new Refusal(409, `${child.patient.reference}: responsible party already has a guarantor.`);
        const holder = await this.activeClaim(child); if (holder) throw new Refusal(409, `${child.patient.reference}: operation ${holder.id} is in progress.`);
      }
      return loaded;
    }
    const sourceIds = linkedIds(loaded.source!); linkedIds(loaded.destination!);
    if (loaded.destination!.active === false) throw new Refusal(422, "Destination guarantor is inactive.");
    if (plan.kind === "consolidate" && !equalIds(sourceIds, plan.relatedPersonIds)) throw new Refusal(422, "Consolidation must include every linked patient.");
    for (const child of loaded.children) {
      if (!sourceIds.includes(child.id!) || !equalIds((await this.owners(child.id!)).map(p => p.id!), [loaded.source!.id!])) throw new Refusal(409, `${child.patient.reference}: responsible party must belong only to the source guarantor.`);
      const holder = await this.activeClaim(child); if (holder) throw new Refusal(409, `${child.patient.reference}: operation ${holder.id} is in progress.`);
    }
    return loaded;
  }
  async transaction<T extends Resource>(resource: T, phase: string, method: "POST" | "PUT", expected?: string, resultStatus?: { value?: number }): Promise<T> {
    const bundle: Bundle = { resourceType: "Bundle", type: "transaction", entry: [{ resource,
      request: { method, url: method === "POST" ? resource.resourceType : reference(resource),
        ...(expected ? { ifMatch: `W/"${expected}"` } : {}),
        ...(method === "POST" ? { ifNoneExist: `identifier=${encodeURIComponent(`${IDENTIFIER_SYSTEM}|${(resource as Task).identifier![0].value}`)}` } : {}) },
    }] };
    // fhir-service-write: Task, Person, RelatedPerson
    const response = await this.deps.serviceFhir.executeTransactionAsActor(bundle, {
      actorReference: this.staff.staffReference, actorRole: this.staff.actorRole,
      actionReason: `guarantor.link ${phase}${resource.id ? ` ${reference(resource)}` : ""}`,
    }, { "X-ODOS-Source": "mcp/guarantor-link-operation", "X-Medplum": "extended" }, { autoRollbackCreatedEntries: false, validateResponse });
    const entry = response.entry![0];
    if (resultStatus) resultStatus.value = Number.parseInt(entry.response!.status!, 10);
    if (entry.resource?.resourceType === resource.resourceType) return entry.resource as T;
    const id = entry.response?.location?.match(/(?:^|\/)(?:Task|Person|RelatedPerson)\/([^/]+)/)?.[1] ?? resource.id;
    if (!id) throw new Error("Operation write response did not identify its resource.");
    return this.read<T>(resource.resourceType, id);
  }
  async record(plan: Plan): Promise<{ task: Task; created: boolean }> {
    const initial = registrationResourceInProject<Task>({ resourceType: "Task", intent: "order", status: "in-progress", businessStatus: { text: "claiming" },
      identifier: [{ system: IDENTIFIER_SYSTEM, value: plan.operationId }], code: { coding: [{ system: GUARANTOR_OPERATION_SYSTEM, code: plan.kind }] },
      input: taskInputs(plan), requester: { reference: this.staff.staffReference }, ...(plan.originalTaskId ? { basedOn: [{ reference: `Task/${plan.originalTaskId}` }] } : {}) }, this.project);
    const status: { value?: number } = {};
    try { const task = await this.transaction(initial, "record", "POST", undefined, status); return { task, created: status.value === 201 }; }
    catch (error) { if (definiteStatus(error)) throw error; const found = await this.existing(plan.operationId); if (!found) throw error; return { task: found, created: false }; }
  }
  async summary(task: Task) {
    if (!this.trusted(task)) return { task, active: false };
    const plan = await this.plan(task); const loaded = await this.load(plan);
    return { task, active: this.trusted(task) && task.status === "in-progress", kind: plan.kind,
      phase: task.businessStatus?.text ?? "", ...(plan.sourcePersonId ? { sourcePersonId: plan.sourcePersonId } : {}), ...(plan.destinationPersonId ? { destinationPersonId: plan.destinationPersonId } : {}),
      relatedPersonIds: plan.relatedPersonIds, patients: loaded.children.map((c, index) => {
        const p = loaded.patients[index], name = p.name?.find(n => n.use === "official") ?? p.name?.[0];
        return { relatedPersonId: c.id!, patientId: p.id!, name: name?.text || [...name?.given ?? [], name?.family].filter(Boolean).join(" ") || `Patient/${p.id}` };
      }) };
  }
}

export function guarantorOwnedHash(resource: Resource, phase: string): string {
  let owned: unknown;
  if (phase.startsWith("fence-")) {
    owned = (resource as Person).extension?.find(e => e.url === GUARANTOR_EPOCH_URL)?.valueString;
  } else if (phase === "detaching" || phase === "attaching") {
    const person = resource as Person;
    owned = { link: [...new Set((person.link ?? []).map(link => link.target.reference ?? ""))].sort(), active: person.active };
  } else if (phase === "claiming" || phase === "releasing" || phase === "projecting") {
    const child = resource as RelatedPerson;
    owned = { claims: [...new Set(claimReferences(child))].sort(), ...(phase === "projecting" ? { name: child.name, telecom: child.telecom, address: child.address, ...(hasResponsiblePartyRefusal(child) ? { noTextableNumber: true } : {}) } : {}) };
  } else return guarantorContentHash(resource);
  return createHash("sha256").update(JSON.stringify(canonical(owned) ?? null)).digest("hex");
}
function intentMatches(resource: Resource, intent: Intent): boolean {
  return intent.ownedHash !== undefined ? guarantorOwnedHash(resource, intent.phase) === intent.ownedHash : guarantorContentHash(resource) === intent.intendedContentHash;
}

class Run {
  journal: Journal;
  readonly envelope: Task;
  resuming = false;
  checkpointError?: { cause: unknown };
  constructor(readonly operation: Operation, public task: Task, readonly plan: Plan, public loaded: Loaded) {
    this.envelope = { resourceType: "Task", id: task.id, intent: "order", status: "in-progress", identifier: [{ system: IDENTIFIER_SYSTEM, value: plan.operationId }],
      code: { coding: [{ system: GUARANTOR_OPERATION_SYSTEM, code: plan.kind }] }, input: taskInputs(plan), requester: structuredClone(task.requester),
      ...(plan.originalTaskId ? { basedOn: [{ reference: `Task/${plan.originalTaskId}` }] } : {}) };
    const journal = task.extension?.find(e => e.url === JOURNAL_URL)?.valueString;
    this.journal = journal ? JSON.parse(journal) : { intents: [] };
  }
  async checkpointTask(status: Task["status"], phase: string): Promise<void> {
    if (this.checkpointError) throw this.checkpointError.cause;
    if (this.task.status !== "in-progress" && status !== this.task.status) throw new Refusal(409, "The operation is already terminal.");
    try { this.task = await this.operation.transaction<Task>({ ...this.envelope, meta: this.task.meta, status, businessStatus: { text: phase }, extension: [{ url: JOURNAL_URL, valueString: JSON.stringify(this.journal) }] }, phase, "PUT", version(this.task)); }
    catch (error) { this.checkpointError = { cause: error }; throw error; }
  }
  async checkpointResponse(intent: Intent, disposition: "landed" | "rejected", status: number, writer?: string): Promise<void> {
    const fresh = await this.operation.read<Task>("Task", this.task.id!);
    if (!this.operation.trusted(fresh)) throw new Refusal(403, "Operation record is not service-authored.");
    const journal: Journal = JSON.parse(fresh.extension?.find(e => e.url === JOURNAL_URL)?.valueString ?? '{"intents":[]}');
    const recorded = journal.intents.find(i => i.id === intent.id);
    if (!recorded || recorded.target !== intent.target || recorded.expectedVersion !== intent.expectedVersion || recorded.intendedContentHash !== intent.intendedContentHash) throw new Refusal(409, "The recorded write intent changed.");
    Object.assign(recorded, { disposition, responseStatus: status, ...(writer ? { writer } : {}) });
    this.journal = journal; this.task = fresh;
    await this.checkpointTask(fresh.status, fresh.businessStatus?.text ?? intent.phase);
    if (fresh.status !== "in-progress") throw new Settled();
  }
  async audit(event: "started" | "completed" | "pending" | "failed" | "interfered", phase: string, target?: string, writer?: string): Promise<void> {
    for (const patient of this.loaded.patients) await this.operation.deps.recordAudit(buildOdosAuditEventRow({
      eventType: `guarantor.link.${event}` as OdosAuditEventType, eventTime: this.operation.deps.now?.(),
      actorReference: this.operation.staff.staffReference, actorRole: this.operation.staff.actorRole, patientId: patient.id,
      resourceType: "Task", resourceId: this.task.id, actionOutcome: "granted",
      actionReason: `${this.plan.kind} Task/${this.task.id} S=${this.plan.sourcePersonId ? `Person/${this.plan.sourcePersonId}` : "none"} D=${this.plan.destinationPersonId ? `Person/${this.plan.destinationPersonId}` : "none"} phase=${phase}${target ? ` target=${target}` : ""}${writer ? ` writer=${writer}` : ""}; ${this.plan.reason}`,
    }));
  }
  async write<T extends Person | RelatedPerson | Task>(phase: string, resource: T, expected = version(resource)): Promise<T> {
    const intent: Intent = { id: randomUUID(), phase, target: reference(resource), expectedVersion: expected, intendedContentHash: guarantorContentHash(resource), ownedHash: guarantorOwnedHash(resource, phase) };
    this.journal.intents.push(intent);
    await this.checkpointTask("in-progress", phase);
    let accepted: T;
    try { accepted = await this.operation.transaction(resource, phase, "PUT", expected); }
    catch (error) {
      const status = definiteStatus(error);
      if (status) await this.checkpointResponse(intent, "rejected", status);
      throw error;
    }
    await this.checkpointResponse(intent, "landed", 200, accepted.meta?.author?.reference);
    return accepted;
  }
  ownershipLanded(): boolean { return this.journal.intents.some(i => i.disposition === "landed" && ["detaching", "attaching", "projecting", "releasing"].includes(i.phase)); }
  async pause(phase: string, target?: string): Promise<never> {
    if (this.task.status !== "in-progress") throw new Settled();
    await this.checkpointTask("in-progress", phase); await this.audit("pending", phase, target);
    if (phase === "interfered") await this.audit("interfered", phase, target);
    throw new Paused(phase, target);
  }
  async fail(phase: string, target?: string): Promise<never> {
    if (this.task.status !== "in-progress") throw new Settled();
    if (this.ownershipLanded()) return this.pause("recovery-conflict", target);
    await this.checkpointTask("failed", phase); await this.audit("failed", phase, target); throw new Paused(phase, target);
  }
  async original(): Promise<void> {
    for (const id of [...this.plan.relatedPersonIds].sort()) {
      const child = this.loaded.children.find(c => c.id === id)!;
      try { await this.write("claiming", claimed(child, this.task.id!), this.plan.expected[reference(child)]); }
      catch (error) { if (definiteStatus(error) === 412) return this.fail("claim-conflict", reference(child)); return this.pause("claim-pending", reference(child)); }
    }
    await this.move();
  }
  async checkCorrections(): Promise<"cancelled" | "pending" | undefined> {
    const corrections = (await searchProjectAll<Task>(this.operation.deps.serviceFhir, "Task", this.operation.project,
      { "based-on": `Task/${this.task.id}`, code: `${GUARANTOR_OPERATION_SYSTEM}|` }))
      .filter(task => this.operation.trusted(task) && task.basedOn?.some(r => r.reference === `Task/${this.task.id}`));
    if (corrections.some(t => t.status === "completed")) {
      await this.checkpointTask("cancelled", "corrected");
      return "cancelled";
    }
    if (corrections.some(t => t.status === "in-progress")) return "pending";
    return undefined;
  }
  async complete(): Promise<boolean> {
    if (this.plan.kind === "correct" && !this.ownershipLanded()) {
      const original = await this.operation.read<Task>("Task", this.plan.originalTaskId!);
      if (!this.operation.trusted(original)) return this.pause("interfered", reference(original));
      if (original.status !== "completed" && original.status !== "in-progress") {
        await this.checkpointTask("cancelled", "superseded");
        await this.audit("pending", "superseded", reference(original));
        return true;
      }
    }
    const correction = await this.checkCorrections();
    if (correction) return correction === "cancelled";
    this.resuming = true;
    await this.classifyAndFence();
    await this.resumeClaims();
    if (this.plan.kind === "correct") await this.detachCurrentOwners();
    await this.move();
    return true;
  }
  async resolve(intent: Intent, disposition: Intent["disposition"], writer?: string): Promise<void> {
    const recorded = this.journal.intents.find(i => i.id === intent.id)!;
    recorded.disposition = disposition; recorded.writer = writer;
    await this.checkpointTask("in-progress", this.task.businessStatus?.text ?? intent.phase);
    if (disposition === "landed") await this.audit("pending", `recovered-${intent.phase}`, intent.target, writer);
  }
  async refuseInactiveDestination(destination: Person): Promise<void> {
    if (this.plan.kind !== "correct" && destination.active === false) await this.pause("destination-inactive", reference(destination));
  }
  async classifyAndFence(): Promise<void> {
    if (this.loaded.destination) await this.refuseInactiveDestination(await this.operation.read<Person>("Person", this.loaded.destination.id!));
    const unresolved = this.journal.intents.filter(i => !i.disposition);
    for (const intent of unresolved.filter(i => i.target.startsWith("RelatedPerson/"))) {
      const child = await this.operation.read<RelatedPerson>("RelatedPerson", intent.target.slice(14));
      if (version(child) === intent.expectedVersion) await this.resolve(intent, "not-landed");
      else if (intentMatches(child, intent)) await this.resolve(intent, "landed", child.meta?.author?.reference);
      else return this.pause("interfered", intent.target);
    }
    const epoch = randomUUID();
    for (const key of (["source", "destination"] as const).filter(key => this.loaded[key])) {
      const current = await this.operation.read<Person>("Person", this.loaded[key]!.id!);
      if (key === "destination") await this.refuseInactiveDestination(current);
      const candidates = unresolved.filter(i => i.target === reference(current));
      const intent = candidates[candidates.length - 1];
      const fenced = (p: Person) => withExtension(p, GUARANTOR_EPOCH_URL, { url: GUARANTOR_EPOCH_URL, valueString: epoch });
      try {
        this.loaded[key] = await this.write(`fence-${key}`, fenced(current), intent?.expectedVersion ?? version(current));
        if (intent) await this.resolve(intent, "not-landed");
      } catch (error) {
        if (!intent || definiteStatus(error) !== 412) return this.pause("recovery-conflict", reference(current));
        const fresh = await this.operation.read<Person>("Person", current.id!);
        if (key === "destination") await this.refuseInactiveDestination(fresh);
        if (!intentMatches(fresh, intent)) return this.pause("interfered", intent.target);
        await this.resolve(intent, "landed", fresh.meta?.author?.reference);
        try { this.loaded[key] = await this.write(`fence-${key}`, fenced(fresh)); }
        catch { return this.pause("recovery-conflict", reference(fresh)); }
      }
    }
  }
  released(id: string): boolean { return this.journal.intents.some(i => i.target === `RelatedPerson/${id}` && i.phase === "releasing" && i.disposition === "landed"); }
  async recoveryWrite<T extends Person | RelatedPerson>(phase: string, resource: T, rebuild: (fresh: T) => Promise<T>): Promise<T> {
    try { return await this.write(phase, resource); }
    catch (error) {
      if (this.checkpointError) throw this.checkpointError.cause;
      if (this.task.status !== "in-progress") return this.pause(phase, reference(resource));
      if (definiteStatus(error) !== 412) return this.pause("recovery-conflict", reference(resource));
      let fresh = await this.operation.read<T>(resource.resourceType, resource.id!);
      if (version(fresh) === version(resource)) return this.pause("recovery-conflict", reference(fresh));
      const correction = await this.checkCorrections();
      if (correction) throw new Paused(correction === "cancelled" ? "corrected" : "takeover-in-progress", reference(fresh));
      if (phase !== "claiming") {
        await this.resumeClaims();
        if (resource.resourceType === "RelatedPerson") fresh = await this.operation.read<T>(resource.resourceType, resource.id!);
      }
      const next = await rebuild(fresh);
      try { return await this.write(phase, next); }
      catch { return this.pause("recovery-conflict", reference(next)); }
    }
  }
  async resumeClaims(): Promise<void> {
    for (const id of [...this.plan.relatedPersonIds].sort()) {
      if (this.released(id)) continue;
      const build = async (child: RelatedPerson): Promise<RelatedPerson> => {
        if (ownClaim(child, this.task.id!)) return child;
        if (this.plan.kind === "correct" && !this.ownershipLanded()) {
          const original = await this.operation.read<Task>("Task", this.plan.originalTaskId!);
          if (!this.operation.trusted(original)) return this.pause("interfered", reference(original));
          return this.takeoverClaim(child, original);
        }
        const refs = claimReferences(child);
        if (refs.length === 1 && /^Task\/[^/]+$/.test(refs[0])) {
          let holder: Task | undefined;
          try { holder = await this.operation.deps.serviceFhir.readExtended<Task>("Task", refs[0].slice(5)); }
          catch (error) { if (definiteStatus(error) !== 404) throw error; }
          if (holder && this.operation.trusted(holder) && readPlan(holder).kind === "correct" && readPlan(holder).relatedPersonIds.includes(id) && holder.basedOn?.some(r => r.reference === `Task/${this.task.id}`)) {
            if (holder.status === "in-progress") throw new Paused("takeover-in-progress", reference(child));
            if (holder.status === "failed" || holder.status === "cancelled") return claimed(child, this.task.id!);
          }
        }
        if (await this.operation.activeClaim(child)) return this.pause("interfered", reference(child));
        const checkpointed = this.journal.intents.some(i => i.target === reference(child) && i.phase === "claiming" && i.disposition === "landed");
        const owners = await this.operation.owners(id);
        if (!refs.length && checkpointed && !owners.length) return claimed(child, this.task.id!);
        const expectedOwners = this.plan.kind === "attach" ? [] : [this.plan.sourcePersonId!];
        if (!checkpointed && !this.ownershipLanded() && equalIds(owners.map(p => p.id!), expectedOwners)) return claimed(child, this.task.id!);
        return this.pause("interfered", reference(child));
      };
      const child = await this.operation.read<RelatedPerson>("RelatedPerson", id);
      if (ownClaim(child, this.task.id!)) continue;
      const candidate = await build(child);
      if (!this.ownershipLanded()) {
        try { await this.write("claiming", candidate); }
        catch (error) { if (definiteStatus(error) === 412) return this.fail(this.plan.kind === "correct" ? "takeover-conflict" : "claim-conflict", reference(child)); return this.pause("claim-pending", reference(child)); }
      } else await this.recoveryWrite("claiming", candidate, build);
    }
  }
  async takeoverClaim(child: RelatedPerson, original: Task): Promise<RelatedPerson> {
    const owners = await this.operation.owners(child.id!);
    const originalPlan = readPlan(original);
    const allowed = [this.plan.sourcePersonId, this.plan.destinationPersonId].filter((id): id is string => Boolean(id));
    const originalAttachLanded = originalPlan.kind === "attach" && new Run(this.operation, original, originalPlan, await this.operation.load(originalPlan)).journal.intents.some(intent => intent.phase === "attaching" && intent.disposition === "landed");
    const invalidAttachOwners = originalPlan.kind === "attach" && (
      owners.length > 1 || owners.some(person => person.id !== this.plan.sourcePersonId)
      || (original.status === "completed" && !equalIds(owners.map(person => person.id!), [this.plan.sourcePersonId!]))
      || (original.status === "in-progress" && !owners.length && originalAttachLanded)
    );
    if (invalidAttachOwners || (originalPlan.kind !== "attach" && (owners.length > 1 || owners.some(p => !allowed.includes(p.id!)) || (original.status === "completed" && !equalIds(owners.map(p => p.id!), [this.plan.sourcePersonId!]))))) return this.fail("correction-conflict", reference(child));
    const holder = await this.operation.activeClaim(child);
    if (holder && holder.id !== original.id && holder.id !== this.task.id) return this.pause("interfered", reference(child));
    return claimed(child, this.task.id!);
  }
  async correct(original: Task): Promise<void> {
    await this.classifyAndFence();
    for (const id of [...this.plan.relatedPersonIds].sort()) {
      const child = await this.operation.read<RelatedPerson>("RelatedPerson", id);
      const candidate = await this.takeoverClaim(child, original);
      try { await this.write("claiming", candidate); }
      catch (error) { if (definiteStatus(error) === 412) return this.fail("takeover-conflict", reference(child)); return this.pause("claim-pending", reference(child)); }
    }
    this.resuming = true;
    await this.detachCurrentOwners();
    await this.move();
  }
  async detachCurrentOwners(): Promise<void> {
    for (const id of [...this.plan.relatedPersonIds].sort()) {
      if (this.released(id)) continue;
      const owners = await this.operation.owners(id);
      const allowed = [this.plan.sourcePersonId, this.plan.destinationPersonId].filter((personId): personId is string => Boolean(personId));
      if (owners.length > 1 || owners.some(p => !allowed.includes(p.id!))) return this.pause("interfered", `RelatedPerson/${id}`);
      if (!owners.length) continue;
      const owner = await this.operation.read<Person>("Person", owners[0].id!);
      const detach = async (fresh: Person): Promise<Person> => {
        const now = await this.operation.owners(id);
        if (now.length > 1 || now.some(p => p.id !== fresh.id)) return this.pause("interfered", `RelatedPerson/${id}`);
        return withoutLinks(fresh, [id]);
      };
      const accepted = await this.recoveryWrite("detaching", await detach(owner), detach);
      if (owner.id === this.plan.sourcePersonId) this.loaded.source = accepted;
      else this.loaded.destination = accepted;
    }
  }
  async cancelOriginal(): Promise<void> {
    const id = this.plan.originalTaskId!;
    const accepted = await this.operation.read<Task>("Task", id);
    if (!this.operation.trusted(accepted)) return this.pause("interfered", `Task/${id}`);
    const originalPlan = readPlan(accepted);
    const original = new Run(this.operation, accepted, originalPlan, this.loaded);
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = attempt === 0 ? accepted : await this.operation.read<Task>("Task", id);
      if (!this.operation.trusted(fresh)) return this.pause("interfered", `Task/${id}`);
      if (fresh.status === "cancelled") return;
      const cancelled: Task = { ...original.envelope, meta: fresh.meta, extension: fresh.extension, status: "cancelled", businessStatus: { text: "corrected" } };
      try { await this.write("cancel-original", cancelled); return; }
      catch (error) { if (definiteStatus(error) !== 412) return this.pause("recovery-conflict", `Task/${id}`); }
    }
    return this.pause("recovery-conflict", `Task/${id}`);
  }
  async move(): Promise<void> {
    const pendingIds = this.plan.relatedPersonIds.filter(id => !this.released(id));
    if (!pendingIds.length) return this.finish();
    const detach = async (source: Person): Promise<Person> => withoutLinks(source, pendingIds);
    if (this.loaded.source && linkedIds(this.loaded.source).some(id => pendingIds.includes(id))) {
      const detached = await detach(this.loaded.source);
      if (this.resuming) this.loaded.source = await this.recoveryWrite("detaching", detached, detach);
      else try { this.loaded.source = await this.write("detaching", detached); }
      catch { return this.pause("detach-pending", reference(this.loaded.source)); }
    }
    if (!this.loaded.destination) return this.verifyUnlinkAndRelease();
    const attach = async (destination: Person): Promise<Person> => {
      await this.refuseInactiveDestination(destination);
      for (const id of pendingIds) {
        const owners = await this.operation.owners(id);
        if (owners.some(p => p.id !== destination.id)) return this.pause("interfered", `RelatedPerson/${id}`);
      }
      const present = new Set(linkedIds(destination));
      return { ...destination, ...(this.plan.kind === "correct" ? { active: true } : {}), link: [...destination.link ?? [], ...pendingIds.filter(id => !present.has(id)).map(id => ({ target: { reference: `RelatedPerson/${id}` }, assurance: "level2" as const }))] };
    };
    if (pendingIds.some(id => !linkedIds(this.loaded.destination!).includes(id))) {
      const destination = await attach(this.loaded.destination!);
      if (this.resuming) this.loaded.destination = await this.recoveryWrite("attaching", destination, attach);
      else try { this.loaded.destination = await this.write("attaching", destination); }
      catch { return this.pause("attach-pending", reference(destination)); }
    }
    await this.projectAndRelease();
  }
  async verifyUnlinkAndRelease(): Promise<void> {
    const verified: RelatedPerson[] = [];
    for (const id of [...this.plan.relatedPersonIds].sort()) {
      if (this.released(id)) continue;
      const child = await this.operation.read<RelatedPerson>("RelatedPerson", id);
      if ((await this.operation.owners(id)).length || !ownClaim(child, this.task.id!)) return this.pause("project-pending", reference(child));
      verified.push(child);
    }
    await this.checkpointTask("in-progress", "verified");
    for (const child of verified) {
      const released = withExtension(child, GUARANTOR_CLAIM_URL);
      if (this.resuming) await this.recoveryWrite("releasing", released, async fresh => {
        if (!ownClaim(fresh, this.task.id!) || (await this.operation.owners(fresh.id!)).length) return this.pause("interfered", reference(fresh));
        return withExtension(fresh, GUARANTOR_CLAIM_URL);
      });
      else try { await this.write("releasing", released); }
      catch { return this.pause("project-pending", reference(child)); }
    }
    await this.finish();
  }
  async projectAndRelease(): Promise<void> {
    const destination = await this.operation.read<Person>("Person", this.plan.destinationPersonId!);
    this.journal.generation = version(destination);
    for (const id of [...this.plan.relatedPersonIds].sort()) {
      if (this.released(id)) continue;
      const child = await this.operation.read<RelatedPerson>("RelatedPerson", id);
      if (!ownClaim(child, this.task.id!)) return this.pause("interfered", reference(child));
      const currentDestination = await this.operation.read<Person>("Person", destination.id!);
      if (version(currentDestination) !== version(destination)) return this.pause("project-pending", reference(destination));
      const projected = applyResponsiblePartyDemographics(child, destination);
      if (this.resuming) await this.recoveryWrite("projecting", projected, async fresh => {
        if (!ownClaim(fresh, this.task.id!)) return this.pause("interfered", reference(fresh));
        const current = await this.operation.read<Person>("Person", destination.id!);
        if (version(current) !== version(destination)) return this.pause("project-pending", reference(current));
        return applyResponsiblePartyDemographics(fresh, current);
      });
      else try { await this.write("projecting", projected); }
      catch { return this.pause("project-pending", reference(child)); }
    }
    const verified: RelatedPerson[] = [];
    for (const id of [...this.plan.relatedPersonIds].sort()) {
      if (this.released(id)) continue;
      const child = await this.operation.read<RelatedPerson>("RelatedPerson", id);
      const owners = await this.operation.owners(id);
      if (!equalIds(owners.map(p => p.id!), [destination.id!]) || !ownClaim(child, this.task.id!) || !demographicsEqual(child, destination)) return this.pause("project-pending", reference(child));
      verified.push(child);
    }
    const source = this.plan.sourcePersonId ? await this.operation.read<Person>("Person", this.plan.sourcePersonId) : undefined;
    const trailing = await this.operation.read<Person>("Person", destination.id!);
    if ((source && linkedIds(source).some(id => this.plan.relatedPersonIds.includes(id) && !this.released(id))) || (source && this.plan.kind === "consolidate" && !this.plan.relatedPersonIds.some(id => this.released(id)) && (source.active !== false || linkedIds(source).length)) || version(trailing) !== version(destination)) return this.pause("project-pending", reference(trailing));
    await this.checkpointTask("in-progress", "verified");
    for (const child of verified) {
      const released = withExtension(child, GUARANTOR_CLAIM_URL);
      if (this.resuming) await this.recoveryWrite("releasing", released, async fresh => {
        if (!ownClaim(fresh, this.task.id!) || !demographicsEqual(fresh, destination) || !equalIds((await this.operation.owners(fresh.id!)).map(p => p.id!), [destination.id!])) return this.pause("interfered", reference(fresh));
        return withExtension(fresh, GUARANTOR_CLAIM_URL);
      });
      else try { await this.write("releasing", released); }
      catch { return this.pause("project-pending", reference(child)); }
    }
    await this.finish();
  }
  async finish(): Promise<void> {
    if (this.plan.kind === "correct") await this.cancelOriginal();
    const phase = this.plan.kind === "correct" && !this.plan.destinationPersonId ? "unlinked" : "linked";
    await this.checkpointTask("completed", phase); await this.audit("completed", phase);
  }
}

function withoutLinks(person: Person, ids: string[]): Person {
  const link = (person.link ?? []).filter(l => !ids.includes(l.target.reference!.slice(14)));
  return { ...person, link, ...(!link.length ? { active: false } : {}) };
}

export async function handleGuarantorOperation(deps: GuarantorOperationDeps, staff: GuarantorOperationStaff,
  request: { action: string; taskId?: string; body?: unknown }): Promise<GuarantorOperationResult> {
  let run: Run | undefined;
  try {
    const operation = new Operation(deps, staff);
    if (request.action === "status") {
      const task = await operation.read<Task>("Task", idSchema.parse(request.taskId));
      if (!task.code?.coding?.some(c => c.system === GUARANTOR_OPERATION_SYSTEM)) return { status: 404, body: { error: "Operation not found." } };
      return { status: 200, body: await operation.summary(task) };
    }
    if (request.action === "complete") {
      const task = await operation.read<Task>("Task", idSchema.parse(request.taskId));
      if (!operation.trusted(task)) throw new Refusal(403, "Operation record is not service-authored.");
      if (task.status !== "in-progress") throw new Refusal(409, "Only a pending operation can be completed.");
      const plan = await operation.plan(task); run = new Run(operation, task, plan, await operation.load(plan));
      const advanced = await run.complete();
      return { status: advanced ? 200 : 409, body: { ...await operation.summary(run.task), ...(!advanced ? { phase: "takeover-in-progress", error: "A correction is in progress. Complete that correction first." } : {}) } };
    }
    if (request.action === "correct") {
      const input = z.object({ operationId: z.string().uuid(), reason: z.string().trim().min(1) }).strict().safeParse(request.body);
      if (!input.success) throw new Refusal(422, "A new operation identifier and correction reason are required.");
      const existing = await operation.existing(input.data.operationId); if (existing) return { status: 200, body: await operation.summary(existing) };
      const original = await operation.read<Task>("Task", idSchema.parse(request.taskId));
      if (!operation.trusted(original)) throw new Refusal(403, "Operation record is not service-authored.");
      const originalPlan = await operation.plan(original);
      if (originalPlan.kind === "correct") throw new Refusal(422, "A correction cannot itself be corrected; use a new transfer.");
      if (original.status !== "in-progress" && original.status !== "completed") throw new Refusal(409, "Only a pending or completed operation can be corrected.");
      const corrections = await searchProjectAll<Task>(deps.serviceFhir, "Task", operation.project, { "based-on": `Task/${original.id}`, code: `${GUARANTOR_OPERATION_SYSTEM}|correct` });
      if (corrections.some(task => operation.trusted(task) && task.status === "in-progress" && task.basedOn?.some(r => r.reference === `Task/${original.id}`) && readPlan(task).kind === "correct")) throw new Refusal(409, "A correction of this operation is already in progress.");
      const plan: Plan = originalPlan.kind === "attach"
        ? { ...input.data, kind: "correct", sourcePersonId: originalPlan.destinationPersonId, relatedPersonIds: originalPlan.relatedPersonIds, expected: {}, originalTaskId: original.id }
        : { ...originalPlan, ...input.data, kind: "correct", sourcePersonId: originalPlan.destinationPersonId, destinationPersonId: originalPlan.sourcePersonId, originalTaskId: original.id };
      const loaded = await operation.load(plan);
      if (loaded.source) linkedIds(loaded.source);
      if (loaded.destination) linkedIds(loaded.destination);
      for (const child of loaded.children) {
        const owners = await operation.owners(child.id!);
        const journal: Journal = JSON.parse(original.extension?.find(extension => extension.url === JOURNAL_URL)?.valueString ?? '{"intents":[]}');
        const attachLanded = journal.intents.some(intent => intent.phase === "attaching" && intent.disposition === "landed");
        const attachChanged = originalPlan.kind === "attach" && (owners.length > 1 || owners.some(person => person.id !== plan.sourcePersonId)
          || (original.status === "completed" && !equalIds(owners.map(person => person.id!), [plan.sourcePersonId!]))
          || (original.status === "in-progress" && !owners.length && attachLanded));
        const transferChanged = originalPlan.kind !== "attach" && (owners.length > 1 || owners.some(p => ![plan.sourcePersonId, plan.destinationPersonId].includes(p.id!)) || (original.status === "completed" && !equalIds(owners.map(p => p.id!), [plan.sourcePersonId!])));
        if (attachChanged || transferChanged) throw new Refusal(409, `${child.patient.reference}: ownership changed after the operation.`);
      }
      plan.expected = Object.fromEntries([loaded.source, loaded.destination, ...loaded.children].filter((resource): resource is Person | RelatedPerson => Boolean(resource)).map(r => [reference(r), version(r)]));
      const recorded = await operation.record(plan); if (!recorded.created) return { status: 200, body: await operation.summary(recorded.task) };
      run = new Run(operation, recorded.task, plan, loaded); await run.audit("started", "claiming"); await run.correct(original);
      return { status: 200, body: await operation.summary(run.task) };
    }
    if (request.action === "history") {
      const { relatedPersonId } = z.object({ relatedPersonId: idSchema }).strict().parse(request.body);
      const page = await deps.serviceFhir.searchProject<Task>("Task", operation.project, { code: `${GUARANTOR_OPERATION_SYSTEM}|`, _sort: "-_lastUpdated", _count: "50" });
      const tasks = (page.entry ?? []).flatMap(entry => entry.resource ? [entry.resource] : [])
        .filter(task => {
          if (!operation.trusted(task)) return false;
          try { return readPlan(task).relatedPersonIds.includes(relatedPersonId); }
          catch { return false; }
        });
      const correcting = new Set(tasks.filter(task => task.status === "in-progress" && readPlan(task).kind === "correct").flatMap(task => task.basedOn?.map(r => r.reference) ?? []));
      return { status: 200, body: await Promise.all(tasks.map(async task => ({ ...await operation.summary(task), correctionInProgress: correcting.has(`Task/${task.id}`) }))) };
    }
    if (request.action === "draft") {
      const input = z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("transfer"), sourcePersonId: idSchema, destinationPersonId: idSchema, relatedPersonIds: z.array(idSchema).min(1) }).strict(),
        z.object({ kind: z.literal("consolidate"), sourcePersonId: idSchema, destinationPersonId: idSchema }).strict(),
        z.object({ kind: z.literal("attach"), destinationPersonId: idSchema, relatedPersonIds: z.array(idSchema).length(1) }).strict(),
      ]).parse(request.body);
      const relatedPersonIds = input.kind === "consolidate" ? linkedIds(await operation.read<Person>("Person", input.sourcePersonId)) : input.relatedPersonIds;
      if (!relatedPersonIds.length) throw new Refusal(422, "Operation input is invalid.");
      const plan: Plan = { ...input, relatedPersonIds, operationId: randomUUID(), reason: "Draft only", expected: {} };
      const current = await operation.load(plan);
      plan.expected = Object.fromEntries([current.source, current.destination, ...current.children].filter((resource): resource is Person | RelatedPerson => Boolean(resource)).map(resource => [reference(resource), version(resource)]));
      const loaded = await operation.validate(plan);
      return { status: 200, body: { expected: plan.expected, relatedPersonIds, patients: loaded.children.map((child, index) => ({ relatedPersonId: child.id, patientId: loaded.patients[index].id, name: loaded.patients[index].name, current: projectResponsiblePartyDemographics(child), resulting: projectResponsiblePartyDemographics(loaded.destination!) })) } };
    }
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) throw new Refusal(422, "Operation input is invalid.");
    const plan = parsed.data;
    if (request.action === "create") { const existing = await operation.existing(plan.operationId); if (existing) return { status: 200, body: await operation.summary(existing) }; }
    const loaded = await operation.validate(plan);
    if (request.action === "preview") return { status: 200, body: { expected: Object.fromEntries([loaded.source, loaded.destination, ...loaded.children].filter((resource): resource is Person | RelatedPerson => Boolean(resource)).map(r => [reference(r), version(r)])), patients: loaded.children.map((c, i) => ({ relatedPersonId: c.id, patientId: loaded.patients[i].id, name: loaded.patients[i].name, current: projectResponsiblePartyDemographics(c), resulting: projectResponsiblePartyDemographics(loaded.destination!) })) } };
    if (request.action !== "create") throw new Refusal(422, "Unsupported operation action.");
    const recorded = await operation.record(plan); if (!recorded.created) return { status: 200, body: await operation.summary(recorded.task) };
    run = new Run(operation, recorded.task, plan, loaded);
    await run.audit("started", "claiming"); await run.original();
    return { status: 200, body: await operation.summary(run.task) };
  } catch (error) {
    if (run?.checkpointError) error = run.checkpointError.cause;
    if (error instanceof Settled && run) return { status: 200, body: await run.operation.summary(run.task) };
    if (error instanceof Paused && run) return { status: 409, body: { ...await run.operation.summary(run.task), phase: error.phase, error: error.message, target: error.target } };
    return { status: error instanceof z.ZodError ? 422 : definiteStatus(error) ?? 500, body: { error: error instanceof Refusal ? error.message : "The operation result could not be confirmed. Reload its status before continuing." } };
  }
}
