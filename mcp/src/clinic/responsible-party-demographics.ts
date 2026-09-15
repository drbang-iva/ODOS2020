import type { Person, RelatedPerson } from "@medplum/fhirtypes";

import { applyPhoneDraft, type PhoneDraft, ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL } from "./patient-telecom.js";
export type ResponsiblePartyDemographics = Pick<RelatedPerson, "name" | "telecom" | "address" | "extension">;
export function hasResponsiblePartyRefusal(source: ResponsiblePartyDemographics): boolean {
  return source.extension?.some(e => e.url === ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL && e.valueBoolean === true) ?? false;
}
export function applyResponsiblePartyDemographics<T extends ResponsiblePartyDemographics>(target: T, source: ResponsiblePartyDemographics): T {
  const { extension: refusal, ...fields } = projectResponsiblePartyDemographics(source);
  const extension = [...(target.extension ?? []).filter(e => e.url !== ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL), ...(refusal ?? [])];
  return { ...target, ...fields, extension: extension.length ? extension : undefined };
}
export type RegistrationDemographics = Record<"firstName" | "middleName" | "lastName" | "address" | "city" | "state" | "postalCode", string> & { phones: readonly { value: string; use: "mobile" | "home" | "work" }[]; textable: PhoneDraft["textable"] };

export function projectResponsiblePartyDemographics(source: ResponsiblePartyDemographics): ResponsiblePartyDemographics {
  return structuredClone({ name: source.name, telecom: source.telecom, address: source.address, ...(hasResponsiblePartyRefusal(source) ? { extension: [{ url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] } : {}) });
}

export function buildResponsiblePartyDemographics(party: RegistrationDemographics): ResponsiblePartyDemographics {
  return projectResponsiblePartyDemographics(applyPhoneDraft({
    resourceType: "Person",
    name: [{ use: "official", given: [party.firstName.trim(), party.middleName.trim()].filter(Boolean), family: party.lastName.trim() }],
    address: [party.address, party.city, party.state, party.postalCode].some((value) => value.trim())
      ? [{ use: "home", line: party.address.trim() ? [party.address.trim()] : undefined, city: party.city.trim() || undefined, state: party.state.trim() || undefined, postalCode: party.postalCode.trim() || undefined }]
      : undefined,
  }, { phones: party.phones.map(p => ({ ...p, sourceIndex: null })) as PhoneDraft["phones"], textable: party.textable }));
}

export function guarantorPersonIsAttachable(person: Person, projectId: string): boolean {
  return person.meta?.project?.replace(/^Project\//, "") === projectId
    && person.active !== false
    && (person.link ?? []).every(link => /^RelatedPerson\/[A-Za-z0-9.-]{1,64}$/.test(link.target.reference ?? ""));
}
