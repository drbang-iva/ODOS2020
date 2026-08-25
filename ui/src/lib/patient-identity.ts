import type { Patient } from "@medplum/fhirtypes";

export const ODOS_MRN_SYSTEM = "https://odos2020.com/fhir/NamingSystem/odos-mrn";
export const EYEFINITY_EPM_PATIENT_ID_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/eyefinity-epm-patient-id";
export const EYEFINITY_EHR_PATIENT_ID_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/eyefinity-ehr-patient-id";
export const CONSENT_AUTHORITY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/related-person-consent-authority";
export const RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/related-person-primary";
export const COURT_ORDER_NOTES_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/related-person-court-order-notes";
export const ODOS_MRN_MIN = 100_001;
export const ODOS_MRN_MAX = 999_999;

export type ResponsiblePartyRelationship =
  | "parent"
  | "legal-guardian"
  | "spouse"
  | "other";

export interface ResponsiblePartyDraft {
  localId: string;
  kind: "self" | "person";
  relationship: ResponsiblePartyRelationship;
  firstName: string;
  middleName: string;
  lastName: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  financialResponsible: boolean;
  consentAuthority: boolean;
  primary: boolean;
  courtOrderNotes: string;
  effectiveDate: string;
  endDate: string;
}

export function emptySelfResponsibleParty(localId: string): ResponsiblePartyDraft {
  return {
    localId,
    kind: "self",
    relationship: "other",
    firstName: "",
    middleName: "",
    lastName: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    postalCode: "",
    financialResponsible: true,
    consentAuthority: false,
    primary: true,
    courtOrderNotes: "",
    effectiveDate: "",
    endDate: "",
  };
}

export function emptyRelatedResponsibleParty(
  localId: string,
  today: string,
): ResponsiblePartyDraft {
  return {
    ...emptySelfResponsibleParty(localId),
    kind: "person",
    relationship: "parent",
    financialResponsible: true,
    consentAuthority: true,
    effectiveDate: today,
  };
}

export function luhnCheckDigit(base: string): string {
  if (!/^\d{6}$/.test(base)) {
    throw new Error("ODOS MRN base must contain exactly six digits.");
  }
  let sum = 0;
  let double = true;
  for (let index = base.length - 1; index >= 0; index -= 1) {
    let digit = Number(base[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}

export function formatOdosMrn(value: number): string {
  if (!Number.isInteger(value) || value < ODOS_MRN_MIN || value > ODOS_MRN_MAX) {
    throw new Error(`ODOS MRN base must be an integer from ${ODOS_MRN_MIN} through ${ODOS_MRN_MAX}.`);
  }
  const base = String(value).padStart(6, "0");
  return `${base}${luhnCheckDigit(base)}`;
}

export function isValidOdosMrn(value: string): boolean {
  if (!/^\d{7}$/.test(value)) return false;
  const base = value.slice(0, 6);
  const numericBase = Number(base);
  return numericBase >= ODOS_MRN_MIN
    && numericBase <= ODOS_MRN_MAX
    && value[6] === luhnCheckDigit(base);
}

export function patientOdosMrn(patient: Patient): string | undefined {
  return patient.identifier?.find(
    (identifier) => identifier.system === ODOS_MRN_SYSTEM && isValidOdosMrn(identifier.value ?? ""),
  )?.value;
}

export function isR4Date(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isMinorOn(birthDate: string | undefined, today: string): boolean {
  if (!birthDate || !isR4Date(birthDate)) {
    throw new Error("A valid birth date is required to determine whether a patient is a minor.");
  }
  if (!isR4Date(today)) throw new Error("A valid current date is required to determine whether a patient is a minor.");
  const eighteenthBirthday = `${String(Number(birthDate.slice(0, 4)) + 18)}${birthDate.slice(4)}`;
  return eighteenthBirthday > today;
}

export function validateResponsibleParties(
  parties: readonly ResponsiblePartyDraft[],
  birthDate: string,
  today: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const collectionErrors: string[] = [];
  const minorStatusKnown = isR4Date(birthDate) && isR4Date(today);
  const minor = minorStatusKnown ? isMinorOn(birthDate, today) : undefined;
  if (!minorStatusKnown) {
    collectionErrors.push("A valid birth date and current date are required before responsible parties can be validated.");
  }
  if (parties.length === 0) {
    collectionErrors.push("At least one responsible party is required.");
    errors.responsibleParties = collectionErrors.join(" ");
    return errors;
  }
  let activeFinancial = 0;
  let activeConsent = 0;
  let activePrimaryPeople = 0;
  let selfCount = 0;

  parties.forEach((party, index) => {
    const key = (field: string) => `responsibleParties.${index}.${field}`;
    if (party.kind === "self") {
      selfCount += 1;
      if (party.financialResponsible) activeFinancial += 1;
      return;
    }
    if (!party.firstName.trim()) errors[key("firstName")] = "First name is required.";
    if (!party.lastName.trim()) errors[key("lastName")] = "Last name is required.";
    if (!party.relationship) errors[key("relationship")] = "Relationship is required.";
    if (!isR4Date(party.effectiveDate)) errors[key("effectiveDate")] = "A valid effective date is required.";
    if (party.endDate && !isR4Date(party.endDate)) errors[key("endDate")] = "End date must be valid.";
    if (party.endDate && party.endDate < party.effectiveDate) {
      errors[key("endDate")] = "End date cannot precede the effective date.";
    }
    if (party.financialResponsible) {
      if (!party.address.trim()) errors[key("address")] = "Mailing address is required for a guarantor.";
      if (!party.city.trim()) errors[key("city")] = "City is required for a guarantor.";
      if (!party.state.trim()) errors[key("state")] = "State is required for a guarantor.";
      if (!party.postalCode.trim()) errors[key("postalCode")] = "Postal code is required for a guarantor.";
    }
    if (responsiblePartyActiveOn(party, today)) {
      if (party.financialResponsible) activeFinancial += 1;
      if (party.consentAuthority) activeConsent += 1;
      if (party.primary) activePrimaryPeople += 1;
    }
  });

  if (selfCount > 1) collectionErrors.push("The patient can appear as self only once.");
  if (minor && selfCount > 0) collectionErrors.push("A minor cannot be registered as their own responsible party.");
  if (activeFinancial === 0) {
    collectionErrors.push("At least one current financially responsible party is required.");
  }
  if (minor && activeConsent === 0) {
    collectionErrors.push("A minor must have at least one current consent-authority party.");
  }
  const activePeople = parties.filter(
    (party) => party.kind === "person" && responsiblePartyActiveOn(party, today),
  );
  if (activePeople.length > 0 && activePrimaryPeople !== 1) {
    collectionErrors.push("Choose exactly one current related person as primary.");
  }
  if (collectionErrors.length > 0) errors.responsibleParties = collectionErrors.join(" ");
  return errors;
}

function responsiblePartyActiveOn(party: ResponsiblePartyDraft, today: string): boolean {
  if (party.kind === "self") return true;
  return (!party.effectiveDate || party.effectiveDate <= today)
    && (!party.endDate || party.endDate >= today);
}
