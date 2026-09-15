import type { Bundle, Person } from "@medplum/fhirtypes";
import { z } from "zod";
import { FhirSearchLimitError, searchProjectAll } from "../fhir-search.js";
import { staffHasBusinessAction } from "../authz/roles.js";
import { registrationProjectId } from "./patient-registration-endpoint.js";
import { buildResponsiblePartyDemographics, guarantorPersonIsAttachable } from "./responsible-party-demographics.js";
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
const createSchema = z.object({ firstName: z.string().trim().min(1), lastName: z.string().trim().min(1),
  middleName: z.string().default(""), phone: z.string().default(""), address: z.string().default(""), city: z.string().default(""), state: z.string().default(""), postalCode: z.string().default("") }).strict();
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
    name: person.name?.[0]?.text || [...person.name?.[0]?.given ?? [], person.name?.[0]?.family].filter(Boolean).join(" "),
    phones: (person.telecom ?? []).filter(contact => contact.system === "phone").map(contact => contact.value ?? ""),
    city: person.address?.[0]?.city ?? "", postalCode: person.address?.[0]?.postalCode ?? "" })) };
}

export async function createGuarantor(deps: GuarantorOperationDeps, staff: GuarantorOperationStaff, input: unknown): Promise<GuarantorOperationResult> {
  if (!staffHasBusinessAction(staff, "guarantor.link")) return { status: 403, body: { error: "guarantor.link action required." } };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "First and last name are required; guarantor details are invalid." } };
  if (!staff.project) return { status: 422, body: { error: "Staff practice is unavailable." } };
  const person: Person = { resourceType: "Person", active: true, meta: { project: registrationProjectId(staff.project) }, ...buildResponsiblePartyDemographics(parsed.data) };
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
