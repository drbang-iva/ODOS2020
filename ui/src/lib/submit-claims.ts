import type { ChargeItem, Coverage, Encounter, Patient, Practitioner, RelatedPerson } from "@medplum/fhirtypes";

export const ICD10_CM_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";
export const CPT_SYSTEM = "urn:ama:cpt";
export const HCPCS_SYSTEM = "https://bluebutton.cms.gov/resources/codesystem/hcpcs";

export interface ClaimMdProviderInput {
  name?: string;
  firstName?: string;
  lastName?: string;
  npi: string;
  taxId?: string;
  taxIdType?: "E" | "S";
  taxonomy?: string;
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  email?: string;
  fax?: string;
}

export interface ClaimMdPersonInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  dateOfBirth: string;
  sex: "M" | "F" | "U";
  memberId?: string;
  relationshipCode?: string;
  groupNumber?: string;
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface ProfessionalClaimDiagnosisInput {
  system: string;
  code: string;
  display?: string;
}

export type ProfessionalClaimChargeItemInput = ChargeItem & {
  diagnosisSequence?: number[];
  laterality?: string;
};

export interface ProfessionalClaimInput {
  created: string;
  serviceDate: string;
  patientReference: string;
  providerReference: string;
  insurerReference: string;
  coverageReference: string;
  patientAccountNumber: string;
  payerId: string;
  billingProvider: ClaimMdProviderInput;
  renderingProvider: ClaimMdProviderInput;
  subscriber: ClaimMdPersonInput;
  patient: ClaimMdPersonInput;
  diagnoses: ProfessionalClaimDiagnosisInput[];
  chargeItems: ProfessionalClaimChargeItemInput[];
  facilityReference?: string;
  claimFrequencyCode?: "1" | "7" | "8";
  claimControlNumber?: string;
}

export interface DiagnosisLine {
  system?: string;
  code: string;
  description: string;
}

export interface ChargeLine {
  id?: string;
  codeType: "CPT" | "HCPCS";
  codeSystem?: string;
  code: string;
  description: string;
  feeDollars: string;
  quantity: string;
  diagnosisSequence?: number[];
  laterality?: string;
  modifierExtension?: ChargeItem["modifierExtension"];
}

export interface EncounterClaimDraft {
  encounterReference: string;
  patientReference: string;
  serviceDate: string;
  diagnoses: DiagnosisLine[];
  charges: ChargeLine[];
  coverageReference?: string;
  insurerReference?: string;
  payerId?: string;
  warnings?: string[];
}

export interface ClaimDraft {
  created: string;
  serviceDate: string;
  patientReference: string;
  providerReference: string;
  insurerReference: string;
  coverageReference: string;
  patientAccountNumber: string;
  payerId: string;
  billingProvider: ClaimMdProviderInput;
  renderingProvider: ClaimMdProviderInput;
  subscriber: ClaimMdPersonInput;
  subscriberIsPatient: boolean;
  patient: ClaimMdPersonInput;
  diagnoses: DiagnosisLine[];
  charges: ChargeLine[];
}

export interface CoverageEntryInput {
  patientReference: string;
  payorReference: string;
  payorDisplay?: string;
  payerId?: string;
  planName?: string;
  coverageType?: "medical" | "vision";
  memberId: string;
  groupNumber: string;
  groupName?: string;
  relationship: SubscriberRelationship;
  relationshipSystem?: string;
  subscriberReference?: string;
  effectiveDate: string;
  endDate?: string;
  primary?: boolean;
  active?: boolean;
}

export type SubscriberRelationship = "child" | "parent" | "spouse" | "common" | "other" | "self" | "injured";

export const SUBSCRIBER_RELATIONSHIP_SYSTEM = "http://terminology.hl7.org/CodeSystem/subscriber-relationship";

export interface ClaimsApiOptions {
  authorization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clearinghouse?: "claimmd" | "stedi";
}

export interface SubmitClaimResult {
  claimId?: string;
  claimReference?: string;
  clearinghouse?: "claimmd" | "stedi";
  claimMdClaimId?: string;
  claimMdTrackingNumber?: string;
  stediCorrelationId?: string;
  stediTrackingNumber?: string;
  status?: string;
}

export type StediClaimResubmissionIntent = "correct" | "void";
export type StediPayerClassification = "confirmed-non-medicare" | "original-medicare";

export type StediClaimResubmissionDetermination =
  | { status: "ready"; claimFrequencyCode: "1" | "7" | "8"; claimControlNumber?: string }
  | { status: "manual"; reason: string; payerClaimControlNumber?: string };

export interface StediClaimResubmissionPreview {
  determination: StediClaimResubmissionDetermination;
  originalClaim?: ProfessionalClaimInput;
}

export interface StediClaimResubmissionInput {
  originalClaimReference: string;
  intent: StediClaimResubmissionIntent;
  payerClassification?: StediPayerClassification;
  patientControlNumber: string;
  revisedClaim?: ProfessionalClaimInput;
}

export function emptyProvider(): ClaimMdProviderInput {
  return { npi: "" };
}

export function emptyPerson(): ClaimMdPersonInput {
  return { firstName: "", lastName: "", dateOfBirth: "", sex: "U" };
}

export function mergeProviderDefaults(
  current: ClaimMdProviderInput,
  defaults: ClaimMdProviderInput,
): ClaimMdProviderInput {
  return Object.fromEntries(
    Object.entries({ ...defaults, ...current }).map(([key, value]) => [
      key,
      typeof value === "string" && !value.trim()
        ? defaults[key as keyof ClaimMdProviderInput]
        : value,
    ]),
  ) as unknown as ClaimMdProviderInput;
}

export function initialClaimDraft(today: string): ClaimDraft {
  return {
    created: today,
    serviceDate: today,
    patientReference: "",
    providerReference: "",
    insurerReference: "",
    coverageReference: "",
    patientAccountNumber: "",
    payerId: "",
    billingProvider: emptyProvider(),
    renderingProvider: emptyProvider(),
    subscriber: emptyPerson(),
    subscriberIsPatient: false,
    patient: emptyPerson(),
    diagnoses: [emptyDiagnosisLine()],
    charges: [emptyChargeLine()],
  };
}

export function emptyDiagnosisLine(): DiagnosisLine {
  return { code: "", description: "" };
}

export function emptyChargeLine(): ChargeLine {
  return { codeType: "CPT", code: "", description: "", feeDollars: "", quantity: "1" };
}

export function addDiagnosisLine(lines: readonly DiagnosisLine[]): DiagnosisLine[] {
  return [...lines, emptyDiagnosisLine()];
}

export function removeDiagnosisLine(lines: readonly DiagnosisLine[], index: number): DiagnosisLine[] {
  return lines.filter((_, candidate) => candidate !== index);
}

export function addChargeLine(lines: readonly ChargeLine[]): ChargeLine[] {
  return [...lines, emptyChargeLine()];
}

export function removeChargeLine(lines: readonly ChargeLine[], index: number): ChargeLine[] {
  return lines.filter((_, candidate) => candidate !== index);
}

export function claimPersonFromPatient(patient: Patient): ClaimMdPersonInput {
  const name = patient.name?.find((candidate) => candidate.use === "official") ?? patient.name?.[0];
  const address = patient.address?.find((candidate) => candidate.use === "billing")
    ?? patient.address?.find((candidate) => candidate.use === "home")
    ?? patient.address?.[0];
  return cleanPerson({
    firstName: name?.given?.[0] ?? "",
    middleName: name?.given?.slice(1).join(" ") || undefined,
    lastName: name?.family ?? "",
    dateOfBirth: patient.birthDate ?? "",
    sex: patient.gender === "male" ? "M" : patient.gender === "female" ? "F" : "U",
    address1: address?.line?.join(" "),
    city: address?.city,
    state: address?.state,
    zip: address?.postalCode,
  });
}

export function claimProviderFromPractitioner(practitioner: Practitioner): ClaimMdProviderInput {
  const name = practitioner.name?.find((candidate) => candidate.use === "official") ?? practitioner.name?.[0];
  const telecom = (system: "phone" | "email" | "fax") => practitioner.telecom
    ?.find((candidate) => candidate.system === system && candidate.value?.trim())
    ?.value?.trim();
  return cleanProvider({
    npi: practitioner.identifier
      ?.find((identifier) => identifier.system === "http://hl7.org/fhir/sid/us-npi")
      ?.value ?? "",
    firstName: name?.given?.[0],
    lastName: name?.family,
    phone: telecom("phone"),
    email: telecom("email"),
    fax: telecom("fax"),
  });
}

export function latestFinishedEncounter(encounters: readonly Encounter[]): Encounter | undefined {
  return encounters
    .filter((encounter) => encounter.status === "finished" && encounter.id)
    .sort((left, right) => (right.period?.start ?? "").localeCompare(left.period?.start ?? ""))[0];
}

export function claimPersonFromRelatedPerson(person: RelatedPerson): ClaimMdPersonInput {
  const name = person.name?.[0];
  const address = person.address?.[0];
  return cleanPerson({
    firstName: name?.given?.[0] ?? "",
    middleName: name?.given?.slice(1).join(" ") || undefined,
    lastName: name?.family ?? "",
    dateOfBirth: person.birthDate ?? "",
    sex: person.gender === "male" ? "M" : person.gender === "female" ? "F" : "U",
    address1: address?.line?.join(" "),
    city: address?.city,
    state: address?.state,
    zip: address?.postalCode,
  });
}

export function buildCoverageResource(input: CoverageEntryInput): Coverage {
  const groupNumber = input.groupNumber.trim();
  const groupName = input.groupName?.trim();
  const planName = input.planName?.trim();
  const subscriberReference = input.subscriberReference?.trim()
    || (input.relationship === "self" ? input.patientReference : "");
  return {
    resourceType: "Coverage",
    status: input.active === false ? "cancelled" : "active",
    subscriberId: input.memberId.trim(),
    identifier: [{ value: input.memberId.trim() }],
    beneficiary: { reference: input.patientReference },
    ...(subscriberReference ? { subscriber: { reference: subscriberReference } } : {}),
    relationship: {
      coding: [{
        system: input.relationshipSystem ?? SUBSCRIBER_RELATIONSHIP_SYSTEM,
        code: input.relationship,
        display: relationshipDisplay(input.relationship),
      }],
    },
    ...(input.coverageType ? { type: { text: coverageTypeDisplay(input.coverageType) } } : {}),
    payor: [{
      reference: input.payorReference.trim(),
      ...(input.payorDisplay?.trim() ? { display: input.payorDisplay.trim() } : {}),
      ...(input.payerId?.trim() ? { identifier: { value: input.payerId.trim() } } : {}),
    }],
    class: [
      ...(groupNumber || groupName ? [{
        type: { coding: [{ code: "group", display: "Group" }] },
        value: groupNumber,
        ...(groupName ? { name: groupName } : {}),
      }] : []),
      ...(planName ? [{
        type: { coding: [{ code: "plan", display: "Plan" }] },
        value: planName,
        name: planName,
      }] : []),
    ],
    period: {
      start: input.effectiveDate,
      ...(input.endDate ? { end: input.endDate } : {}),
    },
    ...(input.primary !== undefined ? { order: input.primary ? 1 : 2 } : {}),
  };
}

export function coverageMemberId(coverage: Coverage): string {
  return coverage.subscriberId ?? coverage.identifier?.find((identifier) => identifier.value)?.value ?? "";
}

export function coverageGroupNumber(coverage: Coverage): string {
  return coverage.class?.find((entry) =>
    entry.type.coding?.some((coding) => coding.code === "group") || entry.type.text?.toLowerCase() === "group"
  )?.value ?? "";
}

export function coverageGroupName(coverage: Coverage): string {
  return coverage.class?.find((entry) =>
    entry.type.coding?.some((coding) => coding.code === "group") || entry.type.text?.toLowerCase() === "group"
  )?.name ?? "";
}

export function coveragePlanName(coverage: Coverage): string {
  const plan = coverage.class?.find((entry) =>
    entry.type.coding?.some((coding) => coding.code === "plan") || entry.type.text?.toLowerCase() === "plan"
  );
  return plan?.name ?? plan?.value ?? "";
}

export function coveragePayerId(coverage: Coverage): string {
  return coverage.payor[0]?.identifier?.value ?? "";
}

export function coverageRelationship(coverage: Coverage): SubscriberRelationship {
  const code = coverage.relationship?.coding?.find((coding) => coding.code)?.code
    ?? coverage.relationship?.text?.toLowerCase();
  return isSubscriberRelationship(code) ? code : "other";
}

export function coverageType(coverage: Coverage): "medical" | "vision" | "" {
  const value = coverage.type?.coding?.find((coding) => coding.code)?.code
    ?? coverage.type?.text?.toLowerCase();
  return value === "medical" || value === "vision" ? value : "";
}

export function coverageIsSelf(coverage: Coverage): boolean {
  if (coverage.relationship?.coding?.some((coding) => coding.code === "self")) return true;
  if (coverage.relationship?.text?.toLowerCase() === "self") return true;
  return Boolean(
    coverage.subscriber?.reference
      && coverage.subscriber.reference === coverage.beneficiary.reference,
  );
}

export function coverageRelationshipCode(coverage: Coverage): string {
  const relationship = coverageRelationship(coverage);
  if (relationship === "self") return "18";
  if (relationship === "spouse") return "01";
  if (relationship === "child") return "19";
  if (relationship === "common") return "53";
  return "G8";
}

export function subscriberFromCoverage(
  coverage: Coverage,
  patient: Patient,
  relatedPerson?: RelatedPerson,
): ClaimMdPersonInput {
  const policy = {
    memberId: coverageMemberId(coverage) || undefined,
    groupNumber: coverageGroupNumber(coverage) || undefined,
    relationshipCode: coverageRelationshipCode(coverage),
  };
  if (coverageIsSelf(coverage)) {
    return cleanPerson({ ...claimPersonFromPatient(patient), ...policy });
  }
  return cleanPerson({ ...(relatedPerson ? claimPersonFromRelatedPerson(relatedPerson) : emptyPerson()), ...policy });
}

export interface SubscriberResolution {
  subscriber: ClaimMdPersonInput;
  error?: string;
}

export async function resolveSubscriberFromCoverage(
  coverage: Coverage,
  patient: Patient,
  readRelatedPerson: (id: string) => Promise<RelatedPerson>,
): Promise<SubscriberResolution> {
  if (coverageIsSelf(coverage)) {
    return { subscriber: subscriberFromCoverage(coverage, patient) };
  }
  const match = coverage.subscriber?.reference?.match(/^RelatedPerson\/([^/]+)$/);
  if (!match) {
    return {
      subscriber: subscriberFromCoverage(coverage, patient),
      error: "The selected non-self Coverage does not reference a valid RelatedPerson subscriber. Enter subscriber demographics manually or repair the Coverage record.",
    };
  }
  try {
    const relatedPerson = await readRelatedPerson(match[1]);
    return { subscriber: subscriberFromCoverage(coverage, patient, relatedPerson) };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      subscriber: subscriberFromCoverage(coverage, patient),
      error: `Unable to load the selected Coverage subscriber: ${detail}. Enter subscriber demographics manually or repair the Coverage record.`,
    };
  }
}

export function coverageLabel(coverage: Coverage): string {
  const payor = coverage.payor[0];
  const member = coverageMemberId(coverage);
  const group = coverageGroupNumber(coverage);
  return [payor?.display ?? payor?.reference ?? "Unknown payor", member && `Member ${member}`, group && `Group ${group}`]
    .filter(Boolean)
    .join(" · ");
}

function isSubscriberRelationship(value: string | undefined): value is SubscriberRelationship {
  return value === "child" || value === "parent" || value === "spouse" || value === "common"
    || value === "other" || value === "self" || value === "injured";
}

function relationshipDisplay(value: SubscriberRelationship): string {
  return value === "common" ? "Common law spouse" : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function coverageTypeDisplay(value: "medical" | "vision"): string {
  return value === "medical" ? "Medical" : "Vision";
}

export function dollarsToCents(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Fee must be a nonnegative dollar amount with at most two decimal places.");
  }
  const [dollars, fractional = ""] = normalized.split(".");
  return Number(dollars) * 100 + Number(fractional.padEnd(2, "0"));
}

export function validateClaimDraft(draft: ClaimDraft): string[] {
  const errors: string[] = [];
  if (!draft.patientReference) errors.push("Select a patient.");
  if (!draft.providerReference.trim()) errors.push("FHIR provider reference is required.");
  if (!draft.coverageReference) errors.push("Select a Coverage.");
  if (!draft.insurerReference.trim()) errors.push("The selected Coverage needs a payor Organization reference.");
  if (!draft.created) errors.push("Created date is required.");
  if (!draft.serviceDate) errors.push("Service date is required.");
  if (!draft.patientAccountNumber.trim()) errors.push("Patient account number is required.");
  if (!draft.payerId.trim()) errors.push("Payer ID is required.");
  if (!draft.billingProvider.npi.trim()) errors.push("Billing provider NPI is required.");
  if (![draft.billingProvider.phone, draft.billingProvider.email, draft.billingProvider.fax]
    .some((value) => value?.trim())) {
    errors.push("Billing provider phone, email, or fax is required.");
  }
  if (!draft.renderingProvider.npi.trim()) errors.push("Rendering provider NPI is required.");
  if (!draft.renderingProvider.lastName?.trim() && !draft.renderingProvider.name?.trim()) {
    errors.push("Rendering provider last name or organization name is required.");
  }
  requirePerson(draft.patient, "Patient", errors);
  const subscriber = subscriberForClaim(draft);
  if (draft.subscriberIsPatient) {
    requireAddress(draft.patient, "Patient", errors);
  } else {
    requirePerson(subscriber, "Subscriber", errors);
    requireAddress(subscriber, "Subscriber", errors);
  }
  if (!subscriber.relationshipCode?.trim()) errors.push("Subscriber relationship code is required.");
  if (draft.diagnoses.length === 0) errors.push("At least one diagnosis is required.");
  draft.diagnoses.forEach((diagnosis, index) => {
    if (!diagnosis.code.trim()) errors.push(`Diagnosis ${index + 1} code is required.`);
  });
  if (draft.charges.length === 0) errors.push("At least one charge is required.");
  draft.charges.forEach((charge, index) => {
    if (!charge.code.trim()) errors.push(`Charge ${index + 1} code is required.`);
    try {
      dollarsToCents(charge.feeDollars);
    } catch {
      errors.push(`Charge ${index + 1} fee must be a nonnegative dollar amount with at most two decimal places.`);
    }
    const quantity = Number(charge.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) errors.push(`Charge ${index + 1} quantity must be a positive whole number.`);
    const sequence = charge.diagnosisSequence;
    if (sequence?.length === 0) {
      errors.push(`Charge ${index + 1} must include at least one diagnosis pointer.`);
    } else if (sequence && sequence.length > 4) {
      errors.push(`Charge ${index + 1} may include no more than four diagnosis pointers.`);
    } else if (sequence?.some((value) =>
      !Number.isInteger(value) || value < 1 || value > Math.min(draft.diagnoses.length, 12)
    )) {
      errors.push(`Charge ${index + 1} diagnosis pointers must use positions 1 through ${Math.min(draft.diagnoses.length, 12)}.`);
    } else if (sequence && new Set(sequence).size !== sequence.length) {
      errors.push(`Charge ${index + 1} diagnosis pointers must reference unique diagnoses on this claim.`);
    }
  });
  return errors;
}

export function buildProfessionalClaimInput(draft: ClaimDraft): ProfessionalClaimInput {
  const errors = validateClaimDraft(draft);
  if (errors.length) throw new Error(errors.join(" "));
  return {
    created: draft.created,
    serviceDate: draft.serviceDate,
    patientReference: draft.patientReference,
    providerReference: draft.providerReference.trim(),
    insurerReference: draft.insurerReference.trim(),
    coverageReference: draft.coverageReference,
    patientAccountNumber: draft.patientAccountNumber.trim(),
    payerId: draft.payerId.trim(),
    billingProvider: cleanProvider(draft.billingProvider),
    renderingProvider: cleanProvider(draft.renderingProvider),
    subscriber: subscriberForClaim(draft),
    patient: cleanPerson(draft.patient),
    diagnoses: draft.diagnoses.map((diagnosis) => ({
      system: diagnosis.system ?? ICD10_CM_SYSTEM,
      code: diagnosis.code.trim(),
      ...(diagnosis.description.trim() ? { display: diagnosis.description.trim() } : {}),
    })),
    chargeItems: draft.charges.map((charge): ProfessionalClaimChargeItemInput => {
      const feeCents = dollarsToCents(charge.feeDollars);
      return {
        resourceType: "ChargeItem",
        ...(charge.id ? { id: charge.id } : {}),
        status: "billable",
        code: {
          coding: [{
            system: charge.codeSystem ?? (charge.codeType === "CPT" ? CPT_SYSTEM : HCPCS_SYSTEM),
            code: charge.code.trim(),
            ...(charge.description.trim() ? { display: charge.description.trim() } : {}),
          }],
        },
        subject: { reference: draft.patientReference },
        quantity: { value: Number(charge.quantity) },
        priceOverride: { value: feeCents / 100, currency: "USD" },
        ...(charge.diagnosisSequence ? { diagnosisSequence: charge.diagnosisSequence } : {}),
        ...(charge.laterality ? { laterality: charge.laterality } : {}),
        ...(charge.modifierExtension ? { modifierExtension: charge.modifierExtension } : {}),
      };
    }),
  };
}

export function claimDraftFromProfessionalClaimInput(
  input: ProfessionalClaimInput,
  created: string,
): ClaimDraft {
  return {
    created,
    serviceDate: input.serviceDate,
    patientReference: input.patientReference,
    providerReference: input.providerReference,
    insurerReference: input.insurerReference,
    coverageReference: input.coverageReference,
    patientAccountNumber: "",
    payerId: input.payerId,
    billingProvider: structuredClone(input.billingProvider),
    renderingProvider: structuredClone(input.renderingProvider),
    subscriber: structuredClone(input.subscriber),
    patient: structuredClone(input.patient),
    diagnoses: input.diagnoses.map((diagnosis) => ({
      system: diagnosis.system,
      code: diagnosis.code,
      description: diagnosis.display ?? "",
    })),
    charges: input.chargeItems.map((chargeItem) => {
      const coding = chargeItem.code.coding?.[0];
      return {
        codeType: coding?.system === CPT_SYSTEM ? "CPT" : "HCPCS",
        ...(coding?.system ? { codeSystem: coding.system } : {}),
        code: coding?.code ?? "",
        description: coding?.display ?? chargeItem.code.text ?? "",
        feeDollars: Number(chargeItem.priceOverride?.value ?? 0).toFixed(2),
        quantity: String(chargeItem.quantity?.value ?? 1),
        ...(chargeItem.diagnosisSequence ? { diagnosisSequence: [...chargeItem.diagnosisSequence] } : {}),
        ...(chargeItem.laterality ? { laterality: chargeItem.laterality } : {}),
        ...(chargeItem.modifierExtension ? { modifierExtension: structuredClone(chargeItem.modifierExtension) } : {}),
      };
    }),
  };
}

export function subscriberForClaim(draft: ClaimDraft): ClaimMdPersonInput {
  if (!draft.subscriberIsPatient) return cleanPerson(draft.subscriber);
  return cleanPerson({
    ...draft.patient,
    memberId: draft.subscriber.memberId,
    groupNumber: draft.subscriber.groupNumber,
    relationshipCode: draft.subscriber.relationshipCode,
  });
}

export async function loadEncounterClaimDraft(
  encounterId: string,
  options: ClaimsApiOptions = {},
): Promise<EncounterClaimDraft> {
  const query = new URLSearchParams({ encounterId });
  const response = await (options.fetchImpl ?? fetch)(
    `${(options.baseUrl ?? "").replace(/\/$/, "")}/claims/draft?${query}`,
    {
      headers: {
        Accept: "application/json",
        ...(options.authorization ? { Authorization: options.authorization } : {}),
      },
    },
  );
  const text = await response.text();
  const body = parseJsonBody<EncounterClaimDraft & { error?: string }>(text);
  if (!response.ok) {
    throw new Error(body?.error ?? `Claim draft load failed with HTTP ${response.status}.`);
  }
  if (!body) throw new Error("Claim draft response was not valid JSON.");
  return body;
}

export async function submitProfessionalClaim(
  claim: ProfessionalClaimInput,
  options: ClaimsApiOptions = {},
): Promise<SubmitClaimResult> {
  const response = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? "").replace(/\/$/, "")}/claims/submit`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
    },
    body: JSON.stringify({ claim, ...(options.clearinghouse ? { clearinghouse: options.clearinghouse } : {}) }),
  });
  const text = await response.text();
  const body = parseJsonBody<SubmitClaimResult & { error?: string }>(text);
  if (!response.ok) {
    throw new Error(body?.error ?? `Claim submission failed with HTTP ${response.status}.`);
  }
  if (!body) throw new Error("Claim submission response was not valid JSON.");
  return body;
}

export async function previewStediClaimResubmission(
  input: Omit<StediClaimResubmissionInput, "patientControlNumber" | "revisedClaim">,
  options: ClaimsApiOptions = {},
): Promise<StediClaimResubmissionPreview> {
  return postClaimJson<StediClaimResubmissionPreview>("/claims/resubmission/preview", input, options);
}

export async function submitStediClaimResubmission(
  input: StediClaimResubmissionInput,
  options: ClaimsApiOptions = {},
): Promise<SubmitClaimResult & {
  originalClaimReference?: string;
  intent?: StediClaimResubmissionIntent;
  claimFrequencyCode?: "1" | "7" | "8";
  claimControlNumber?: string;
}> {
  return postClaimJson("/claims/resubmission", input, options);
}

async function postClaimJson<T>(path: string, bodyValue: unknown, options: ClaimsApiOptions): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? "").replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
    },
    body: JSON.stringify(bodyValue),
  });
  const text = await response.text();
  const body = parseJsonBody<T & { error?: string }>(text);
  if (!response.ok) throw new Error(body?.error ?? `Claim resubmission failed with HTTP ${response.status}.`);
  if (!body) throw new Error("Claim resubmission response was not valid JSON.");
  return body;
}

function parseJsonBody<T>(text: string): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function requirePerson(person: ClaimMdPersonInput, label: string, errors: string[]): void {
  if (!person.firstName.trim()) errors.push(`${label} first name is required.`);
  if (!person.lastName.trim()) errors.push(`${label} last name is required.`);
  if (!person.dateOfBirth) errors.push(`${label} date of birth is required.`);
}

function requireAddress(person: ClaimMdPersonInput, label: string, errors: string[]): void {
  if (!person.address1?.trim()) errors.push(`${label} address is required.`);
  if (!person.city?.trim()) errors.push(`${label} city is required.`);
  if (!person.state?.trim()) errors.push(`${label} state is required.`);
  if (!person.zip?.trim()) errors.push(`${label} ZIP is required.`);
}

function cleanProvider(provider: ClaimMdProviderInput): ClaimMdProviderInput {
  const { npi, ...optional } = provider;
  return { npi: npi.trim(), ...cleanObject(optional) };
}

function cleanPerson(person: ClaimMdPersonInput): ClaimMdPersonInput {
  const { firstName, lastName, dateOfBirth, sex, ...optional } = person;
  return {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    dateOfBirth,
    sex,
    ...cleanObject(optional),
  };
}

function cleanObject<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, candidate]) => candidate !== undefined && candidate !== ""),
  ) as T;
}
