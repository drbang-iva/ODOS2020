import type {
  Bundle,
  BundleEntry,
  Coverage,
  CoverageEligibilityRequest,
  CoverageEligibilityResponse,
  CoverageEligibilityResponseInsuranceItem,
  Patient,
  RelatedPerson,
  Resource,
} from "@medplum/fhirtypes";
import {
  buildCoverageResource,
  coverageGroupName,
  coverageGroupNumber,
  coverageMemberId,
  coveragePayerId,
  coveragePlanName,
  coverageRelationship,
  coverageType,
  SUBSCRIBER_RELATIONSHIP_SYSTEM,
  type ClaimsApiOptions,
  type SubscriberRelationship,
} from "./submit-claims";

export const OSOD_BENEFIT_LAST_USED_EXTENSION_URL = "https://osod.dev/fhir/StructureDefinition/osod-benefit-last-used";
export const OSOD_BENEFIT_FREQUENCY_MONTHS_EXTENSION_URL = "https://osod.dev/fhir/StructureDefinition/osod-benefit-frequency-months";

export const SUBSCRIBER_RELATIONSHIPS: ReadonlyArray<{ value: SubscriberRelationship; label: string }> = [
  { value: "self", label: "Self" },
  { value: "child", label: "Child" },
  { value: "parent", label: "Parent" },
  { value: "spouse", label: "Spouse" },
  { value: "common", label: "Common law spouse" },
  { value: "injured", label: "Injured party" },
  { value: "other", label: "Other" },
];

export const BENEFIT_KINDS = ["medical", "exam", "frame", "lens", "contacts", "contact-exam"] as const;
export type BenefitKind = typeof BENEFIT_KINDS[number];
export type BenefitStatus = "Does not Exist" | "Authorized" | "Authorization Expired" | "Used" | "Eligibility Active" | "Eligibility Expired";

export interface SubscriberDemographics {
  firstName: string;
  middleName: string;
  lastName: string;
  birthDate: string;
  gender: "male" | "female" | "other" | "unknown";
  address: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface CoverageEditorDraft {
  coverageId?: string;
  patientReference: string;
  carrierReference: string;
  carrierName: string;
  payerId: string;
  planName: string;
  coverageType: "medical" | "vision";
  memberId: string;
  relationship: SubscriberRelationship;
  subscriberReference: string;
  groupNumber: string;
  groupName: string;
  effectiveDate: string;
  endDate: string;
  primary: boolean;
  active: boolean;
  subscriber: SubscriberDemographics;
}

export interface InsuranceScreenData {
  coverages: Coverage[];
  relatedPeople: RelatedPerson[];
}

export interface BenefitEntryDraft {
  kind: BenefitKind;
  excluded: boolean;
  allowanceDollars: string;
  usedDollars: string;
  copayDollars: string;
  lastUsed: string;
  frequencyMonths: string;
}

export interface ManualBenefitsDraft {
  patientReference: string;
  coverageReference: string;
  insurerReference: string;
  effectiveDate: string;
  endDate: string;
  eligibilityActive: boolean;
  authorizationReference: string;
  benefits: BenefitEntryDraft[];
}

export interface VisionBenefitsData {
  responses: CoverageEligibilityResponse[];
}

export function emptyCoverageDraft(patientReference: string, today: string): CoverageEditorDraft {
  return {
    patientReference,
    carrierReference: "",
    carrierName: "",
    payerId: "",
    planName: "",
    coverageType: "vision",
    memberId: "",
    relationship: "self",
    subscriberReference: patientReference,
    groupNumber: "",
    groupName: "",
    effectiveDate: today,
    endDate: "",
    primary: false,
    active: true,
    subscriber: emptySubscriber(),
  };
}

export function coverageDraftFromResource(
  coverage: Coverage,
  patient: Patient,
  relatedPerson?: RelatedPerson,
): CoverageEditorDraft {
  const relationship = coverageRelationship(coverage);
  return {
    coverageId: coverage.id,
    patientReference: coverage.beneficiary.reference ?? `Patient/${patient.id ?? ""}`,
    carrierReference: coverage.payor[0]?.reference ?? "",
    carrierName: coverage.payor[0]?.display ?? "",
    payerId: coveragePayerId(coverage),
    planName: coveragePlanName(coverage),
    coverageType: coverageType(coverage) || "vision",
    memberId: coverageMemberId(coverage),
    relationship,
    subscriberReference: coverage.subscriber?.reference ?? (relationship === "self" ? coverage.beneficiary.reference ?? "" : ""),
    groupNumber: coverageGroupNumber(coverage),
    groupName: coverageGroupName(coverage),
    effectiveDate: coverage.period?.start ?? "",
    endDate: coverage.period?.end ?? "",
    primary: coverage.order === 1,
    active: coverage.status === "active",
    subscriber: relationship === "self" ? subscriberFromPatient(patient) : subscriberFromRelatedPerson(relatedPerson),
  };
}

export function validateCoverageDraft(draft: CoverageEditorDraft): string[] {
  const errors: string[] = [];
  if (!/^Patient\/[^/]+$/.test(draft.patientReference)) errors.push("A patient is required.");
  if (!/^Organization\/[^/]+$/.test(draft.carrierReference.trim())) errors.push("Carrier must be an Organization reference.");
  if (!draft.carrierName.trim()) errors.push("Carrier name is required.");
  if (!draft.memberId.trim()) errors.push("Insured ID is required.");
  if (!draft.effectiveDate) errors.push("Effective date is required.");
  if (draft.endDate && draft.endDate < draft.effectiveDate) errors.push("End date cannot precede the effective date.");
  if (draft.relationship !== "self" && hasSubscriberDemographics(draft.subscriber)) {
    if (!draft.subscriber.firstName.trim()) errors.push("Subscriber first name is required.");
    if (!draft.subscriber.lastName.trim()) errors.push("Subscriber last name is required.");
    if (!draft.subscriber.birthDate) errors.push("Subscriber birth date is required.");
  }
  return errors;
}

export function buildCoverageSaveBundle(input: {
  draft: CoverageEditorDraft;
  existingCoverage?: Coverage;
  existingRelatedPerson?: RelatedPerson;
  uuid?: () => string;
}): Bundle {
  const errors = validateCoverageDraft(input.draft);
  if (errors.length) throw new Error(errors.join(" "));
  const uuid = input.uuid ?? crypto.randomUUID.bind(crypto);
  const entries: BundleEntry[] = [];
  let subscriberReference = input.draft.relationship === "self" ? input.draft.patientReference : input.draft.subscriberReference;
  if (input.draft.relationship !== "self" && hasSubscriberDemographics(input.draft.subscriber)) {
    const relatedPerson = buildRelatedPersonResource(input.draft, input.existingRelatedPerson);
    if (input.existingRelatedPerson?.id) {
      subscriberReference = `RelatedPerson/${input.existingRelatedPerson.id}`;
      entries.push(updateEntry(relatedPerson));
    } else if (/^RelatedPerson\/[^/]+$/.test(input.draft.subscriberReference)) {
      subscriberReference = input.draft.subscriberReference;
      const id = input.draft.subscriberReference.split("/")[1];
      entries.push(updateEntry({ ...relatedPerson, id }));
    } else {
      const fullUrl = `urn:uuid:${uuid()}`;
      subscriberReference = fullUrl;
      entries.push(createEntry(fullUrl, relatedPerson));
    }
  }
  const builtCoverage = buildCoverageResource({
    patientReference: input.draft.patientReference,
    payorReference: input.draft.carrierReference,
    payorDisplay: input.draft.carrierName,
    payerId: input.draft.payerId,
    planName: input.draft.planName,
    coverageType: input.draft.coverageType,
    memberId: input.draft.memberId,
    groupNumber: input.draft.groupNumber,
    groupName: input.draft.groupName,
    relationship: input.draft.relationship,
    subscriberReference,
    effectiveDate: input.draft.effectiveDate,
    endDate: input.draft.endDate,
    primary: input.draft.primary,
    active: input.draft.active,
  });
  const coverage = input.existingCoverage
    ? { ...input.existingCoverage, ...builtCoverage, id: input.existingCoverage.id, meta: input.existingCoverage.meta }
    : builtCoverage;
  entries.push(input.existingCoverage?.id ? updateEntry(coverage) : createEntry(`urn:uuid:${uuid()}`, coverage));
  return { resourceType: "Bundle", type: "transaction", entry: entries };
}

export function emptyManualBenefitsDraft(patientReference: string, coverage: Coverage, today: string): ManualBenefitsDraft {
  return {
    patientReference,
    coverageReference: `Coverage/${coverage.id ?? ""}`,
    insurerReference: coverage.payor[0]?.reference ?? "",
    effectiveDate: today,
    endDate: "",
    eligibilityActive: true,
    authorizationReference: "",
    benefits: BENEFIT_KINDS.map((kind) => ({
      kind,
      excluded: false,
      allowanceDollars: "",
      usedDollars: "",
      copayDollars: "",
      lastUsed: "",
      frequencyMonths: "",
    })),
  };
}

export function validateManualBenefitsDraft(draft: ManualBenefitsDraft): string[] {
  const errors: string[] = [];
  if (!/^Patient\/[^/]+$/.test(draft.patientReference)) errors.push("A patient is required.");
  if (!/^Coverage\/[^/]+$/.test(draft.coverageReference)) errors.push("A saved Coverage is required.");
  if (!/^Organization\/[^/]+$/.test(draft.insurerReference)) errors.push("The Coverage needs a carrier Organization reference.");
  if (!draft.effectiveDate) errors.push("Effective date is required.");
  if (draft.endDate && draft.endDate < draft.effectiveDate) errors.push("End date cannot precede the effective date.");
  for (const benefit of draft.benefits) {
    for (const [label, value] of [["allowance", benefit.allowanceDollars], ["used amount", benefit.usedDollars], ["copay", benefit.copayDollars]] as const) {
      if (value && !isMoney(value)) errors.push(`${benefitLabel(benefit.kind)} ${label} must be a nonnegative dollar amount.`);
    }
    if (benefit.frequencyMonths && (!/^\d+$/.test(benefit.frequencyMonths) || Number(benefit.frequencyMonths) < 1)) {
      errors.push(`${benefitLabel(benefit.kind)} frequency must be a positive whole number of months.`);
    }
  }
  return errors;
}

export function buildManualBenefitsBundle(draft: ManualBenefitsDraft, input: { created: string; staffReference?: string; uuid?: () => string }): Bundle {
  const errors = validateManualBenefitsDraft(draft);
  if (errors.length) throw new Error(errors.join(" "));
  const uuid = input.uuid ?? crypto.randomUUID.bind(crypto);
  const requestFullUrl = `urn:uuid:${uuid()}`;
  const responseFullUrl = `urn:uuid:${uuid()}`;
  const request: CoverageEligibilityRequest = {
    resourceType: "CoverageEligibilityRequest",
    status: "active",
    purpose: ["benefits", "validation", "auth-requirements"],
    patient: { reference: draft.patientReference },
    servicedDate: draft.effectiveDate,
    created: input.created,
    ...(input.staffReference ? { enterer: { reference: input.staffReference } } : {}),
    insurer: { reference: draft.insurerReference },
    insurance: [{ coverage: { reference: draft.coverageReference } }],
    item: draft.benefits.map((benefit) => ({ category: { text: benefitLabel(benefit.kind) } })),
  };
  const response: CoverageEligibilityResponse = {
    resourceType: "CoverageEligibilityResponse",
    status: "active",
    purpose: request.purpose,
    patient: { reference: draft.patientReference },
    servicedDate: draft.effectiveDate,
    created: input.created,
    request: { reference: requestFullUrl },
    outcome: "complete",
    insurer: { reference: draft.insurerReference },
    ...(draft.authorizationReference.trim() ? { preAuthRef: draft.authorizationReference.trim() } : {}),
    insurance: [{
      coverage: { reference: draft.coverageReference },
      inforce: draft.eligibilityActive,
      benefitPeriod: {
        start: draft.effectiveDate,
        ...(draft.endDate ? { end: draft.endDate } : {}),
      },
      item: draft.benefits.map(buildBenefitItem),
    }],
  };
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [createEntry(requestFullUrl, request), createEntry(responseFullUrl, response)],
  };
}

export function deriveBenefitStatus(
  response: CoverageEligibilityResponse,
  item: CoverageEligibilityResponseInsuranceItem | undefined,
  today: string,
): BenefitStatus {
  if (!item || item.excluded) return "Does not Exist";
  const insurance = response.insurance?.[0];
  if (benefitUsedDollars(item) > 0 || benefitLastUsed(item)) return "Used";
  if (response.preAuthRef) {
    return insurance?.benefitPeriod?.end && insurance.benefitPeriod.end < today
      ? "Authorization Expired"
      : "Authorized";
  }
  if (insurance?.inforce && (!insurance.benefitPeriod?.end || insurance.benefitPeriod.end >= today)) {
    return "Eligibility Active";
  }
  return "Eligibility Expired";
}

export function benefitItem(response: CoverageEligibilityResponse, kind: BenefitKind): CoverageEligibilityResponseInsuranceItem | undefined {
  return response.insurance?.[0]?.item?.find((item) => normalizedBenefitKind(item) === kind);
}

export function benefitAllowanceDollars(item: CoverageEligibilityResponseInsuranceItem | undefined): number {
  return moneyBenefit(item, "allowance", "allowedMoney");
}

export function benefitCopayDollars(item: CoverageEligibilityResponseInsuranceItem | undefined): number {
  return moneyBenefit(item, "copay", "allowedMoney");
}

export function benefitUsedDollars(item: CoverageEligibilityResponseInsuranceItem | undefined): number {
  return moneyBenefit(item, "allowance", "usedMoney");
}

export function benefitLastUsed(item: CoverageEligibilityResponseInsuranceItem | undefined): string {
  return item?.extension?.find((extension) => extension.url === OSOD_BENEFIT_LAST_USED_EXTENSION_URL)?.valueDate ?? "";
}

export function benefitFrequencyMonths(item: CoverageEligibilityResponseInsuranceItem | undefined): number | undefined {
  return item?.extension?.find((extension) => extension.url === OSOD_BENEFIT_FREQUENCY_MONTHS_EXTENSION_URL)?.valueUnsignedInt;
}

export function nextEligibleDate(item: CoverageEligibilityResponseInsuranceItem | undefined): string {
  const lastUsed = benefitLastUsed(item);
  const months = benefitFrequencyMonths(item);
  if (!lastUsed || !months) return "";
  const [year, month, day] = lastUsed.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, day));
  return date.toISOString().slice(0, 10);
}

export function latestBenefitsByCoverage(responses: readonly CoverageEligibilityResponse[]): Map<string, CoverageEligibilityResponse> {
  const sorted = [...responses].sort((left, right) => right.created.localeCompare(left.created));
  const latest = new Map<string, CoverageEligibilityResponse>();
  for (const response of sorted) {
    const reference = response.insurance?.[0]?.coverage.reference;
    if (reference && !latest.has(reference)) latest.set(reference, response);
  }
  return latest;
}

export async function fetchPatientInsurance(patientReference: string, options: ClaimsApiOptions = {}): Promise<InsuranceScreenData> {
  return api<InsuranceScreenData>(`/insurance/coverages?patientReference=${encodeURIComponent(patientReference)}`, { method: "GET" }, options);
}

export async function savePatientInsurance(bundle: Bundle, options: ClaimsApiOptions = {}): Promise<Bundle> {
  return api<Bundle>("/insurance/coverages", { method: "POST", body: JSON.stringify({ bundle }) }, options);
}

export async function fetchVisionBenefits(patientReference: string, options: ClaimsApiOptions = {}): Promise<VisionBenefitsData> {
  return api<VisionBenefitsData>(`/insurance/vision-benefits?patientReference=${encodeURIComponent(patientReference)}`, { method: "GET" }, options);
}

export async function saveVisionBenefits(bundle: Bundle, options: ClaimsApiOptions = {}): Promise<Bundle> {
  return api<Bundle>("/insurance/vision-benefits", { method: "POST", body: JSON.stringify({ bundle }) }, options);
}

function buildRelatedPersonResource(draft: CoverageEditorDraft, existing?: RelatedPerson): RelatedPerson {
  const subscriber = draft.subscriber;
  return {
    resourceType: "RelatedPerson",
    ...(existing ?? {}),
    ...(existing?.id ? { id: existing.id } : {}),
    active: draft.active,
    patient: { reference: draft.patientReference },
    relationship: [{ coding: [{
      system: SUBSCRIBER_RELATIONSHIP_SYSTEM,
      code: draft.relationship,
      display: SUBSCRIBER_RELATIONSHIPS.find((entry) => entry.value === draft.relationship)?.label,
    }] }],
    name: [{ given: [subscriber.firstName, subscriber.middleName].filter(Boolean), family: subscriber.lastName }],
    birthDate: subscriber.birthDate,
    gender: subscriber.gender,
    address: [{
      line: subscriber.address ? [subscriber.address] : undefined,
      city: subscriber.city || undefined,
      state: subscriber.state || undefined,
      postalCode: subscriber.postalCode || undefined,
    }],
  };
}

function buildBenefitItem(benefit: BenefitEntryDraft): CoverageEligibilityResponseInsuranceItem {
  const allowance = moneyOrUndefined(benefit.allowanceDollars);
  const used = moneyOrUndefined(benefit.usedDollars);
  const copay = moneyOrUndefined(benefit.copayDollars);
  return {
    category: { text: benefitLabel(benefit.kind) },
    name: benefitLabel(benefit.kind),
    excluded: benefit.excluded,
    extension: [
      ...(benefit.lastUsed ? [{ url: OSOD_BENEFIT_LAST_USED_EXTENSION_URL, valueDate: benefit.lastUsed }] : []),
      ...(benefit.frequencyMonths ? [{ url: OSOD_BENEFIT_FREQUENCY_MONTHS_EXTENSION_URL, valueUnsignedInt: Number(benefit.frequencyMonths) }] : []),
    ],
    benefit: [
      ...(allowance !== undefined || used !== undefined ? [{
        type: { text: "Allowance" },
        ...(allowance !== undefined ? { allowedMoney: { value: allowance, currency: "USD" as const } } : {}),
        ...(used !== undefined ? { usedMoney: { value: used, currency: "USD" as const } } : {}),
      }] : []),
      ...(copay !== undefined ? [{ type: { text: "Copay" }, allowedMoney: { value: copay, currency: "USD" as const } }] : []),
    ],
  };
}

function createEntry(fullUrl: string, resource: Resource): BundleEntry {
  return { fullUrl, resource, request: { method: "POST", url: resource.resourceType } };
}

function updateEntry(resource: Resource): BundleEntry {
  if (!resource.id) throw new Error(`${resource.resourceType} update requires an id.`);
  return {
    fullUrl: `${resource.resourceType}/${resource.id}`,
    resource,
    request: {
      method: "PUT",
      url: `${resource.resourceType}/${resource.id}`,
      ...(resource.meta?.versionId ? { ifMatch: `W/\"${resource.meta.versionId}\"` } : {}),
    },
  };
}

function subscriberFromPatient(patient: Patient): SubscriberDemographics {
  const name = patient.name?.find((candidate) => candidate.use === "official") ?? patient.name?.[0];
  const address = patient.address?.find((candidate) => candidate.use === "home") ?? patient.address?.[0];
  return {
    firstName: name?.given?.[0] ?? "",
    middleName: name?.given?.slice(1).join(" ") ?? "",
    lastName: name?.family ?? "",
    birthDate: patient.birthDate ?? "",
    gender: patient.gender ?? "unknown",
    address: address?.line?.join(" ") ?? "",
    city: address?.city ?? "",
    state: address?.state ?? "",
    postalCode: address?.postalCode ?? "",
  };
}

function subscriberFromRelatedPerson(person: RelatedPerson | undefined): SubscriberDemographics {
  if (!person) return emptySubscriber();
  const name = person.name?.[0];
  const address = person.address?.[0];
  return {
    firstName: name?.given?.[0] ?? "",
    middleName: name?.given?.slice(1).join(" ") ?? "",
    lastName: name?.family ?? "",
    birthDate: person.birthDate ?? "",
    gender: person.gender ?? "unknown",
    address: address?.line?.join(" ") ?? "",
    city: address?.city ?? "",
    state: address?.state ?? "",
    postalCode: address?.postalCode ?? "",
  };
}

function emptySubscriber(): SubscriberDemographics {
  return { firstName: "", middleName: "", lastName: "", birthDate: "", gender: "unknown", address: "", city: "", state: "", postalCode: "" };
}

function hasSubscriberDemographics(subscriber: SubscriberDemographics): boolean {
  return Object.values(subscriber).some((value) => value && value !== "unknown");
}

function normalizedBenefitKind(item: CoverageEligibilityResponseInsuranceItem): BenefitKind | undefined {
  const value = (item.category?.text ?? item.name ?? "").toLowerCase().replaceAll(" ", "-");
  return BENEFIT_KINDS.find((kind) => kind === value);
}

function benefitLabel(kind: BenefitKind): string {
  if (kind === "contact-exam") return "Contact Exam";
  return `${kind[0].toUpperCase()}${kind.slice(1)}`;
}

function moneyBenefit(item: CoverageEligibilityResponseInsuranceItem | undefined, type: string, field: "allowedMoney" | "usedMoney"): number {
  const benefit = item?.benefit?.find((entry) => entry.type.text?.toLowerCase() === type);
  return benefit?.[field]?.value ?? 0;
}

function moneyOrUndefined(value: string): number | undefined {
  return value ? Number(value) : undefined;
}

function isMoney(value: string): boolean {
  return /^\d+(?:\.\d{1,2})?$/.test(value);
}

async function api<T>(path: string, init: RequestInit, options: ClaimsApiOptions): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? "").replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(options.authorization ? { Authorization: options.authorization } : {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Insurance request failed with HTTP ${response.status}.`);
  return body;
}
