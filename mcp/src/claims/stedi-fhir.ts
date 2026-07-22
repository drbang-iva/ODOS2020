import type { Claim, ClaimResponse, CoverageEligibilityResponse, Money } from "@medplum/fhirtypes";
import {
  claimResponseChargeItemExtension,
  HL7_CLAIM_TYPE_SYSTEM,
  type ProfessionalClaimInput,
} from "./claimmd-fhir.js";
import { ClaimSubmissionValidationError } from "./claim-errors.js";

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
  claimAdjustments?: StediEraAdjustment[];
  crossoverCarrier?: StediEraCrossoverCarrier;
  serviceLines?: Array<{
    lineItemControlNumber?: string;
    servicePaymentInformation?: {
      lineItemChargeAmount?: string;
      lineItemProviderPaymentAmount?: string;
      adjudicatedProcedureCode?: string;
    };
    serviceSupplementalAmounts?: { allowedActual?: string };
    serviceAdjustments?: StediEraAdjustment[];
  }>;
}

interface StediEraAdjustment {
  claimAdjustmentGroupCode?: string;
  adjustmentReasonCode1?: string;
  adjustmentReasonCode2?: string;
  adjustmentReasonCode3?: string;
  adjustmentReasonCode4?: string;
  adjustmentReasonCode5?: string;
  adjustmentReasonCode6?: string;
  adjustmentReason1?: string;
  adjustmentReason2?: string;
  adjustmentReason3?: string;
  adjustmentReason4?: string;
  adjustmentReason5?: string;
  adjustmentReason6?: string;
  adjustmentAmount1?: string;
  adjustmentAmount2?: string;
  adjustmentAmount3?: string;
  adjustmentAmount4?: string;
  adjustmentAmount5?: string;
  adjustmentAmount6?: string;
}

interface StediEraCrossoverCarrier {
  organizationName?: string;
  payorId?: string;
  blueCrossBlueShieldAssociationPlanCode?: string;
  centersForMedicareAndMedicaidServicesPlanId?: string;
  nationalAssociationOfInsuranceCommissionersIdentification?: string;
  pharmacyProcessorNumber?: string;
  taxId?: string;
}

export interface StediEraClaimAnalysis {
  claimStatusCode: string;
  outcome: NonNullable<ClaimResponse["outcome"]>;
  statusText: string;
  allowsReconciliation: boolean;
  allowsPatientResponsibilityInvoice: boolean;
  isDenial: boolean;
  authoritativePatientResponsibilityCents?: number;
  derivedPatientResponsibilityCents: number;
  reviewReasons: string[];
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
    throw new ClaimSubmissionValidationError("Stedi professional claims require billing name, tax ID, and complete physical address.");
  }
  if (!input.subscriber.address1 || !input.subscriber.city || !input.subscriber.state || !input.subscriber.zip) {
    throw new ClaimSubmissionValidationError("Stedi professional claims require subscriber address and complete physical address.");
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
  const analysis = analyzeStediEraClaim(input.claim);
  const paid = optionalDecimalCents(input.claim.claimPaymentInfo.claimPaymentAmount);
  const crossoverCarrier = crossoverCarrierText(input.claim.crossoverCarrier);
  const disposition = [
    input.payerName ? `Stedi ERA from ${input.payerName}` : "Stedi ERA",
    `${analysis.claimStatusCode}: ${analysis.statusText}`,
    ...(crossoverCarrier ? [`crossover carrier ${crossoverCarrier}`] : []),
  ].join(" — ");
  const processNotes = [
    ...analysis.reviewReasons,
    ...(crossoverCarrier ? [`Crossover carrier: ${crossoverCarrier}.`] : []),
  ];
  const totals = [
    claimTotal("submitted", optionalDecimalCents(input.claim.claimPaymentInfo.totalClaimChargeAmount)),
    claimTotal("patient responsibility", analysis.authoritativePatientResponsibilityCents),
    ...adjustmentAdjudications(input.claim.claimAdjustments, "claim adjustment").map((entry) => ({
      category: entry.category,
      amount: entry.amount!,
    })),
  ].filter((entry): entry is NonNullable<ClaimResponse["total"]>[number] => entry !== undefined);
  return claimResponseBase(input, {
    outcome: analysis.outcome,
    disposition,
    ...(processNotes.length ? { processNote: processNotes.map((text, index) => ({ number: index + 1, type: "display", text })) } : {}),
    ...(input.claim.claimPaymentInfo.payerClaimControlNumber ? { preAuthRef: input.claim.claimPaymentInfo.payerClaimControlNumber } : {}),
    item: (input.claim.serviceLines ?? []).map((line, index) => {
      const chargeItemExtension = claimResponseChargeItemExtension(line.lineItemControlNumber);
      return {
        itemSequence: index + 1,
        ...(chargeItemExtension ? { extension: [chargeItemExtension] } : {}),
        adjudication: [
          optionalAdjudication("submitted", line.servicePaymentInformation?.lineItemChargeAmount),
          optionalAdjudication("allowed", line.serviceSupplementalAmounts?.allowedActual),
          optionalAdjudication("paid", line.servicePaymentInformation?.lineItemProviderPaymentAmount),
          ...adjustmentAdjudications(line.serviceAdjustments, "adjustment"),
        ].filter((entry): entry is NonNullable<ClaimResponse["item"]>[number]["adjudication"][number] => entry !== undefined),
      };
    }),
    ...(totals.length ? { total: totals } : {}),
    ...(paid !== undefined && !["23", "25"].includes(analysis.claimStatusCode) ? { payment: {
      type: { text: "Stedi ERA" },
      date: isoDate(input.paymentDate) ?? input.created,
      amount: money(paid),
      identifier: {
        system: "https://odos2020.com/fhir/NamingSystem/stedi-era",
        value: input.traceNumber ?? input.transactionId,
      },
    } } : {}),
  });
}

export function analyzeStediEraClaim(claim: StediEraClaim): StediEraClaimAnalysis {
  const claimStatusCode = String(claim.claimPaymentInfo.claimStatusCode ?? "");
  const status = STEDI_ERA_CLAIM_STATUSES[claimStatusCode] ?? {
    outcome: "queued" as const,
    text: claimStatusCode ? `Unrecognized Stedi ERA claim status ${claimStatusCode}` : "Missing Stedi ERA claim status",
    allowsReconciliation: false,
    allowsPatientResponsibilityInvoice: false,
    reviewReason: claimStatusCode
      ? `Stedi ERA claim status ${claimStatusCode} is not recognized and requires manual review.`
      : "Stedi ERA claim status is missing and requires manual review.",
  };
  const authoritativePatientResponsibilityCents = optionalDecimalCents(
    claim.claimPaymentInfo.patientResponsibilityAmount,
  );
  const derivedPatientResponsibilityCents = (claim.serviceLines ?? []).reduce(
    (lineTotal, line) => lineTotal + (line.serviceAdjustments ?? [])
      .filter((adjustment) => adjustment.claimAdjustmentGroupCode === "PR")
      .reduce((adjustmentTotal, adjustment) => adjustmentTotal + adjustmentAmounts(adjustment)
        .reduce((sum, entry) => sum + entry.cents, 0), 0),
    0,
  );
  const responsibilityMismatch = authoritativePatientResponsibilityCents !== undefined
    && authoritativePatientResponsibilityCents !== derivedPatientResponsibilityCents;
  const claimLevelOnlyResponsibility = authoritativePatientResponsibilityCents !== undefined
    && authoritativePatientResponsibilityCents > 0
    && (claim.serviceLines ?? []).length === 0;
  return {
    claimStatusCode,
    outcome: status.outcome,
    statusText: status.text,
    allowsReconciliation: status.allowsReconciliation,
    allowsPatientResponsibilityInvoice: status.allowsPatientResponsibilityInvoice,
    isDenial: claimStatusCode === "4",
    ...(authoritativePatientResponsibilityCents !== undefined ? { authoritativePatientResponsibilityCents } : {}),
    derivedPatientResponsibilityCents,
    reviewReasons: [
      ...invalidAmountReviewReasons(claim),
      ...(status.reviewReason ? [status.reviewReason] : []),
      ...(claimLevelOnlyResponsibility ? [
        `Payer-stated patient responsibility ${formatCents(authoritativePatientResponsibilityCents)} cannot be invoiced automatically because the ERA has no service lines.`,
      ] : []),
      ...(responsibilityMismatch ? [
        `Payer-stated patient responsibility ${formatCents(authoritativePatientResponsibilityCents)} differs from summed service-line PR adjustments ${formatCents(derivedPatientResponsibilityCents)}.`,
      ] : []),
    ],
  };
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

const STEDI_ERA_CLAIM_STATUSES: Record<string, {
  outcome: NonNullable<ClaimResponse["outcome"]>;
  text: string;
  allowsReconciliation: boolean;
  allowsPatientResponsibilityInvoice: boolean;
  reviewReason?: string;
}> = {
  "1": { outcome: "complete", text: "Processed as Primary", allowsReconciliation: true, allowsPatientResponsibilityInvoice: true },
  "2": { outcome: "complete", text: "Processed as Secondary", allowsReconciliation: true, allowsPatientResponsibilityInvoice: true },
  "3": { outcome: "complete", text: "Processed as Tertiary", allowsReconciliation: true, allowsPatientResponsibilityInvoice: true },
  "4": { outcome: "error", text: "Denied", allowsReconciliation: false, allowsPatientResponsibilityInvoice: false },
  "19": {
    outcome: "partial",
    text: "Processed as Primary, Forwarded to Additional Payer(s)",
    allowsReconciliation: true,
    allowsPatientResponsibilityInvoice: false,
    reviewReason: "Stedi ERA was processed as primary and forwarded to an additional payer; secondary-payer follow-up requires review.",
  },
  "20": {
    outcome: "partial",
    text: "Processed as Secondary, Forwarded to Additional Payer(s)",
    allowsReconciliation: true,
    allowsPatientResponsibilityInvoice: false,
    reviewReason: "Stedi ERA was processed as secondary and forwarded to an additional payer; downstream-payer follow-up requires review.",
  },
  "21": {
    outcome: "partial",
    text: "Processed as Tertiary, Forwarded to Additional Payer(s)",
    allowsReconciliation: true,
    allowsPatientResponsibilityInvoice: false,
    reviewReason: "Stedi ERA was processed as tertiary and forwarded to an additional payer; downstream-payer follow-up requires review.",
  },
  "22": {
    outcome: "complete",
    text: "Reversal of Previous Payment",
    allowsReconciliation: false,
    allowsPatientResponsibilityInvoice: false,
    reviewReason: "Stedi ERA reversal requires manual posting because negative PaymentReconciliation handling is not automated.",
  },
  "23": {
    outcome: "partial",
    text: "Not Our Claim, Forwarded to Additional Payer(s)",
    allowsReconciliation: false,
    allowsPatientResponsibilityInvoice: false,
    reviewReason: "Stedi ERA says this is not the payer's claim and was forwarded; payer follow-up requires review.",
  },
  "25": {
    outcome: "complete",
    text: "Predetermination Pricing Only, No Payment",
    allowsReconciliation: false,
    allowsPatientResponsibilityInvoice: false,
    reviewReason: "Stedi ERA predetermination pricing only, no payment; review is required before any posting.",
  },
};

function adjustmentAmounts(adjustment: StediEraAdjustment): Array<{ reasonCode?: string; cents: number }> {
  const entries: Array<{ reasonCode?: string; cents: number }> = [];
  for (let slot = 1; slot <= 6; slot += 1) {
    const amount = optionalDecimalCents(adjustment[`adjustmentAmount${slot}` as keyof StediEraAdjustment]);
    if (amount === undefined) continue;
    const reasonCode = adjustment[`adjustmentReasonCode${slot}` as keyof StediEraAdjustment];
    entries.push({ ...(reasonCode ? { reasonCode } : {}), cents: amount });
  }
  return entries;
}

function adjustmentAdjudications(
  adjustments: StediEraAdjustment[] | undefined,
  prefix: "adjustment" | "claim adjustment",
): Array<NonNullable<ClaimResponse["item"]>[number]["adjudication"][number]> {
  return (adjustments ?? []).flatMap((adjustment) => adjustmentAmounts(adjustment).map(({ reasonCode, cents }) =>
    adjudication(
      [prefix, adjustment.claimAdjustmentGroupCode, reasonCode].filter(Boolean).join(" "),
      cents,
    )));
}

function optionalAdjudication(
  category: string,
  value: unknown,
): NonNullable<ClaimResponse["item"]>[number]["adjudication"][number] | undefined {
  const cents = optionalDecimalCents(value);
  return cents === undefined ? undefined : adjudication(category, cents);
}

function claimTotal(
  category: string,
  cents: number | undefined,
): NonNullable<ClaimResponse["total"]>[number] | undefined {
  return cents === undefined ? undefined : { category: { text: category }, amount: money(cents) };
}

function crossoverCarrierText(carrier: StediEraCrossoverCarrier | undefined): string | undefined {
  if (!carrier) return undefined;
  const values = [
    carrier.organizationName,
    carrier.payorId ? `payer ID ${carrier.payorId}` : undefined,
    carrier.blueCrossBlueShieldAssociationPlanCode ? `BCBS plan ${carrier.blueCrossBlueShieldAssociationPlanCode}` : undefined,
    carrier.centersForMedicareAndMedicaidServicesPlanId ? `CMS plan ${carrier.centersForMedicareAndMedicaidServicesPlanId}` : undefined,
    carrier.nationalAssociationOfInsuranceCommissionersIdentification
      ? `NAIC ${carrier.nationalAssociationOfInsuranceCommissionersIdentification}`
      : undefined,
    carrier.pharmacyProcessorNumber ? `pharmacy processor ${carrier.pharmacyProcessorNumber}` : undefined,
    carrier.taxId ? `tax ID ${carrier.taxId}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return values.length ? values.join(", ") : undefined;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
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

function optionalDecimalCents(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
}

function invalidAmountReviewReasons(claim: StediEraClaim): string[] {
  const invalidFields: string[] = [];
  const inspect = (field: string, value: unknown): void => {
    if (value !== undefined && value !== null && value !== "" && !Number.isFinite(Number(value))) {
      invalidFields.push(field);
    }
  };
  inspect("claimPaymentInfo.totalClaimChargeAmount", claim.claimPaymentInfo.totalClaimChargeAmount);
  inspect("claimPaymentInfo.claimPaymentAmount", claim.claimPaymentInfo.claimPaymentAmount);
  inspect("claimPaymentInfo.patientResponsibilityAmount", claim.claimPaymentInfo.patientResponsibilityAmount);
  for (const [adjustmentIndex, adjustment] of (claim.claimAdjustments ?? []).entries()) {
    for (let slot = 1; slot <= 6; slot += 1) {
      inspect(
        `claimAdjustments[${adjustmentIndex}].adjustmentAmount${slot}`,
        adjustment[`adjustmentAmount${slot}` as keyof StediEraAdjustment],
      );
    }
  }
  for (const [lineIndex, line] of (claim.serviceLines ?? []).entries()) {
    inspect(
      `serviceLines[${lineIndex}].servicePaymentInformation.lineItemChargeAmount`,
      line.servicePaymentInformation?.lineItemChargeAmount,
    );
    inspect(
      `serviceLines[${lineIndex}].servicePaymentInformation.lineItemProviderPaymentAmount`,
      line.servicePaymentInformation?.lineItemProviderPaymentAmount,
    );
    inspect(
      `serviceLines[${lineIndex}].serviceSupplementalAmounts.allowedActual`,
      line.serviceSupplementalAmounts?.allowedActual,
    );
    for (const [adjustmentIndex, adjustment] of (line.serviceAdjustments ?? []).entries()) {
      for (let slot = 1; slot <= 6; slot += 1) {
        inspect(
          `serviceLines[${lineIndex}].serviceAdjustments[${adjustmentIndex}].adjustmentAmount${slot}`,
          adjustment[`adjustmentAmount${slot}` as keyof StediEraAdjustment],
        );
      }
    }
  }
  return invalidFields.map((field) =>
    `Stedi ERA amount ${field} is not a finite decimal value and requires manual review.`);
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
