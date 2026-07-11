import type { Claim, ClaimResponse, CoverageEligibilityResponse, Money } from "@medplum/fhirtypes";
import { HL7_CLAIM_TYPE_SYSTEM, type ProfessionalClaimInput } from "./claimmd-fhir.js";

export interface StediProfessionalClaimPayload {
  usageIndicator: "T" | "P";
  tradingPartnerServiceId: string;
  tradingPartnerName?: string;
  submitter: Record<string, unknown>;
  receiver: Record<string, unknown>;
  billing: Record<string, unknown>;
  subscriber: Record<string, unknown>;
  claimInformation: {
    patientControlNumber: string;
    claimChargeAmount: string;
    claimFilingCode: string;
    claimFrequencyCode: string;
    placeOfServiceCode: string;
    planParticipationCode: string;
    benefitsAssignmentCertificationIndicator: string;
    releaseInformationCode: string;
    signatureIndicator: string;
    healthCareCodeInformation: Array<{ diagnosisTypeCode: string; diagnosisCode: string }>;
    serviceLines: Array<{
      providerControlNumber: string;
      serviceDate: string;
      professionalService: {
        procedureIdentifier: "HC";
        procedureCode: string;
        lineItemChargeAmount: string;
        measurementUnit: "UN";
        serviceUnitCount: string;
        compositeDiagnosisCodePointers: { diagnosisCodePointers: string[] };
        procedureModifiers?: string[];
      };
      renderingProvider: Record<string, unknown>;
    }>;
  };
}

export interface StediEraClaim {
  claimPaymentInfo: {
    patientControlNumber?: string;
    totalClaimChargeAmount?: string;
    claimPaymentAmount?: string;
    patientResponsibilityAmount?: string;
    payerClaimControlNumber?: string;
    claimStatusCode?: string;
  };
  serviceLines?: Array<{
    servicePaymentInformation?: {
      lineItemChargeAmount?: string;
      lineItemProviderPaymentAmount?: string;
      adjudicatedProcedureCode?: string;
    };
    serviceSupplementalAmounts?: { allowedActual?: string };
    serviceAdjustments?: Array<{
      claimAdjustmentGroupCode?: string;
      adjustmentReasonCode1?: string;
      adjustmentAmount1?: string;
    }>;
  }>;
}

export interface StediEraEnvelope {
  transactionId: string;
  payerName?: string;
  paymentDate: string;
  traceNumber?: string;
  claims: StediEraClaim[];
}

export function readStediEra(raw: any, fallbackTransactionId: string): StediEraEnvelope {
  const transaction = raw?.transactions?.[0] ?? {};
  const claims = (transaction.detailInfo ?? []).flatMap((detail: any) => detail.paymentInfo ?? []) as StediEraClaim[];
  const paymentDate = transaction.financialInformation?.checkIssueOrEFTEffectiveDate;
  if (!paymentDate) throw new Error("Stedi ERA is missing its payment effective date.");
  return {
    transactionId: String(raw?.meta?.transactionId ?? fallbackTransactionId),
    payerName: transaction.payer?.name ? String(transaction.payer.name) : undefined,
    paymentDate: String(paymentDate),
    traceNumber: transaction.paymentAndRemitReassociationDetails?.checkOrEFTTraceNumber
      ? String(transaction.paymentAndRemitReassociationDetails.checkOrEFTTraceNumber)
      : undefined,
    claims,
  };
}

export function buildStediProfessionalClaimJson(
  input: ProfessionalClaimInput,
  claim: Claim,
  mode: "test" | "production",
  submitterId = input.billingProvider.npi,
): StediProfessionalClaimPayload {
  const billing = input.billingProvider;
  const rendering = input.renderingProvider;
  const total = decimal(claim.total?.value ?? 0);
  if (!/^[A-Z0-9 .-]{1,17}$/i.test(input.patientAccountNumber) || /[~*:^]/.test(input.patientAccountNumber)) {
    throw new Error("Stedi patient account number must be 1-17 basic X12 characters without reserved delimiters.");
  }
  if (!billing.name || !billing.taxId || !billing.address1 || !billing.city || !billing.state || !billing.zip) {
    throw new Error("Stedi professional claims require billing name, tax ID, and complete physical address.");
  }
  return {
    usageIndicator: mode === "production" ? "P" : "T",
    tradingPartnerServiceId: input.payerId,
    submitter: {
      organizationName: billing.name,
      submitterIdentification: submitterId,
      contactInformation: compact({ name: billing.name, phoneNumber: digits(billing.phone) }),
    },
    receiver: { organizationName: input.payerId },
    billing: compact({
      organizationName: billing.name,
      npi: billing.npi,
      employerId: billing.taxIdType === "S" ? undefined : billing.taxId,
      ssn: billing.taxIdType === "S" ? billing.taxId : undefined,
      taxonomyCode: billing.taxonomy,
      providerType: "BillingProvider",
      address: address(billing),
      contactInformation: compact({ name: billing.name, phoneNumber: digits(billing.phone) }),
    }),
    subscriber: compact({
      firstName: input.subscriber.firstName,
      lastName: input.subscriber.lastName,
      dateOfBirth: x12Date(input.subscriber.dateOfBirth),
      gender: input.subscriber.sex === "U" ? undefined : input.subscriber.sex,
      memberId: input.subscriber.memberId,
      groupNumber: input.subscriber.groupNumber,
      paymentResponsibilityLevelCode: "P",
      address: address(input.subscriber),
    }),
    claimInformation: {
      patientControlNumber: input.patientAccountNumber,
      claimChargeAmount: total,
      claimFilingCode: "CI",
      claimFrequencyCode: "1",
      placeOfServiceCode: "11",
      planParticipationCode: "A",
      benefitsAssignmentCertificationIndicator: "Y",
      releaseInformationCode: "Y",
      signatureIndicator: "Y",
      healthCareCodeInformation: input.diagnoses.map((diagnosis, index) => ({
        diagnosisTypeCode: index === 0 ? "ABK" : "ABF",
        diagnosisCode: diagnosis.code.replace(".", ""),
      })),
      serviceLines: input.chargeItems.map((item, index) => {
        const coding = item.code.coding?.[0];
        if (!coding?.code) throw new Error("ChargeItem must carry a procedure code for Stedi submission.");
        const modifiers = item.modifierExtension?.flatMap((extension) => extension.extension ?? [])
          .flatMap((extension) => extension.valueCode ? [extension.valueCode] : [])
          .slice(0, 4);
        return {
          providerControlNumber: item.id ?? `${input.patientAccountNumber}-${index + 1}`,
          serviceDate: x12Date(input.serviceDate),
          professionalService: {
            procedureIdentifier: "HC",
            procedureCode: coding.code,
            lineItemChargeAmount: decimal(item.priceOverride?.value ?? 0),
            measurementUnit: "UN",
            serviceUnitCount: String(item.quantity?.value ?? 1),
            compositeDiagnosisCodePointers: { diagnosisCodePointers: input.diagnoses.slice(0, 4).map((_, diagnosisIndex) => String(diagnosisIndex + 1)) },
            ...(modifiers?.length ? { procedureModifiers: modifiers } : {}),
          },
          renderingProvider: compact({
            firstName: rendering.firstName,
            lastName: rendering.lastName ?? rendering.name,
            npi: rendering.npi,
            taxonomyCode: rendering.taxonomy,
            providerType: "RenderingProvider",
          }),
        };
      }),
    },
  };
}

export function buildStediEligibilityJson(input: ProfessionalClaimInput, serviceTypeCodes: string[] = ["30"]): Record<string, any> {
  return {
    tradingPartnerServiceId: input.payerId,
    encounter: { dateOfService: x12Date(input.serviceDate), serviceTypeCodes },
    provider: compact({ organizationName: input.billingProvider.name, npi: input.billingProvider.npi }),
    subscriber: compact({
      firstName: input.subscriber.firstName,
      lastName: input.subscriber.lastName,
      dateOfBirth: x12Date(input.subscriber.dateOfBirth),
      memberId: input.subscriber.memberId,
    }),
  };
}

export function buildCoverageEligibilityResponseFromStedi(input: {
  requestReference: string;
  patientReference: string;
  coverageReference: string;
  insurerReference: string;
  requestorReference?: string;
  created: string;
  stedi: any;
}): CoverageEligibilityResponse {
  const benefits = Array.isArray(input.stedi?.benefitsInformation) ? input.stedi.benefitsInformation : [];
  const statuses = Array.isArray(input.stedi?.planStatus) ? input.stedi.planStatus : [];
  const inforce = statuses.some((status: any) => status.statusCode === "1" || /active coverage/i.test(String(status.status ?? "")));
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
    insurance: [{
      coverage: { reference: input.coverageReference },
      inforce,
      item: benefits.map((benefit: any) => ({
        name: String(benefit.name ?? "Eligibility benefit"),
        description: additionalInformation(benefit),
        category: { text: Array.isArray(benefit.serviceTypes) ? benefit.serviceTypes.join(", ") : "medical eligibility" },
        authorizationRequired: /prior auth/i.test(`${benefit.name ?? ""} ${additionalInformation(benefit) ?? ""}`) || undefined,
        benefit: [
          benefit.benefitAmount !== undefined ? { type: { text: benefitType(String(benefit.name ?? "")) }, allowedMoney: money(decimalCents(benefit.benefitAmount)) } : undefined,
          benefit.benefitPercent !== undefined ? { type: { text: benefitType(String(benefit.name ?? "")) }, allowedUnsignedInt: Math.round(Number(benefit.benefitPercent) * 100) } : undefined,
        ].filter(Boolean) as any,
      })),
    }],
  };
}

export function buildClaimResponseFromStediStatus(input: {
  claimReference: string;
  patientReference: string;
  insurerReference: string;
  providerReference?: string;
  created: string;
  status: any;
}): ClaimResponse {
  const status = input.status?.claims?.[0]?.claimStatus ?? {};
  const message = String(status.statusCodeValue ?? status.statusCategoryCodeValue ?? "Stedi status update");
  return claimResponseBase(input, {
    outcome: /reject|deny|error|failed/i.test(message) ? "error" : /paid|finalized|complete/i.test(message) ? "complete" : "queued",
    disposition: message,
    ...(status.trackingNumber || status.tradingPartnerClaimNumber ? { preAuthRef: String(status.trackingNumber ?? status.tradingPartnerClaimNumber) } : {}),
  });
}

export function buildClaimResponseFromStediEra(input: {
  claimReference: string;
  patientReference: string;
  insurerReference: string;
  providerReference?: string;
  created: string;
  transactionId: string;
  payerName?: string;
  paymentDate: string;
  traceNumber?: string;
  claim: StediEraClaim;
}): ClaimResponse {
  const paid = decimalCents(input.claim.claimPaymentInfo.claimPaymentAmount);
  return claimResponseBase(input, {
    outcome: input.claim.claimPaymentInfo.claimStatusCode === "4" ? "error" : "complete",
    disposition: input.payerName ? `Stedi ERA from ${input.payerName}` : "Stedi ERA",
    ...(input.claim.claimPaymentInfo.payerClaimControlNumber ? { preAuthRef: input.claim.claimPaymentInfo.payerClaimControlNumber } : {}),
    item: (input.claim.serviceLines ?? []).map((line, index) => ({
      itemSequence: index + 1,
      adjudication: [
        adjudication("submitted", decimalCents(line.servicePaymentInformation?.lineItemChargeAmount)),
        adjudication("allowed", decimalCents(line.serviceSupplementalAmounts?.allowedActual)),
        adjudication("paid", decimalCents(line.servicePaymentInformation?.lineItemProviderPaymentAmount)),
        ...((line.serviceAdjustments ?? []).map((adjustment) => adjudication(
          ["adjustment", adjustment.claimAdjustmentGroupCode, adjustment.adjustmentReasonCode1].filter(Boolean).join(" "),
          decimalCents(adjustment.adjustmentAmount1),
        ))),
      ].filter((entry) => (entry.amount?.value ?? 0) > 0),
    })),
    payment: {
      type: { text: "Stedi ERA" },
      date: isoDate(input.paymentDate) ?? input.created,
      amount: money(paid),
      identifier: {
        system: "https://osod.dev/fhir/NamingSystem/stedi-era",
        value: input.traceNumber ?? input.transactionId,
      },
    },
  });
}

function claimResponseBase(input: any, fields: Partial<ClaimResponse>): ClaimResponse {
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
    outcome: "queued",
    ...fields,
  };
}

function address(input: { address1?: string; city?: string; state?: string; zip?: string }): Record<string, string> | undefined {
  if (!input.address1 || !input.city || !input.state || !input.zip) return undefined;
  return { address1: input.address1, city: input.city, state: input.state, postalCode: digits(input.zip) ?? input.zip };
}

function compact(input: Record<string, unknown>): Record<string, any> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

function digits(value: string | undefined): string | undefined {
  return value?.replace(/\D/g, "") || undefined;
}

function x12Date(value: string): string {
  if (/^\d{8}$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("Stedi dates must be YYYY-MM-DD or YYYYMMDD.");
  return `${match[1]}${match[2]}${match[3]}`;
}

function isoDate(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function decimal(value: number): string {
  return value.toFixed(2);
}

function decimalCents(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function money(cents: number): Money {
  return { value: cents / 100, currency: "USD" };
}

function adjudication(category: string, cents: number): NonNullable<ClaimResponse["item"]>[number]["adjudication"][number] {
  return { category: { text: category }, amount: money(cents) };
}

function additionalInformation(benefit: any): string | undefined {
  const values = Array.isArray(benefit.additionalInformation)
    ? benefit.additionalInformation.map((item: any) => item.description).filter(Boolean)
    : [];
  return values.length ? values.join("; ") : undefined;
}

function benefitType(name: string): string {
  if (/deductible/i.test(name)) return "remaining";
  if (/co-?payment|copay/i.test(name)) return "copay";
  if (/co-?insurance|coinsurance/i.test(name)) return "coinsurance";
  return name.toLowerCase();
}
