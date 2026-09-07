import type {
  ChargeItem,
  Claim,
  ClaimResponse,
  CodeableConcept,
  CoverageEligibilityRequest,
  CoverageEligibilityResponse,
  Extension,
  Money,
} from "@medplum/fhirtypes";
import { chargeItemLaterality } from "../fhir/charge-item-laterality.js";

export const HL7_CLAIM_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/claim-type";
export const ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-charge-item";
export const ODOS_CLAIM_LINE_CONTROL_NUMBER_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-claim-line-control-number";

export function claimLineControlNumber(item: NonNullable<Claim["item"]>[number] | undefined): string | undefined {
  return item?.extension?.find((extension) =>
    extension.url === ODOS_CLAIM_LINE_CONTROL_NUMBER_EXTENSION_URL)?.valueString;
}

export function claimLineChargeItemReference(
  claim: Claim,
  lineControlNumber: string | undefined,
): string | undefined {
  if (!lineControlNumber) return undefined;
  const matches = (claim.item ?? []).filter((item) => claimLineControlNumber(item) === lineControlNumber);
  if (matches.length !== 1) return undefined;
  const references = matches[0].extension?.flatMap((extension) =>
    extension.url === ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL
    && /^ChargeItem\/[A-Za-z0-9.-]{1,64}$/.test(extension.valueReference?.reference ?? "")
      ? [extension.valueReference!.reference!]
      : [],
  ) ?? [];
  return references.length === 1 ? references[0] : undefined;
}

export function claimResponseChargeItemExtension(chargeItemId: string | undefined): Extension | undefined {
  return chargeItemId && /^[A-Za-z0-9.-]{1,64}$/.test(chargeItemId)
    ? {
        url: ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
        valueReference: { reference: `ChargeItem/${chargeItemId}` },
      }
    : undefined;
}

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

export interface ClaimMdProfessionalClaimPayload {
  fileid: string;
  claim: ClaimMdProfessionalClaim[];
}

export interface ClaimMdProfessionalClaim {
  claim_form: "1500";
  payerid: string;
  pcn: string;
  total_charge: string;
  balance_due: string;
  remote_claimid: string;
  remote_fileid: string;
  charge: ClaimMdProfessionalCharge[];
  [key: string]: string | ClaimMdProfessionalCharge[];
}

export interface ClaimMdProfessionalCharge {
  charge_record_type: "UN";
  proc_code: string;
  charge: string;
  units: string;
  from_date: string;
  thru_date: string;
  diag_ref: string;
  remote_chgid?: string;
  mod1?: string;
  mod2?: string;
  mod3?: string;
  mod4?: string;
}

export interface ClaimMdEraAdjustment {
  group?: string;
  code?: string;
  amount?: string;
}

export interface ClaimMdEraCharge {
  chgid?: string;
  remote_chgid?: string;
  proc_code?: string;
  charge?: string;
  allowed?: string;
  paid?: string;
  adjustment?: ClaimMdEraAdjustment | ClaimMdEraAdjustment[];
}

export interface ClaimMdEraClaim {
  pcn?: string;
  payer_icn?: string;
  total_charge?: string;
  total_paid?: string;
  status_code?: string;
  charge?: ClaimMdEraCharge | ClaimMdEraCharge[];
}

export interface ClaimMdEraData {
  eraid?: string;
  paid_date?: string;
  payer_name?: string;
  payment_method?: string;
  claim?: ClaimMdEraClaim | ClaimMdEraClaim[];
}

export interface ManualClaimResponseLineInput {
  itemSequence: number;
  submittedCents: number;
  allowedCents: number;
  paidCents: number;
  deductibleCents: number;
  coinsuranceCents: number;
  copayCents: number;
}

export interface MedicalEligibilitySummary {
  coverageStatus: "active" | "inactive" | "unknown";
  deductibleRemainingCents?: number;
  copayCents?: number;
  coinsurancePercent?: number;
  priorAuthRequired: boolean;
}

type CoverageEligibilityItem = NonNullable<
  NonNullable<CoverageEligibilityResponse["insurance"]>[number]["item"]
>[number];

export function buildProfessionalClaim(input: ProfessionalClaimInput): Claim {
  if (!input.patientReference || !input.providerReference || !input.coverageReference) {
    throw new Error("A professional Claim requires patient, provider, and coverage references.");
  }
  if (!input.diagnoses.length) {
    throw new Error("A professional Claim requires at least one diagnosis supplied by the caller.");
  }
  if (!input.chargeItems.length) {
    throw new Error("A professional Claim requires at least one billable ChargeItem.");
  }

  const items = input.chargeItems.map((chargeItem, index) => {
    if (!chargeItem.id) {
      throw new Error("Every professional Claim charge item must be persisted before the Claim is built.");
    }
    const coding = firstCoding(chargeItem);
    const quantity = chargeItem.quantity?.value ?? 1;
    const lineTotalCents = moneyToCents(chargeItem.priceOverride);
    const unitCents = Number.isSafeInteger(quantity) && quantity > 0 && lineTotalCents % quantity === 0
      ? lineTotalCents / quantity
      : undefined;
    const diagnosisSequence = claimDiagnosisSequence(chargeItem, input.diagnoses.length);
    const { laterality } = chargeItemLaterality(chargeItem);
    const lineControlNumber = /^[A-Za-z0-9 .-]{1,30}$/.test(chargeItem.id)
      ? chargeItem.id
      : `${input.patientAccountNumber}-${index + 1}`;
    return {
      sequence: index + 1,
      extension: [
        {
          url: ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
          valueReference: { reference: `ChargeItem/${chargeItem.id}` },
        },
        {
          url: ODOS_CLAIM_LINE_CONTROL_NUMBER_EXTENSION_URL,
          valueString: lineControlNumber,
        },
      ],
      productOrService: {
        coding: [
          {
            system: coding.system,
            code: coding.code,
            ...(coding.display ? { display: coding.display } : {}),
          },
        ],
      },
      servicedDate: input.serviceDate,
      ...(diagnosisSequence.length ? { diagnosisSequence } : {}),
      ...(laterality ? { bodySite: { text: laterality } } : {}),
      quantity: { value: quantity },
      ...(unitCents === undefined ? {} : { unitPrice: money(unitCents) }),
      net: money(lineTotalCents),
    };
  });
  const lineControlNumbers = items.map((item) => claimLineControlNumber(item));
  if (lineControlNumbers.some((value) => !value) || new Set(lineControlNumbers).size !== lineControlNumbers.length) {
    throw new Error("Every professional Claim item must have a unique service-line identity.");
  }

  const totalCents = items.reduce((sum, item) => sum + moneyToCents(item.net), 0);

  return {
    resourceType: "Claim",
    status: "active",
    type: {
      coding: [{ system: HL7_CLAIM_TYPE_SYSTEM, code: "professional", display: "Professional" }],
    },
    use: "claim",
    patient: { reference: input.patientReference },
    created: input.created,
    insurer: { reference: input.insurerReference },
    provider: { reference: input.providerReference },
    ...(input.facilityReference ? { facility: { reference: input.facilityReference } } : {}),
    priority: { text: "normal" },
    identifier: [{ system: "https://odos2020.com/fhir/NamingSystem/odos-claim-pcn", value: input.patientAccountNumber }],
    insurance: [
      {
        sequence: 1,
        focal: true,
        coverage: { reference: input.coverageReference },
      },
    ],
    diagnosis: input.diagnoses.map((diagnosis, index) => ({
      sequence: index + 1,
      diagnosisCodeableConcept: {
        coding: [{ system: diagnosis.system, code: diagnosis.code, ...(diagnosis.display ? { display: diagnosis.display } : {}) }],
      },
    })),
    item: items,
    total: money(totalCents),
  };
}

export function buildClaimMdProfessionalClaimJson(
  input: ProfessionalClaimInput,
  claim: Claim,
): ClaimMdProfessionalClaimPayload {
  const totalCents = moneyToCents(claim.total);
  const serviceDate = claimMdDate(input.serviceDate);
  const lineItems = input.chargeItems.map((chargeItem): ClaimMdProfessionalCharge => {
    const coding = firstCoding(chargeItem);
    const modifierCodes = chargeItem.modifierExtension
      ?.flatMap((extension) => extension.extension ?? [])
      .map((extension) => String(extension.valueCode ?? ""))
      .filter(Boolean)
      .slice(0, 4) ?? [];
    return {
      charge_record_type: "UN",
      proc_code: coding.code,
      charge: centsString(moneyToCents(chargeItem.priceOverride)),
      units: String(chargeItem.quantity?.value ?? 1),
      from_date: serviceDate,
      thru_date: serviceDate,
      diag_ref: diagnosisRef(claimDiagnosisSequence(chargeItem, input.diagnoses.length)),
      ...(chargeItem.id ? { remote_chgid: chargeItem.id } : {}),
      ...Object.fromEntries(modifierCodes.map((code, index) => [`mod${index + 1}`, code])),
    };
  });

  const row: ClaimMdProfessionalClaim = {
    claim_form: "1500",
    payerid: input.payerId,
    pcn: input.patientAccountNumber,
    total_charge: centsString(totalCents),
    balance_due: centsString(totalCents),
    remote_claimid: claim.id ?? input.patientAccountNumber,
    remote_fileid: `odos-${input.patientAccountNumber}`,
    accept_assign: "Y",
    auto_accident: "N",
    employment_related: "N",
    charge: lineItems,
    ...claimMdDiagnosisFields(input.diagnoses),
    ...claimMdBillingFields(input.billingProvider),
    ...claimMdRenderingFields(input.renderingProvider),
    ...claimMdSubscriberFields(input.subscriber),
    ...claimMdPatientFields(input.patient, input.subscriber.relationshipCode ?? "18"),
  };

  return { fileid: `odos-${input.patientAccountNumber}`, claim: [row] };
}

export function buildCoverageEligibilityRequest(input: {
  patientReference: string;
  coverageReference: string;
  insurerReference: string;
  providerReference?: string;
  created: string;
  serviceDate: string;
}): CoverageEligibilityRequest {
  return {
    resourceType: "CoverageEligibilityRequest",
    status: "active",
    purpose: ["validation", "benefits", "auth-requirements"],
    patient: { reference: input.patientReference },
    servicedDate: input.serviceDate,
    created: input.created,
    ...(input.providerReference ? { provider: { reference: input.providerReference } } : {}),
    insurer: { reference: input.insurerReference },
    insurance: [{ focal: true, coverage: { reference: input.coverageReference } }],
  };
}

export function buildCoverageEligibilityResponseFromClaimMd(input: {
  requestReference: string;
  patientReference: string;
  coverageReference: string;
  insurerReference: string;
  requestorReference?: string;
  created: string;
  claimMd: unknown;
}): CoverageEligibilityResponse {
  const benefits = claimMdBenefits(input.claimMd);
  const inforce = benefits.some((benefit) =>
    benefit.benefit_coverage_code === "1" ||
    /active coverage/i.test(String(benefit.benefit_coverage_description ?? "")),
  );

  return {
    resourceType: "CoverageEligibilityResponse",
    status: "active",
    purpose: ["validation", "benefits", "auth-requirements"],
    patient: { reference: input.patientReference },
    created: input.created,
    ...(input.requestorReference ? { requestor: { reference: input.requestorReference } } : {}),
    request: { reference: input.requestReference },
    outcome: "complete",
    insurer: { reference: input.insurerReference },
    insurance: [
      {
        coverage: { reference: input.coverageReference },
        inforce,
        item: benefits.map((benefit) => eligibilityItem(benefit)),
      },
    ],
  };
}

export function buildClaimResponseFromClaimMdEra(input: {
  claimReference: string;
  patientReference: string;
  insurerReference: string;
  providerReference?: string;
  created: string;
  era: ClaimMdEraData & { claim: ClaimMdEraClaim };
}): ClaimResponse {
  const claim = input.era.claim;
  const charges = arrayOf(claim.charge);
  const totalPaidCents = decimalStringToCents(claim.total_paid);

  return {
    resourceType: "ClaimResponse",
    status: "active",
    type: { coding: [{ system: HL7_CLAIM_TYPE_SYSTEM, code: "professional", display: "Professional" }] },
    use: "claim",
    patient: { reference: input.patientReference },
    created: input.created,
    insurer: { reference: input.insurerReference },
    ...(input.providerReference ? { requestor: { reference: input.providerReference } } : {}),
    request: { reference: input.claimReference },
    outcome: claim.status_code === "4" ? "error" : "complete",
    disposition: input.era.payer_name ? `Claim.MD ERA from ${input.era.payer_name}` : "Claim.MD ERA",
    ...(claim.payer_icn ? { preAuthRef: claim.payer_icn } : {}),
    item: charges.map((charge, index) => {
      const chargeItemExtension = claimResponseChargeItemExtension(charge.remote_chgid);
      return {
        itemSequence: index + 1,
        ...(chargeItemExtension ? { extension: [chargeItemExtension] } : {}),
        adjudication: [
          adjudication("submitted", decimalStringToCents(charge.charge)),
          adjudication("allowed", decimalStringToCents(charge.allowed)),
          adjudication("paid", decimalStringToCents(charge.paid)),
          adjudication("patient responsibility", patientResponsibilityCents(charge)),
          ...arrayOf(charge.adjustment).map((adjustment) =>
            adjudication(
              ["adjustment", adjustment.group, adjustment.code].filter(Boolean).join(" "),
              decimalStringToCents(adjustment.amount),
            ),
          ),
        ].filter((entry) => moneyToCents(entry.amount) > 0),
      };
    }),
    payment: {
      type: { text: input.era.payment_method ? `Claim.MD ERA ${input.era.payment_method}` : "Claim.MD ERA" },
      date: isoDateFromClaimMd(input.era.paid_date) ?? input.created,
      amount: money(totalPaidCents),
      ...(input.era.eraid ? { identifier: { system: "https://odos2020.com/fhir/NamingSystem/claimmd-era", value: input.era.eraid } } : {}),
    },
  };
}

export function buildManualClaimResponse(input: {
  claimReference: string;
  patientReference: string;
  insurerReference: string;
  providerReference?: string;
  created: string;
  paymentDate: string;
  paymentReference: string;
  paymentIdentifierSystem: string;
  lines: ManualClaimResponseLineInput[];
}): ClaimResponse {
  if (!/^Claim\/[A-Za-z0-9.-]+$/.test(input.claimReference)) {
    throw new Error("Manual ClaimResponse request must reference Claim/<id>.");
  }
  if (!/^Patient\/[A-Za-z0-9.-]+$/.test(input.patientReference)) {
    throw new Error("Manual ClaimResponse patient must reference Patient/<id>.");
  }
  if (!/^Organization\/[A-Za-z0-9.-]+$/.test(input.insurerReference)) {
    throw new Error("Manual ClaimResponse insurer must reference Organization/<id>.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) {
    throw new Error("Manual ClaimResponse paymentDate must be an R4 date (YYYY-MM-DD).");
  }
  if (!input.created || !input.paymentReference || !input.paymentIdentifierSystem) {
    throw new Error("Manual ClaimResponse requires created, paymentReference, and paymentIdentifierSystem.");
  }
  if (input.lines.length === 0) {
    throw new Error("Manual ClaimResponse requires at least one adjudicated claim line.");
  }
  const sequences = new Set<number>();
  for (const line of input.lines) {
    if (!Number.isInteger(line.itemSequence) || line.itemSequence <= 0 || sequences.has(line.itemSequence)) {
      throw new Error("Manual ClaimResponse itemSequence values must be unique positive integers.");
    }
    sequences.add(line.itemSequence);
    for (const [field, value] of Object.entries(line).filter(([field]) => field !== "itemSequence")) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Manual ClaimResponse ${field} must be a nonnegative integer number of cents.`);
      }
    }
    const patientResponsibilityCents = line.deductibleCents + line.coinsuranceCents + line.copayCents;
    if (line.paidCents + patientResponsibilityCents > line.allowedCents) {
      throw new Error("Manual ClaimResponse paid plus patient responsibility cannot exceed allowed.");
    }
  }
  const totalPaidCents = input.lines.reduce((sum, line) => sum + line.paidCents, 0);
  if (totalPaidCents <= 0) {
    throw new Error("Manual ClaimResponse requires a positive paid amount.");
  }

  return {
    resourceType: "ClaimResponse",
    status: "active",
    type: { coding: [{ system: HL7_CLAIM_TYPE_SYSTEM, code: "professional", display: "Professional" }] },
    use: "claim",
    patient: { reference: input.patientReference },
    created: input.created,
    insurer: { reference: input.insurerReference },
    ...(input.providerReference ? { requestor: { reference: input.providerReference } } : {}),
    request: { reference: input.claimReference },
    outcome: "complete",
    disposition: "Manual EOB posting",
    item: input.lines.map((line) => {
      const patientResponsibilityCents = line.deductibleCents + line.coinsuranceCents + line.copayCents;
      return {
        itemSequence: line.itemSequence,
        adjudication: [
          adjudication("submitted", line.submittedCents),
          adjudication("allowed", line.allowedCents),
          adjudication("paid", line.paidCents),
          adjudication("patient responsibility", patientResponsibilityCents),
          adjudication(["adjustment", "PR", "1"].filter(Boolean).join(" "), line.deductibleCents),
          adjudication(["adjustment", "PR", "2"].filter(Boolean).join(" "), line.coinsuranceCents),
          adjudication(["adjustment", "PR", "3"].filter(Boolean).join(" "), line.copayCents),
        ],
      };
    }),
    payment: {
      type: { text: "Manual EOB" },
      date: input.paymentDate,
      amount: money(totalPaidCents),
      identifier: { system: input.paymentIdentifierSystem, value: input.paymentReference },
    },
  };
}

export function buildClaimResponseFromClaimMdStatus(input: {
  claimReference: string;
  patientReference: string;
  insurerReference: string;
  providerReference?: string;
  created: string;
  status: unknown;
}): ClaimResponse {
  const claim = firstClaimMdClaim(input.status);
  const message = claimMessage(claim);
  return {
    resourceType: "ClaimResponse",
    status: "active",
    type: { coding: [{ system: HL7_CLAIM_TYPE_SYSTEM, code: "professional", display: "Professional" }] },
    use: "claim",
    patient: { reference: input.patientReference },
    created: input.created,
    insurer: { reference: input.insurerReference },
    ...(input.providerReference ? { requestor: { reference: input.providerReference } } : {}),
    request: { reference: input.claimReference },
    outcome: claimOutcome(String(claim.status_code ?? claim.status ?? ""), message),
    disposition: message || "Claim.MD status update",
    ...(claim.claimmd_id ? { preAuthRef: String(claim.claimmd_id) } : {}),
  };
}

export function medicalEligibilitySummary(response: Pick<CoverageEligibilityResponse, "insurance">): MedicalEligibilitySummary {
  const insurance = response.insurance?.[0];
  const items = insurance?.item ?? [];
  return {
    coverageStatus: insurance?.inforce === true ? "active" : insurance?.inforce === false ? "inactive" : "unknown",
    deductibleRemainingCents: moneyBenefit(items, /deductible/i),
    copayCents: moneyBenefit(items, /co-?payment|copay/i),
    coinsurancePercent: unsignedBenefit(items, /co-?insurance|coinsurance/i),
    priorAuthRequired: items.some((item) => item.authorizationRequired || /prior auth/i.test(`${item.name ?? ""} ${item.description ?? ""}`)),
  };
}

function firstCoding(chargeItem: ChargeItem): { system: string; code: string; display?: string } {
  const coding = chargeItem.code.coding?.[0];
  if (!coding?.system || !coding.code) {
    throw new Error("ChargeItem must carry a coded productOrService for Claim.MD submission.");
  }
  return { system: coding.system, code: coding.code, ...(coding.display ? { display: coding.display } : {}) };
}

function money(cents: number): Money {
  return { value: cents / 100, currency: "USD" };
}

function moneyToCents(value: Money | undefined): number {
  if (typeof value?.value !== "number" || value.value < 0) {
    throw new Error("Expected a nonnegative USD Money value.");
  }
  return Math.round(value.value * 100);
}

function decimalStringToCents(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function centsString(cents: number): string {
  return (cents / 100).toFixed(2);
}

function claimMdDate(date: string): string {
  if (/^\d{8}$/.test(date)) return date;
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error("Claim.MD service dates must be YYYY-MM-DD or YYYYMMDD.");
  }
  return `${match[1]}${match[2]}${match[3]}`;
}

function isoDateFromClaimMd(date: string | undefined): string | undefined {
  if (!date) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const match = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

export function claimDiagnosisSequence(
  chargeItem: ProfessionalClaimChargeItemInput,
  diagnosisCount: number,
): number[] {
  const sequence = chargeItem.diagnosisSequence ?? [1];
  if (sequence.length < 1) {
    throw new Error("ChargeItem diagnosisSequence must contain at least one diagnosis position.");
  }
  if (sequence.length > 4) {
    throw new Error("ChargeItem diagnosisSequence cannot contain more than 4 diagnosis positions.");
  }
  const maximumPosition = Math.min(diagnosisCount, 12);
  if (sequence.some((value) =>
    !Number.isInteger(value) || value < 1 || value > maximumPosition
  )) {
    throw new Error(`ChargeItem diagnosisSequence positions must be integers from 1 through ${maximumPosition}.`);
  }
  if (new Set(sequence).size !== sequence.length) {
    throw new Error("ChargeItem diagnosisSequence positions must be unique.");
  }
  return [...sequence];
}

function diagnosisRef(sequence: number[]): string {
  return sequence.map((value) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[value - 1]).join("");
}

function claimMdDiagnosisFields(diagnoses: ProfessionalClaimDiagnosisInput[]): Record<string, string> {
  return Object.fromEntries(diagnoses.slice(0, 12).map((diagnosis, index) => [`diag_${index + 1}`, diagnosis.code]));
}

function claimMdBillingFields(provider: ClaimMdProviderInput): Record<string, string> {
  return compact({
    bill_name: provider.name,
    bill_npi: provider.npi,
    bill_taxid: provider.taxId,
    bill_taxid_type: provider.taxIdType,
    bill_addr_1: provider.address1,
    bill_city: provider.city,
    bill_state: provider.state,
    bill_zip: provider.zip,
    bill_phone: provider.phone,
  });
}

function claimMdRenderingFields(provider: ClaimMdProviderInput): Record<string, string> {
  return compact({
    prov_name_f: provider.firstName,
    prov_name_l: provider.lastName ?? provider.name,
    prov_npi: provider.npi,
    prov_taxonomy: provider.taxonomy,
    prov_taxid: provider.taxId,
    prov_taxid_type: provider.taxIdType,
    prov_addr_1: provider.address1,
    prov_city: provider.city,
    prov_state: provider.state,
    prov_zip: provider.zip,
  });
}

function claimMdSubscriberFields(person: ClaimMdPersonInput): Record<string, string> {
  return compact({
    ins_name_f: person.firstName,
    ins_name_l: person.lastName,
    ins_name_m: person.middleName,
    ins_number: person.memberId,
    ins_group: person.groupNumber,
    ins_dob: claimMdDate(person.dateOfBirth),
    ins_sex: person.sex,
    ins_addr_1: person.address1,
    ins_city: person.city,
    ins_state: person.state,
    ins_zip: person.zip,
  });
}

function claimMdPatientFields(person: ClaimMdPersonInput, relationshipCode: string): Record<string, string> {
  return compact({
    pat_rel: relationshipCode,
    pat_name_f: person.firstName,
    pat_name_l: person.lastName,
    pat_name_m: person.middleName,
    pat_dob: claimMdDate(person.dateOfBirth),
    pat_sex: person.sex,
    pat_addr_1: person.address1,
    pat_city: person.city,
    pat_state: person.state,
    pat_zip: person.zip,
  });
}

function compact(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function claimMdBenefits(raw: unknown): Array<Record<string, string>> {
  const record = raw as { result?: { elig?: { benefit?: unknown } } };
  return arrayOf(record.result?.elig?.benefit).map((benefit) => benefit as Record<string, string>);
}

function eligibilityItem(benefit: Record<string, string>): CoverageEligibilityItem {
  const description = benefit.benefit_coverage_description ?? benefit.benefit_description ?? "Eligibility benefit";
  const amountCents = decimalStringToCents(benefit.benefit_amount);
  const percent = numericPercent(benefit.benefit_percent);
  const priorAuth = /prior auth/i.test(description);
  return {
    name: description,
    description: benefit.benefit_description,
    category: { text: benefit.benefit_description ?? "medical eligibility" },
    authorizationRequired: priorAuth || undefined,
    benefit: [
      amountCents > 0
        ? { type: { text: benefitTypeText(description) }, allowedMoney: money(amountCents) }
        : undefined,
      percent !== undefined
        ? { type: { text: benefitTypeText(description) }, allowedUnsignedInt: percent }
        : undefined,
    ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
  };
}

function benefitTypeText(description: string): string {
  if (/deductible/i.test(description)) return "remaining";
  if (/co-?payment|copay/i.test(description)) return "copay";
  if (/co-?insurance|coinsurance/i.test(description)) return "coinsurance";
  return description.toLowerCase();
}

function numericPercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function adjudication(category: string, cents: number): NonNullable<ClaimResponse["item"]>[number]["adjudication"][number] {
  return { category: { text: category }, amount: money(cents) };
}

function patientResponsibilityCents(charge: ClaimMdEraCharge): number {
  return arrayOf(charge.adjustment)
    .filter((adjustment) => adjustment.group === "PR")
    .reduce((sum, adjustment) => sum + decimalStringToCents(adjustment.amount), 0);
}

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function firstClaimMdClaim(status: unknown): Record<string, unknown> {
  const result = (status as { result?: { claim?: unknown } }).result;
  return (arrayOf(result?.claim as Record<string, unknown> | Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>;
}

function claimMessage(claim: Record<string, unknown>): string {
  const messages = claim.messages ?? claim.message;
  if (Array.isArray(messages)) return messages.map((m) => String((m as { message?: unknown }).message ?? m)).join("; ");
  if (typeof messages === "object" && messages) return String((messages as { message?: unknown }).message ?? "");
  return typeof messages === "string" ? messages : "";
}

function claimOutcome(status: string, message: string): ClaimResponse["outcome"] {
  if (/reject|deny|error|failed/i.test(`${status} ${message}`)) return "error";
  if (/paid|finalized|complete/i.test(message)) return "complete";
  return "queued";
}

function moneyBenefit(
  items: NonNullable<CoverageEligibilityResponse["insurance"]>[number]["item"],
  pattern: RegExp,
): number | undefined {
  const item = items?.find((candidate) => pattern.test(`${candidate.name ?? ""} ${candidate.description ?? ""}`));
  const value = item?.benefit?.find((benefit) => benefit.allowedMoney)?.allowedMoney;
  return value ? moneyToCents(value) : undefined;
}

function unsignedBenefit(
  items: NonNullable<CoverageEligibilityResponse["insurance"]>[number]["item"],
  pattern: RegExp,
): number | undefined {
  const item = items?.find((candidate) => pattern.test(`${candidate.name ?? ""} ${candidate.description ?? ""}`));
  return item?.benefit?.find((benefit) => benefit.allowedUnsignedInt !== undefined)?.allowedUnsignedInt;
}
