import type { Bundle, Patient, Person, RelatedPerson, Resource } from "@medplum/fhirtypes";
import { projectResponsiblePartyDemographics, type ResponsiblePartyDemographics } from "../../../mcp/src/clinic/responsible-party-demographics";
import { CONCURRENT_EDIT_MESSAGE, fhir } from "./fhir";
import { getGuarantorLinkOperation, type GuarantorLinkOperation } from "./guarantor-link-operations";

export type GuarantorDemographics = ResponsiblePartyDemographics;
export interface GuarantorChild { resource: RelatedPerson; patientName: string }
export interface GuarantorSnapshot { person: Person; children: GuarantorChild[] }
export type GuarantorClassification = "verified" | "mismatched" | "unknown" | "superseded";
export interface GuarantorChildResult {
  relatedPersonId: string; patientId: string; patientName: string;
  classification: GuarantorClassification;
  writeStatus?: "updated" | "conflict" | "error" | "no-response" | "stopped";
}
export interface GuarantorResult {
  status: "saved" | "unchanged" | "not-saved" | "partial" | "unknown" | "superseded";
  message: string; generation?: string; children: GuarantorChildResult[]; snapshot?: GuarantorSnapshot;
}
export type GuarantorLoad = {
  kind: "editable"; relatedPerson: RelatedPerson; snapshot: GuarantorSnapshot; verification: GuarantorResult;
} | {
  kind: "missing" | "ambiguous" | "unknown" | "dangling"; relatedPerson: RelatedPerson; message: string; personIds: string[];
} | {
  kind: "pending"; relatedPerson: RelatedPerson; message: string; personIds: string[]; operation: GuarantorLinkOperation;
};
const source = "guarantor-editor";
const claimUrl = "https://odos2020.com/fhir/StructureDefinition/guarantor-link-claim";
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  return value;
}
const demographicsMatch = (a: GuarantorDemographics, b: GuarantorDemographics) => same(projectResponsiblePartyDemographics(a), projectResponsiblePartyDemographics(b));
function version(resource: Resource): string {
  if (!resource.id || !resource.meta?.versionId) throw new Error("The guarantor record has no version; reload before editing.");
  return resource.meta.versionId;
}
function linkedIds(person: Person): string[] {
  const ids: string[] = [];
  for (const link of person.link ?? []) {
    const reference = link.target?.reference;
    if (!reference?.startsWith("RelatedPerson/")) continue;
    if (!/^RelatedPerson\/[^/]+$/.test(reference)) throw new Error("The guarantor has an unsupported related-person reference.");
    if (!ids.includes(reference.slice(14))) ids.push(reference.slice(14));
  }
  if (!ids.length) throw new Error("No linked responsible party; reload before editing.");
  return ids;
}
async function searchAll<T extends Resource>(type: T["resourceType"], params: Record<string,string>): Promise<T[]> {
  let bundle: Bundle<T> = await fhir.search<T>(type, params);
  const resources: T[] = [];
  for (;;) {
    resources.push(...(bundle.entry ?? []).flatMap(e => e.resource ? [e.resource] : []));
    const next = bundle.link?.find(l => l.relation === "next")?.url;
    if (!next) return resources;
    bundle = await fhir.searchUrl<T>(next);
  }
}
async function child(resource: RelatedPerson): Promise<GuarantorChild> {
  const reference = resource.patient.reference ?? "";
  let patientName = reference || "Unknown patient";
  if (/^Patient\/[^/]+$/.test(reference)) {
    try {
      const patient = await fhir.read<Patient>("Patient", reference.slice(8));
      const name = patient.name?.find(n => n.use === "official") ?? patient.name?.[0];
      patientName = name?.text || [...name?.given ?? [], name?.family].filter(Boolean).join(" ") || reference;
    } catch { /* Keep the explicit patient reference when its name cannot be read. */ }
  }
  return { resource, patientName };
}
class DanglingGuarantorLink extends Error {
  constructor(readonly personId: string, relatedPersonId: string) {
    super(`Person/${personId}, RelatedPerson/${relatedPersonId}: linked record cannot be read — deleted or outside this practice. Editing refused.`);
  }
}
async function readSnapshot(person: Person): Promise<GuarantorSnapshot> {
  version(person);
  const children: GuarantorChild[] = [];
  for (const id of linkedIds(person)) {
    let resource: RelatedPerson;
    try { resource = await fhir.read<RelatedPerson>("RelatedPerson", id); }
    catch (error) {
      if (error instanceof Error && /^FHIR (404|410)\b/.test(error.message)) throw new DanglingGuarantorLink(person.id!, id);
      throw error;
    }
    version(resource);
    children.push(await child(resource));
  }
  return { person, children };
}
export async function listPatientResponsibleParties(patientId: string): Promise<GuarantorLoad[]> {
  const parties = await searchAll<RelatedPerson>("RelatedPerson", { patient: `Patient/${patientId}` });
  return Promise.all(parties.map(p => resolveGuarantor(p)));
}
export async function loadGuarantor(relatedPersonId: string): Promise<GuarantorLoad> {
  return resolveGuarantor(await fhir.read<RelatedPerson>("RelatedPerson", relatedPersonId));
}
async function activeOperation(resource: RelatedPerson): Promise<GuarantorLinkOperation | undefined> {
  for (const extension of resource.extension ?? []) {
    if (extension.url !== claimUrl) continue;
    const reference = extension.valueReference?.reference;
    if (!reference || !/^Task\/[A-Za-z0-9.-]+$/.test(reference)) continue;
    const operation = await getGuarantorLinkOperation(reference.slice(5));
    if (operation?.active && operation.relatedPersonIds.includes(resource.id!)) return operation;
  }
}
function pending(relatedPerson: RelatedPerson, operation: GuarantorLinkOperation): GuarantorLoad {
  return { kind: "pending", relatedPerson, operation, personIds: [operation.sourcePersonId, operation.destinationPersonId],
    message: `Guarantor ${operation.kind === "correct" ? "correction" : operation.kind} ${operation.task.id} is pending. ${operation.kind === "correct" ? "Complete the correction" : "Complete or correct the operation"} before editing contact details.` };
}
async function resolveGuarantor(relatedPerson: RelatedPerson): Promise<GuarantorLoad> {
  try {
    const operation = await activeOperation(relatedPerson);
    if (operation) return pending(relatedPerson, operation);
    const persons = await searchAll<Person>("Person", { link: `RelatedPerson/${relatedPerson.id}` });
    if (!persons.length) return { kind: "missing", relatedPerson, personIds: [], message: "No linked guarantor record — pre-migration." };
    if (persons.length !== 1) return { kind: "ambiguous", relatedPerson, personIds: persons.map(p => p.id!), message: `Ambiguous guarantor for ${relatedPerson.patient.reference}, RelatedPerson/${relatedPerson.id}: ${persons.map(p => `Person/${p.id}`).join(", ")}. Editing refused.` };
    const snapshot = await readSnapshot(persons[0]);
    for (const item of snapshot.children) {
      const linkedOperation = await activeOperation(item.resource);
      if (linkedOperation) return pending(relatedPerson, linkedOperation);
    }
    return { kind: "editable", relatedPerson, snapshot, verification: await verifyGuarantor(snapshot) };
  } catch (error) {
    if (error instanceof DanglingGuarantorLink) return { kind: "dangling", relatedPerson, personIds: [error.personId], message: error.message };
    return { kind: "unknown", relatedPerson, personIds: [], message: `Guarantor lookup could not be completed: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}
function resultChild(item: GuarantorChild, classification: GuarantorClassification): GuarantorChildResult {
  return { relatedPersonId: item.resource.id!, patientId: item.resource.patient.reference ?? "Unknown patient", patientName: item.patientName, classification };
}
export async function verifyGuarantor(snapshot: GuarantorSnapshot): Promise<GuarantorResult> {
  const generation = version(snapshot.person);
  const children: GuarantorChildResult[] = [];
  const refreshed: GuarantorChild[] = [];
  for (const item of snapshot.children) {
    try {
      const resource = await fhir.read<RelatedPerson>("RelatedPerson", item.resource.id!);
      refreshed.push({ ...item, resource });
      children.push(resultChild(item, demographicsMatch(resource, snapshot.person) ? "verified" : "mismatched"));
    } catch { children.push(resultChild(item, "unknown")); }
  }
  let trailing: Person;
  try { trailing = await fhir.read<Person>("Person", snapshot.person.id!); }
  catch { return { status: "unknown", message: "The guarantor generation could not be verified. Reload before continuing.", generation, children: children.map(c => ({ ...c, classification: "unknown" })) }; }
  if (trailing.meta?.versionId !== generation) return { status: "superseded", message: "A newer guarantor edit superseded this generation. Reload to see the current record.", generation, children: children.map(c => ({ ...c, classification: "superseded" })) };
  const status = children.every(c => c.classification === "verified") ? "saved" : children.some(c => c.classification === "unknown") ? "unknown" : "partial";
  return { status, message: status === "saved" ? `Verified against guarantor generation ${generation}.` : "Review the result for each patient.", generation, children, ...(refreshed.length === snapshot.children.length ? { snapshot: { person: trailing, children: refreshed } } : {}) };
}
async function confirmEditable(snapshot: GuarantorSnapshot): Promise<void> {
  version(snapshot.person);
  const ids = linkedIds(snapshot.person);
  if (!same([...ids].sort(), snapshot.children.map(c => c.resource.id).sort())) throw new Error("Linked responsible parties changed; reload.");
  for (const item of snapshot.children) {
    version(item.resource);
    const matches = await searchAll<Person>("Person", { link: `RelatedPerson/${item.resource.id}` });
    if (matches.length !== 1 || matches[0].id !== snapshot.person.id) throw new Error(`Editing refused for ${item.resource.patient.reference}, RelatedPerson/${item.resource.id}: expected one linked guarantor; found ${matches.map(p => `Person/${p.id}`).join(", ") || "none (pre-migration)"}.`);
  }
}
function stopped(snapshot: GuarantorSnapshot, status: "not-saved" | "unknown", message: string): GuarantorResult {
  return { status, message, children: snapshot.children.map(c => resultChild(c, "unknown")) };
}
async function writeChild(item: GuarantorChild, person: Person): Promise<GuarantorChildResult["writeStatus"]> {
  try {
    await fhir.update({ ...item.resource, ...projectResponsiblePartyDemographics(person) }, source, version(item.resource));
    return "updated";
  } catch (error) {
    if (error instanceof Error && error.message === CONCURRENT_EDIT_MESSAGE) return "conflict";
    return error instanceof Error && /^FHIR \d+/.test(error.message) ? "error" : "no-response";
  }
}
async function checkGeneration(person: Person): Promise<"stopped" | "no-response" | undefined> {
  try {
    const current = await fhir.read<Person>("Person", person.id!);
    return current.meta?.versionId === version(person) ? undefined : "stopped";
  } catch { return "no-response"; }
}
export async function saveGuarantor(snapshot: GuarantorSnapshot, demographics: GuarantorDemographics): Promise<GuarantorResult> {
  try {
    await confirmEditable(snapshot);
    const current = await readSnapshot(await fhir.read<Person>("Person", snapshot.person.id!));
    if (version(current.person) !== version(snapshot.person) || !same(linkedIds(current.person).sort(), linkedIds(snapshot.person).sort()) || snapshot.children.some(c => current.children.find(n => n.resource.id === c.resource.id)?.resource.meta?.versionId !== c.resource.meta?.versionId)) return stopped(snapshot, "not-saved", CONCURRENT_EDIT_MESSAGE);
  } catch (error) { return stopped(snapshot, "not-saved", error instanceof Error ? error.message : "Preflight failed; reload."); }
  if (demographicsMatch(snapshot.person, demographics)) {
    const verification = await verifyGuarantor(snapshot);
    return { ...verification, status: verification.status === "saved" ? "unchanged" : verification.status };
  }
  const intended = { ...snapshot.person, ...projectResponsiblePartyDemographics(demographics) };
  let accepted: Person;
  try {
    accepted = await fhir.update(intended, source, version(snapshot.person));
    version(accepted);
    if (accepted.meta?.versionId === snapshot.person.meta?.versionId) return stopped(snapshot, "unknown", "The guarantor write returned no new generation; reload.");
  } catch (error) {
    if (error instanceof Error && error.message === CONCURRENT_EDIT_MESSAGE) return stopped(snapshot, "not-saved", "Not saved — the guarantor record changed; reload.");
    if (error instanceof Error && /^FHIR \d+/.test(error.message)) return stopped(snapshot, "not-saved", error.message);
    try {
      accepted = await fhir.read<Person>("Person", snapshot.person.id!);
      const { meta: _a, ...actual } = accepted;
      const { meta: _b, ...expected } = intended;
      if (!same(actual, expected) || !accepted.meta?.versionId || accepted.meta.versionId === snapshot.person.meta?.versionId) return stopped(snapshot, "unknown", "The guarantor save could not be confirmed. Reload; no children were submitted.");
    } catch { return stopped(snapshot, "unknown", "The guarantor save could not be confirmed. Reload; no children were submitted."); }
  }
  const writes = new Map<string, GuarantorChildResult["writeStatus"]>();
  let halted: "stopped" | "no-response" | undefined;
  for (const item of snapshot.children) {
    if (!halted) {
      try {
        const fresh = await fhir.read<RelatedPerson>("RelatedPerson", item.resource.id!);
        if (await activeOperation(fresh)) halted = "stopped";
      } catch { halted = "no-response"; }
    }
    halted ??= await checkGeneration(accepted);
    writes.set(item.resource.id!, halted ?? await writeChild(item, accepted));
  }
  const verification = await verifyGuarantor({ ...snapshot, person: accepted });
  return { ...verification, ...(halted === "stopped" ? { status: "superseded" as const, message: "The guarantor changed or a link operation is pending. Reload to see the current record." } : {}), children: verification.children.map(c => ({ ...c, writeStatus: writes.get(c.relatedPersonId) })) };
}
export async function repairGuarantor(previous: GuarantorSnapshot): Promise<GuarantorResult> {
  let current: GuarantorSnapshot;
  try {
    current = await readSnapshot(await fhir.read<Person>("Person", previous.person.id!));
    await confirmEditable(current);
  } catch (error) { return stopped(previous, "unknown", error instanceof Error ? error.message : "Could not read the current guarantor."); }
  const superseded = version(current.person) !== version(previous.person);
  const writes = new Map<string, GuarantorChildResult["writeStatus"]>();
  let halted: "stopped" | "no-response" | undefined;
  for (const item of current.children) {
    if (halted) { writes.set(item.resource.id!, halted); continue; }
    if (demographicsMatch(item.resource, current.person)) continue;
    try {
      const fresh = await fhir.read<RelatedPerson>("RelatedPerson", item.resource.id!);
      halted = await activeOperation(fresh) ? "stopped" : await checkGeneration(current.person);
      if (halted) { writes.set(item.resource.id!, halted); continue; }
      if (!demographicsMatch(fresh, current.person)) writes.set(fresh.id!, await writeChild({ ...item, resource: fresh }, current.person));
    } catch { writes.set(item.resource.id!, "no-response"); }
  }
  const verification = await verifyGuarantor(current);
  return { ...verification, status: superseded || halted === "stopped" ? "superseded" : !writes.size && verification.status === "saved" ? "unchanged" : verification.status,
    message: halted === "stopped" ? "The guarantor changed or a link operation is pending. Reload to see the current record." : superseded ? `The earlier generation was superseded. Reconciled against current generation ${version(current.person)}. ${verification.message}` : verification.message,
    children: verification.children.map(c => ({ ...c, writeStatus: writes.get(c.relatedPersonId) })) };
}
