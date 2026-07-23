import type { Claim, ClaimResponse, CoverageEligibilityResponse, Money } from "@medplum/fhirtypes";
import {
  claimDiagnosisSequence,
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
    claimSupplementalInformation?: { claimControlNumber: string };
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

export const ODOS_STEDI_CLAIM_INPUT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-stedi-claim-input";

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

export type StediClaimResubmissionIntent = "correct" | "void";
export type StediPayerClassification = "confirmed-non-medicare" | "original-medicare";
export type StediClaimResubmissionDetermination =
  | {
      status: "ready";
      claimFrequencyCode: "1" | "7" | "8";
      claimControlNumber?: string;
    }
  | {
      status: "manual";
      reason: string;
      payerClaimControlNumber: string;
    };

export function determineStediClaimResubmission(input: {
  intent: StediClaimResubmissionIntent;
  payerClaimControlNumber?: string;
  payerClassification?: StediPayerClassification;
}): StediClaimResubmissionDetermination {
  const payerClaimControlNumber = input.payerClaimControlNumber?.trim();
  if (!payerClaimControlNumber) {
    return { status: "ready", claimFrequencyCode: "1" };
  }
  if (input.payerClassification !== "confirmed-non-medicare") {
    return {
      status: "manual",
      reason: input.payerClassification === "original-medicare"
        ? "Original Medicare adjudicated claims require payer-specific manual correction or reopening handling."
        : "Confirm that the adjudicated payer is not Original Medicare before ODOS can build a replacement or void claim.",
      payerClaimControlNumber,
    };
  }
  return {
    status: "ready",
    claimFrequencyCode: input.intent === "correct" ? "7" : "8",
    claimControlNumber: payerClaimControlNumber,
  };
}

export function withStediClaimInputSnapshot(claim: Claim, input: ProfessionalClaimInput): Claim {
  return {
    ...claim,
    extension: [
      ...(claim.extension ?? []).filter((extension) => extension.url !== ODOS_STEDI_CLAIM_INPUT_EXTENSION_URL),
      { url: ODOS_STEDI_CLAIM_INPUT_EXTENSION_URL, valueString: JSON.stringify(input) },
    ],
  };
}

export function stediClaimInputSnapshot(claim: Claim): ProfessionalClaimInput | undefined {
  const snapshot = claim.extension?.find((extension) =>
    extension.url === ODOS_STEDI_CLAIM_INPUT_EXTENSION_URL)?.valueString;
  if (!snapshot) return undefined;
  try {
    const parsed = JSON.parse(snapshot) as ProfessionalClaimInput;
    return parsed?.patientReference && Array.isArray(parsed.chargeItems) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface StediEraEnvelope {
  transactionId: string;
  payerName?: string;
  paymentDate: string;
  traceNumber?: string;
  claims: StediEraClaim[];
}

export type Stedi277Outcome = "accepted-for-processing" | "rejected" | "informational" | "review";

export interface Stedi277Status {
  categoryCode: string;
  categoryDescription?: string;
  statusCode?: string;
  statusDescription?: string;
  message?: string;
  entityType?: string;
}

export interface Stedi277Claim {
  patientControlNumber: string;
  outcome: Stedi277Outcome;
  statuses: Stedi277Status[];
  reasons: string[];
  sender: {
    organizationName?: string;
    entityType: "Payer" | "Clearinghouse" | "Unknown";
    identifier?: string;
  };
  traceIdentifiers: {
    transactionId: string;
    controlNumber?: string;
    referenceIdentification?: string;
    claimTransactionBatchNumber?: string;
    clearinghouseTraceNumber?: string;
    tradingPartnerClaimNumber?: string;
    metaTraceId?: string;
  };
}

export interface Stedi277Envelope {
  transactionId: string;
  claims: Stedi277Claim[];
  issues: string[];
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

export function readStedi277(raw: unknown, fallbackTransactionId: string): Stedi277Envelope {
  const root = recordOf(raw);
  if (!root || !Array.isArray(root.transactions)) {
    throw new Error("Stedi 277CA is malformed: transactions must be an array.");
  }
  const meta = recordOf(root.meta);
  const transactionId = textOf(meta?.transactionId) ?? fallbackTransactionId;
  const metaTraceId = textOf(meta?.traceId);
  const claims: Stedi277Claim[] = [];
  const issues: string[] = [];

  root.transactions.forEach((transactionValue, transactionIndex) => {
    const transaction = recordOf(transactionValue);
    if (!transaction) {
      issues.push(`Transaction ${transactionIndex + 1} is not an object.`);
      return;
    }
    const payers = arrayOfRecords(transaction.payers);
    if (payers.length === 0) {
      issues.push(`Transaction ${transactionIndex + 1} has no payer or clearinghouse sender.`);
      return;
    }
    payers.forEach((payer, payerIndex) => {
      const sender = stedi277Sender(payer);
      const statusTransactions = arrayOfRecords(payer.claimStatusTransactions);
      if (statusTransactions.length === 0) {
        issues.push(`Transaction ${transactionIndex + 1} sender ${payerIndex + 1} has no claim status transactions.`);
        return;
      }
      statusTransactions.forEach((statusTransaction, statusTransactionIndex) => {
        const claimDetails = arrayOfRecords(statusTransaction.claimStatusDetails);
        if (claimDetails.length === 0) {
          issues.push(`Transaction ${transactionIndex + 1} sender ${payerIndex + 1} status transaction ${statusTransactionIndex + 1} has no claim status details.`);
          return;
        }
        claimDetails.forEach((claimDetail, claimDetailIndex) => {
          const patientDetails = arrayOfRecords(claimDetail.patientClaimStatusDetails);
          if (patientDetails.length === 0) {
            issues.push(`Transaction ${transactionIndex + 1} sender ${payerIndex + 1} claim detail ${claimDetailIndex + 1} has no patient claim status details.`);
            return;
          }
          patientDetails.forEach((patientDetail, patientDetailIndex) => {
            const claimRows = arrayOfRecords(patientDetail.claims);
            if (claimRows.length === 0) {
              issues.push(`Transaction ${transactionIndex + 1} sender ${payerIndex + 1} patient detail ${patientDetailIndex + 1} has no claims.`);
              return;
            }
            claimRows.forEach((claimRow, claimIndex) => {
              const claimStatus = recordOf(claimRow.claimStatus);
              const patientControlNumber = textOf(claimStatus?.referencedTransactionTraceNumber)
                ?? textOf(claimStatus?.patientAccountNumber);
              const location = [
                transactionIndex + 1,
                payerIndex + 1,
                statusTransactionIndex + 1,
                claimDetailIndex + 1,
                patientDetailIndex + 1,
                claimIndex + 1,
              ].join(".");
              if (!claimStatus || !patientControlNumber) {
                issues.push(`Claim ${location} is missing its patient control number or claimStatus object.`);
                return;
              }
              const statuses = [...stedi277Statuses(claimStatus), ...stedi277ServiceStatuses(claimRow)];
              const outcome = interpretStedi277Statuses(statuses);
              const reasons = uniqueStrings(statuses.flatMap((status) => [
                status.message,
                status.statusDescription,
                outcome === "review" ? status.categoryDescription : undefined,
              ]));
              claims.push({
                patientControlNumber,
                outcome,
                statuses,
                reasons,
                sender: sender.entityType === "Unknown"
                  ? { ...sender, entityType: statusSenderType(statuses) }
                  : sender,
                traceIdentifiers: compactObject({
                  transactionId,
                  controlNumber: textOf(transaction.controlNumber),
                  referenceIdentification: textOf(transaction.referenceIdentification),
                  claimTransactionBatchNumber: textOf(statusTransaction.claimTransactionBatchNumber),
                  clearinghouseTraceNumber: textOf(claimStatus.clearinghouseTraceNumber),
                  tradingPartnerClaimNumber: textOf(claimStatus.tradingPartnerClaimNumber),
                  metaTraceId,
                }) as Stedi277Claim["traceIdentifiers"],
              });
            });
          });
        });
      });
    });
  });

  if (claims.length === 0 && issues.length === 0) {
    issues.push("The 277CA contains no claim acknowledgments.");
  }
  return { transactionId, claims, issues };
}

export function interpretStedi277CategoryCode(categoryCode: string): Stedi277Outcome {
  if (["A2", "A5"].includes(categoryCode)) return "accepted-for-processing";
  if (["A3", "A6", "A7", "A8"].includes(categoryCode)) return "rejected";
  if (["A0", "A1"].includes(categoryCode)) return "informational";
  return "review";
}

function interpretStedi277Statuses(statuses: Stedi277Status[]): Stedi277Outcome {
  const outcomes = statuses.map((status) => interpretStedi277CategoryCode(status.categoryCode));
  if (outcomes.includes("rejected")) return "rejected";
  if (outcomes.includes("review") || outcomes.length === 0) return "review";
  if (outcomes.includes("accepted-for-processing")) return "accepted-for-processing";
  return "informational";
}

function stedi277Statuses(claimStatus: Record<string, unknown>): Stedi277Status[] {
  const claimStatuses = arrayOfRecords(claimStatus.informationClaimStatuses).flatMap((group) => {
    const message = textOf(group.statusMessage);
    return arrayOfRecords(group.informationStatuses).map((status) => stedi277Status(status, message));
  });
  return claimStatuses;
}

function stedi277ServiceStatuses(claimRow: Record<string, unknown>): Stedi277Status[] {
  return arrayOfRecords(claimRow.serviceLines).flatMap((serviceLine) =>
    arrayOfRecords(serviceLine.serviceClaimStatuses).flatMap((group) =>
      arrayOfRecords(group.serviceStatuses).map((status) => stedi277Status(status, undefined))));
}

function stedi277Status(status: Record<string, unknown>, message: string | undefined): Stedi277Status {
  const categoryDescription = textOf(status.healthCareClaimStatusCategoryCodeValue);
  const statusCode = textOf(status.statusCode);
  const statusDescription = textOf(status.statusCodeValue);
  const entityType = textOf(status.entityIdentifierCodeValue);
  return {
    categoryCode: textOf(status.healthCareClaimStatusCategoryCode) ?? "",
    ...(categoryDescription ? { categoryDescription } : {}),
    ...(statusCode ? { statusCode } : {}),
    ...(statusDescription ? { statusDescription } : {}),
    ...(message ? { message } : {}),
    ...(entityType ? { entityType } : {}),
  };
}

function stedi277Sender(payer: Record<string, unknown>): Stedi277Claim["sender"] {
  const rawType = textOf(payer.entityIdentifierCodeValue) ?? textOf(payer.entityIdentifierCode);
  return compactObject({
    organizationName: textOf(payer.organizationName),
    entityType: normalizeSenderType(rawType),
    identifier: textOf(payer.payerIdentification) ?? textOf(payer.etin),
  }) as Stedi277Claim["sender"];
}

function statusSenderType(statuses: Stedi277Status[]): Stedi277Claim["sender"]["entityType"] {
  for (const status of statuses) {
    const normalized = normalizeSenderType(status.entityType);
    if (normalized !== "Unknown") return normalized;
  }
  return "Unknown";
}

function normalizeSenderType(value: string | undefined): Stedi277Claim["sender"]["entityType"] {
  if (value === "Payer" || value === "PR") return "Payer";
  if (value === "Clearinghouse" || value === "AY") return "Clearinghouse";
  return "Unknown";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(recordOf).filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
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
  const claimFrequencyCode = input.claimFrequencyCode ?? "1";
  const claimControlNumber = input.claimControlNumber?.trim();
  if (claimFrequencyCode !== "1" && claimFrequencyCode !== "7" && claimFrequencyCode !== "8") {
    throw new ClaimSubmissionValidationError("Stedi claim frequency code must be 1, 7, or 8.");
  }
  if ((claimFrequencyCode === "7" || claimFrequencyCode === "8") && !claimControlNumber) {
    throw new ClaimSubmissionValidationError("Stedi replacement and void claims require a payer claim control number.");
  }
  if (claimFrequencyCode === "1" && claimControlNumber) {
    throw new ClaimSubmissionValidationError("Stedi original claims cannot include a payer claim control number.");
  }
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
      claimFrequencyCode,
      placeOfServiceCode: "11",
      planParticipationCode: "A",
      benefitsAssignmentCertificationIndicator: "Y",
      releaseInformationCode: "Y",
      signatureIndicator: "Y",
      ...(claimControlNumber ? {
        claimSupplementalInformation: { claimControlNumber },
      } : {}),
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
            compositeDiagnosisCodePointers: {
              diagnosisCodePointers: claimDiagnosisSequence(item, input.diagnoses.length)
                .map(String),
            },
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
