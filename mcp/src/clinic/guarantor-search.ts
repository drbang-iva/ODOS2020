import type { Bundle, Person, Task } from "@medplum/fhirtypes";
import { validatePatientPhones } from "./patient-telecom.js";
import { z } from "zod";
import { FhirSearchLimitError, FhirSearchPageLimitError, searchProjectAll } from "../fhir-search.js";
import { staffHasBusinessAction } from "../authz/roles.js";
import { registrationProjectId, isR4Date } from "./patient-registration-endpoint.js";
import { buildResponsiblePartyDemographics, guarantorPersonIsAttachable } from "./responsible-party-demographics.js";
import { buildOdosAuditEventRow } from "../authz/odosAudit.js";
import { GUARANTOR_OPERATION_SYSTEM } from "./guarantor-link-operation.js";
import type { GuarantorOperationDeps, GuarantorOperationResult, GuarantorOperationStaff } from "./guarantor-link-operation.js";

const normalName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const digits = (value: string) => value.replace(/\D/g, "");
export const searchPhoneDigits = (value: string) => {
  const valueDigits = digits(value);
  return valueDigits.length === 11 && valueDigits.startsWith("1") ? valueDigits.slice(1) : valueDigits;
};
const keys = z.object({ lastName: z.string().trim().min(1), firstName: z.string().trim().min(1).optional(), phone: z.string().trim().optional() }).strict()
  .refine(v => Boolean(v.firstName) !== (v.phone !== undefined))
  .refine(v => v.phone === undefined || searchPhoneDigits(v.phone).length >= 10);
const createSchema = z.object({ birthDate: z.string().refine(value => isR4Date(value) && value <= new Date().toISOString().slice(0, 10)), firstName: z.string().trim().min(1), lastName: z.string().trim().min(1),
  middleName: z.string().default(""), phones: z.tuple([z.object({ value: z.string(), use: z.enum(["mobile", "home", "work"]) }).strict(), z.object({ value: z.string(), use: z.enum(["mobile", "home", "work"]) }).strict()]).default([{ value: "", use: "mobile" }, { value: "", use: "mobile" }]), textable: z.enum(["phone1", "phone2", "neither", ""]).default(""), address: z.string().default(""), city: z.string().default(""), state: z.string().default(""), postalCode: z.string().default("") }).strict();
const tooMany = { status: 422, body: { error: "Too many matches; add a first name or phone." } };

export async function handleGuarantorSearch(deps: GuarantorOperationDeps, staff: GuarantorOperationStaff, input: unknown): Promise<GuarantorOperationResult> {
  if (!staffHasBusinessAction(staff, "guarantor.link")) return { status: 403, body: { error: "guarantor.link action required." } };
  const parsed = keys.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "Enter a last name and exactly one of first name or phone (at least 10 digits)." } };
  if (!staff.project) return { status: 422, body: { error: "Staff practice is unavailable." } };
  const project = registrationProjectId(staff.project), key = parsed.data;
  let persons: Person[];
  try { persons = await searchProjectAll<Person>(deps.serviceFhir, "Person", project, { name: normalName(key.lastName) }, { maxRows: 200 }); }
  catch (error) { if (error instanceof FhirSearchLimitError) return tooMany; throw error; }
  const found = persons.filter(person => {
    if (person.meta?.project?.replace(/^Project\//, "") !== project) throw new Error("Guarantor search returned a foreign-practice Person.");
    if (!person.link?.length || !guarantorPersonIsAttachable(person, project)) return false;
    return person.name?.some(name => normalName(name.family ?? "") === normalName(key.lastName) &&
      (key.firstName !== undefined ? normalName(name.given?.[0] ?? "") === normalName(key.firstName) : person.telecom?.some(contact => contact.system === "phone" && searchPhoneDigits(contact.value ?? "") === searchPhoneDigits(key.phone!))));
  });
  if (found.length > 20) return tooMany;
  return { status: 200, body: found.map(person => ({ personId: person.id, versionId: person.meta?.versionId,
    birthDate: person.birthDate ?? "", name: person.name?.[0]?.text || [...person.name?.[0]?.given ?? [], person.name?.[0]?.family].filter(Boolean).join(" "),
    phones: (person.telecom ?? []).filter(contact => contact.system === "phone").map(contact => contact.value ?? ""),
    city: person.address?.[0]?.city ?? "", postalCode: person.address?.[0]?.postalCode ?? "" })) };
}

export async function createGuarantor(deps: GuarantorOperationDeps, staff: GuarantorOperationStaff, input: unknown): Promise<GuarantorOperationResult> {
  if (!staffHasBusinessAction(staff, "guarantor.link")) return { status: 403, body: { error: "guarantor.link action required." } };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "First and last name and a valid date of birth, not in the future, are required; guarantor details are invalid." } };
  if (!staff.project) return { status: 422, body: { error: "Staff practice is unavailable." } };
  const errors = validatePatientPhones(parsed.data.phones, parsed.data.textable);
  if (Object.keys(errors).length) return { status: 400, body: { error: Object.values(errors).join(" ") } };
  const person: Person = { resourceType: "Person", birthDate: parsed.data.birthDate, active: true, meta: { project: registrationProjectId(staff.project) }, ...buildResponsiblePartyDemographics(parsed.data) };
  const bundle: Bundle = { resourceType: "Bundle", type: "transaction", entry: [{ resource: person, request: { method: "POST", url: "Person" } }] };
  // fhir-service-write: Person
  const response = await deps.serviceFhir.executeTransactionAsActor(bundle, { actorReference: staff.staffReference, actorRole: staff.actorRole, actionReason: "guarantor.link create Person" },
    { "X-ODOS-Source": "mcp/guarantor-search", "X-Medplum": "extended" }, { autoRollbackCreatedEntries: false, validateResponse: result => {
      if (result.entry?.length !== 1 || !/^2\d\d(?:\s|$)/.test(result.entry[0].response?.status ?? "")) throw new Error("Guarantor creation could not be confirmed.");
    } });
  const entry = response.entry![0];
  const location = entry.response?.location?.match(/(?:^|\/)Person\/([^/]+)\/_history\/([^/]+)/);
  const personId = entry.resource?.resourceType === "Person" ? entry.resource.id : location?.[1];
  const versionId = entry.resource?.resourceType === "Person" ? entry.resource.meta?.versionId : location?.[2];
  if (!personId || !versionId) throw new Error("Guarantor creation did not return an id and version. Reload before continuing.");
  return { status: 201, body: { personId, versionId } };
}


function unusedPerson(person: Person, project: string, referenced: ReadonlySet<string>): boolean {
  return person.meta?.project?.replace(/^Project\//, "") === project
    && person.active !== false && !person.link?.length && !referenced.has(`Person/${person.id}`);
}
async function operationPersons(deps: GuarantorOperationDeps, project: string): Promise<Set<string>> {
  // The Task scan is a courtesy check, not an atomic reservation. The operation engine enforces G1.
  const tasks = await searchProjectAll<Task>(deps.serviceFhir, "Task", project, { code: `${GUARANTOR_OPERATION_SYSTEM}|` });
  return new Set(tasks.flatMap(task => {
    if (task.meta?.project?.replace(/^Project\//, "") !== project) throw new Error("Guarantor Task search returned a foreign-practice Task.");
    return (task.input ?? []).filter(input => input.type.text === "source" || input.type.text === "destination")
      .flatMap(input => input.valueReference?.reference ? [input.valueReference.reference] : []);
  }));
}
const noLongerUnused = { status: 409, body: { error: "This guarantor record changed or is no longer unused. Reload before continuing." } };
const searchRefused = { status: 409, body: { error: "The complete guarantor search could not be checked. No records were discarded." } };
const discardSchema = z.object({ reason: z.string().trim().min(1), expectedVersion: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/) }).strict();
export async function listUnusedGuarantors(deps: GuarantorOperationDeps, staff: GuarantorOperationStaff): Promise<GuarantorOperationResult> {
  if (!staffHasBusinessAction(staff, "guarantor.link")) return { status: 403, body: { error: "guarantor.link action required." } };
  if (!staff.project) return { status: 422, body: { error: "Staff practice is unavailable." } };
  const project = registrationProjectId(staff.project);
  try {
    const referenced = await operationPersons(deps, project);
    const persons = await searchProjectAll<Person>(deps.serviceFhir, "Person", project);
    return { status: 200, body: persons.filter(person => unusedPerson(person, project, referenced)).map(person => ({
      personId: person.id, versionId: person.meta?.versionId,
      name: person.name?.[0]?.text || [...person.name?.[0]?.given ?? [], person.name?.[0]?.family].filter(Boolean).join(" "),
      birthDate: person.birthDate ?? "", phones: (person.telecom ?? []).filter(contact => contact.system === "phone").map(contact => contact.value ?? ""),
      city: person.address?.[0]?.city ?? "", postalCode: person.address?.[0]?.postalCode ?? "", lastUpdated: person.meta?.lastUpdated ?? "",
    })) };
  } catch (error) { if (error instanceof FhirSearchLimitError || error instanceof FhirSearchPageLimitError) return searchRefused; throw error; }
}
export async function discardUnusedGuarantor(deps: GuarantorOperationDeps, staff: GuarantorOperationStaff, personId: string, input: unknown): Promise<GuarantorOperationResult> {
  if (!staffHasBusinessAction(staff, "guarantor.link")) return { status: 403, body: { error: "guarantor.link action required." } };
  const parsed = discardSchema.safeParse(input);
  if (!parsed.success || !/^[A-Za-z0-9.-]{1,64}$/.test(personId)) return { status: 400, body: { error: "A valid guarantor id, version and reason are required." } };
  if (!staff.project) return { status: 422, body: { error: "Staff practice is unavailable." } };
  const project = registrationProjectId(staff.project);
  try {
    const referenced = await operationPersons(deps, project);
    const person = await deps.serviceFhir.readExtended<Person>("Person", personId);
    if (!unusedPerson(person, project, referenced) || person.meta?.versionId !== parsed.data.expectedVersion) return noLongerUnused;
    const actionReason = `guarantor.link discard Person; ${parsed.data.reason}`;
    // fhir-service-write: Person
    const response = await deps.serviceFhir.executeTransactionAsActor({ resourceType: "Bundle", type: "transaction", entry: [{
      resource: { ...person, active: false }, request: { method: "PUT", url: `Person/${personId}`, ifMatch: `W/"${person.meta.versionId}"` },
    }] }, { actorReference: staff.staffReference, actorRole: staff.actorRole, actionReason },
    { "X-ODOS-Source": "mcp/guarantor-search", "X-Medplum": "extended" }, { autoRollbackCreatedEntries: false, validateResponse: result => {
      const status = result.entry?.[0]?.response?.status ?? "";
      if (/^412(?:\s|$)/.test(status)) throw Object.assign(new Error("Guarantor changed."), { status: 412 });
      if (result.entry?.length !== 1 || !/^2\d\d(?:\s|$)/.test(status)) throw new Error("Guarantor discard could not be confirmed.");
    } });
    await deps.recordAudit(buildOdosAuditEventRow({ eventType: "guarantor.link.completed", eventTime: deps.now?.(), actorReference: staff.staffReference,
      actorRole: staff.actorRole, resourceType: "Person", resourceId: personId, actionOutcome: "granted", actionReason }));
    const entry = response.entry![0];
    const versionId = entry.resource?.meta?.versionId ?? entry.response?.location?.match(/\/_history\/([^/]+)/)?.[1];
    if (!versionId) throw new Error("Guarantor discard did not return a version. Reload before continuing.");
    return { status: 200, body: { personId, versionId } };
  } catch (error) {
    if (error instanceof FhirSearchLimitError || error instanceof FhirSearchPageLimitError) return searchRefused;
    if (typeof error === "object" && error !== null && "status" in error && (error.status === 412 || error.status === 404)) return noLongerUnused;
    throw error;
  }
}
