import type {
  Account,
  Bundle,
  BundleEntry,
  Patient,
  RelatedPerson,
} from "@medplum/fhirtypes";

export const ODOS_MRN_SYSTEM = "https://odos2020.com/fhir/NamingSystem/odos-mrn";
export const ODOS_MRN_ALLOCATION_TOKEN_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/odos-mrn-allocation-token";
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
export const ODOS_MRN_ALLOCATION_ATTEMPTS = 100;

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

export interface MrnReservationStore {
  patientIdentifierExists(mrn: string): Promise<boolean>;
  createReservation(account: Account, ifNoneExist: string): Promise<Account>;
}

export interface ReservedMrn {
  mrn: string;
  allocationToken: string;
  account: Account;
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

export async function reserveOdosMrn(
  store: MrnReservationStore,
  nextBase: () => number,
  nextToken: () => string,
): Promise<ReservedMrn> {
  for (let attempt = 0; attempt < ODOS_MRN_ALLOCATION_ATTEMPTS; attempt += 1) {
    const mrn = formatOdosMrn(nextBase());
    if (await store.patientIdentifierExists(mrn)) continue;
    const allocationToken = nextToken();
    let account: Account;
    try {
      account = await store.createReservation(
        buildMrnReservationAccount(mrn, allocationToken),
        `identifier=${ODOS_MRN_SYSTEM}|${mrn}`,
      );
    } catch (error) {
      if (error instanceof Error && /\bFHIR 403\b/.test(error.message)) {
        throw new Error(
          "Patient registration is not authorized for your account. Ask a practice administrator to verify registration permissions, then try again.",
        );
      }
      throw error;
    }
    if (account.identifier?.some(
      (identifier) =>
        identifier.system === ODOS_MRN_ALLOCATION_TOKEN_SYSTEM
        && identifier.value === allocationToken,
    )) {
      if (!account.id) throw new Error("MRN reservation Account was returned without an id.");
      return { mrn, allocationToken, account };
    }
  }
  throw new Error(`Unable to allocate a unique ODOS MRN after ${ODOS_MRN_ALLOCATION_ATTEMPTS} attempts.`);
}

export function buildMrnReservationAccount(mrn: string, allocationToken: string): Account {
  if (!isValidOdosMrn(mrn)) throw new Error("Cannot reserve an invalid ODOS MRN.");
  if (!allocationToken) throw new Error("MRN allocation token is required.");
  return {
    resourceType: "Account",
    identifier: [
      { use: "usual", type: { text: "ODOS medical record number" }, system: ODOS_MRN_SYSTEM, value: mrn },
      { system: ODOS_MRN_ALLOCATION_TOKEN_SYSTEM, value: allocationToken },
    ],
    status: "on-hold",
    name: `Pending ODOS chart ${mrn}`,
  };
}

export function buildPatientIdentityTransaction(input: {
  patient: Patient;
  reservation: ReservedMrn;
  responsibleParties: readonly ResponsiblePartyDraft[];
  today: string;
  nextUuid: () => string;
}): Bundle {
  const errors = validateResponsibleParties(
    input.responsibleParties,
    input.patient.birthDate ?? "",
    input.today,
  );
  if (Object.keys(errors).length > 0) throw new Error(Object.values(errors).join(" "));
  if (!input.reservation.account.id) throw new Error("MRN reservation Account is missing its id.");

  const patientFullUrl = `urn:uuid:${input.nextUuid()}`;
  const patient: Patient = {
    ...input.patient,
    identifier: [
      ...(input.patient.identifier ?? []).filter((identifier) => identifier.system !== ODOS_MRN_SYSTEM),
      {
        use: "usual",
        type: { text: "ODOS medical record number" },
        system: ODOS_MRN_SYSTEM,
        value: input.reservation.mrn,
      },
    ],
  };
  const entries: BundleEntry[] = [{
    fullUrl: patientFullUrl,
    resource: patient,
    request: { method: "POST", url: "Patient" },
  }];
  const partyReferences = new Map<string, string>();

  for (const party of input.responsibleParties) {
    if (party.kind === "self") {
      partyReferences.set(party.localId, patientFullUrl);
      continue;
    }
    const fullUrl = `urn:uuid:${input.nextUuid()}`;
    partyReferences.set(party.localId, fullUrl);
    entries.push({
      fullUrl,
      resource: buildRelatedPerson(party, patientFullUrl, input.today),
      request: { method: "POST", url: "RelatedPerson" },
    });
  }

  const account: Account = {
    resourceType: "Account",
    id: input.reservation.account.id,
    meta: input.reservation.account.meta,
    identifier: [
      ...(input.reservation.account.identifier ?? []).filter(
        (identifier) =>
          identifier.system !== ODOS_MRN_SYSTEM
          && identifier.system !== ODOS_MRN_ALLOCATION_TOKEN_SYSTEM,
      ),
      {
        use: "usual",
        type: { text: "ODOS medical record number" },
        system: ODOS_MRN_SYSTEM,
        value: input.reservation.mrn,
      },
    ],
    status: "active",
    type: { text: "Patient account" },
    name: `ODOS chart ${input.reservation.mrn}`,
    subject: [{ reference: patientFullUrl }],
    guarantor: input.responsibleParties.flatMap((party) => {
      if (!party.financialResponsible) return [];
      const reference = partyReferences.get(party.localId);
      if (!reference) throw new Error("Responsible party reference was not built.");
      return [{
        party: { reference },
        onHold: false,
        ...(party.kind === "person" ? { period: responsiblePartyPeriod(party) } : {}),
      }];
    }),
  };
  entries.push({
    resource: account,
    request: {
      method: "PUT",
      url: `Account/${account.id}`,
      ...(account.meta?.versionId ? { ifMatch: `W/"${account.meta.versionId}"` } : {}),
    },
  });
  return { resourceType: "Bundle", type: "transaction", entry: entries };
}

function buildRelatedPerson(
  party: ResponsiblePartyDraft,
  patientReference: string,
  today: string,
): RelatedPerson {
  const hasAddress = [party.address, party.city, party.state, party.postalCode]
    .some((value) => value.trim());
  return {
    resourceType: "RelatedPerson",
    active: responsiblePartyActiveOn(party, today),
    patient: { reference: patientReference },
    relationship: [{ text: relationshipLabel(party.relationship) }],
    name: [{
      use: "official",
      given: [party.firstName.trim(), party.middleName.trim()].filter(Boolean),
      family: party.lastName.trim(),
    }],
    telecom: party.phone.trim()
      ? [{ system: "phone", use: "home", value: party.phone.trim() }]
      : undefined,
    address: hasAddress
      ? [{
          use: "home",
          line: party.address.trim() ? [party.address.trim()] : undefined,
          city: party.city.trim() || undefined,
          state: party.state.trim() || undefined,
          postalCode: party.postalCode.trim() || undefined,
        }]
      : undefined,
    period: responsiblePartyPeriod(party),
    extension: [
      { url: CONSENT_AUTHORITY_EXTENSION_URL, valueBoolean: party.consentAuthority },
      { url: RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL, valueBoolean: party.primary },
      ...(party.courtOrderNotes.trim()
        ? [{ url: COURT_ORDER_NOTES_EXTENSION_URL, valueString: party.courtOrderNotes.trim() }]
        : []),
    ],
  };
}

function responsiblePartyPeriod(party: ResponsiblePartyDraft): { start?: string; end?: string } {
  return {
    ...(party.effectiveDate ? { start: party.effectiveDate } : {}),
    ...(party.endDate ? { end: party.endDate } : {}),
  };
}

function responsiblePartyActiveOn(party: ResponsiblePartyDraft, today: string): boolean {
  if (party.kind === "self") return true;
  return (!party.effectiveDate || party.effectiveDate <= today)
    && (!party.endDate || party.endDate >= today);
}

function relationshipLabel(value: ResponsiblePartyRelationship): string {
  if (value === "legal-guardian") return "Legal guardian";
  return value[0].toUpperCase() + value.slice(1);
}
