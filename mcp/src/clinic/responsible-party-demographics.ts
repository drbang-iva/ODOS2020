import type { RelatedPerson } from "@medplum/fhirtypes";

export type ResponsiblePartyDemographics = Pick<RelatedPerson, "name" | "telecom" | "address">;
type RegistrationDemographics = Record<"firstName" | "middleName" | "lastName" | "phone" | "address" | "city" | "state" | "postalCode", string>;

export function projectResponsiblePartyDemographics(source: ResponsiblePartyDemographics): ResponsiblePartyDemographics {
  return structuredClone({ name: source.name, telecom: source.telecom, address: source.address });
}

export function buildResponsiblePartyDemographics(party: RegistrationDemographics): Pick<RelatedPerson, "name" | "telecom" | "address"> {
  return projectResponsiblePartyDemographics({
    name: [{ use: "official", given: [party.firstName.trim(), party.middleName.trim()].filter(Boolean), family: party.lastName.trim() }],
    telecom: party.phone.trim() ? [{ system: "phone", use: "home", value: party.phone.trim() }] : undefined,
    address: [party.address, party.city, party.state, party.postalCode].some((value) => value.trim())
      ? [{ use: "home", line: party.address.trim() ? [party.address.trim()] : undefined, city: party.city.trim() || undefined, state: party.state.trim() || undefined, postalCode: party.postalCode.trim() || undefined }]
      : undefined,
  });
}
