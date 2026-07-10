import type { ChargeItem, Coverage, Patient } from "@medplum/fhirtypes";

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
  chargeItems: ChargeItem[];
  facilityReference?: string;
}

export interface DiagnosisLine {
  code: string;
  description: string;
}

export interface ChargeLine {
  codeType: "CPT" | "HCPCS";
  code: string;
  description: string;
  feeDollars: string;
  quantity: string;
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
  patient: ClaimMdPersonInput;
  diagnoses: DiagnosisLine[];
  charges: ChargeLine[];
}

export interface CoverageEntryInput {
  patientReference: string;
  payorReference: string;
  payorDisplay?: string;
  memberId: string;
  groupNumber: string;
  relationship: "self" | "other";
  effectiveDate: string;
}

export interface ClaimsApiOptions {
  authorization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SubmitClaimResult {
  claimId?: string;
  claimMdClaimId?: string;
  claimMdTrackingNumber?: string;
  status?: string;
}

export function emptyProvider(): ClaimMdProviderInput {
  return { npi: "" };
}

export function emptyPerson(): ClaimMdPersonInput {
  return { firstName: "", lastName: "", dateOfBirth: "", sex: "U" };
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

export function buildCoverageResource(input: CoverageEntryInput): Coverage {
  return {
    resourceType: "Coverage",
    status: "active",
    subscriberId: input.memberId.trim(),
    identifier: [{ value: input.memberId.trim() }],
    beneficiary: { reference: input.patientReference },
    ...(input.relationship === "self" ? { subscriber: { reference: input.patientReference } } : {}),
    relationship: {
      coding: [{
        code: input.relationship,
        display: input.relationship === "self" ? "Self" : "Other",
      }],
    },
    payor: [{
      reference: input.payorReference.trim(),
      ...(input.payorDisplay?.trim() ? { display: input.payorDisplay.trim() } : {}),
    }],
    class: [{ type: { coding: [{ code: "group", display: "Group" }] }, value: input.groupNumber.trim() }],
    period: { start: input.effectiveDate },
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

export function coverageIsSelf(coverage: Coverage): boolean {
  if (coverage.relationship?.coding?.some((coding) => coding.code === "self")) return true;
  if (coverage.relationship?.text?.toLowerCase() === "self") return true;
  return Boolean(
    coverage.subscriber?.reference
      && coverage.subscriber.reference === coverage.beneficiary.reference,
  );
}

export function subscriberFromCoverage(coverage: Coverage, patient: Patient): ClaimMdPersonInput {
  const policy = {
    memberId: coverageMemberId(coverage) || undefined,
    groupNumber: coverageGroupNumber(coverage) || undefined,
  };
  if (coverageIsSelf(coverage)) {
    return cleanPerson({ ...claimPersonFromPatient(patient), ...policy, relationshipCode: "18" });
  }
  return cleanPerson({ ...emptyPerson(), ...policy, relationshipCode: "" });
}

export function coverageLabel(coverage: Coverage): string {
  const payor = coverage.payor[0];
  const member = coverageMemberId(coverage);
  const group = coverageGroupNumber(coverage);
  return [payor?.display ?? payor?.reference ?? "Unknown payor", member && `Member ${member}`, group && `Group ${group}`]
    .filter(Boolean)
    .join(" · ");
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
  if (!draft.renderingProvider.npi.trim()) errors.push("Rendering provider NPI is required.");
  requirePerson(draft.patient, "Patient", errors);
  requirePerson(draft.subscriber, "Subscriber", errors);
  if (!draft.subscriber.relationshipCode?.trim()) errors.push("Subscriber relationship code is required.");
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
    subscriber: cleanPerson(draft.subscriber),
    patient: cleanPerson(draft.patient),
    diagnoses: draft.diagnoses.map((diagnosis) => ({
      system: ICD10_CM_SYSTEM,
      code: diagnosis.code.trim(),
      ...(diagnosis.description.trim() ? { display: diagnosis.description.trim() } : {}),
    })),
    chargeItems: draft.charges.map((charge): ChargeItem => {
      const feeCents = dollarsToCents(charge.feeDollars);
      return {
        resourceType: "ChargeItem",
        status: "billable",
        code: {
          coding: [{
            system: charge.codeType === "CPT" ? CPT_SYSTEM : HCPCS_SYSTEM,
            code: charge.code.trim(),
            ...(charge.description.trim() ? { display: charge.description.trim() } : {}),
          }],
        },
        subject: { reference: draft.patientReference },
        quantity: { value: Number(charge.quantity) },
        priceOverride: { value: feeCents / 100, currency: "USD" },
      };
    }),
  };
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
    body: JSON.stringify({ claim }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as SubmitClaimResult & { error?: string } : {};
  if (!response.ok) {
    throw new Error(body.error ?? `Claim submission failed with HTTP ${response.status}.`);
  }
  return body;
}

function requirePerson(person: ClaimMdPersonInput, label: string, errors: string[]): void {
  if (!person.firstName.trim()) errors.push(`${label} first name is required.`);
  if (!person.lastName.trim()) errors.push(`${label} last name is required.`);
  if (!person.dateOfBirth) errors.push(`${label} date of birth is required.`);
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
