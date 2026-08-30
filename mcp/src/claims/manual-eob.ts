import type { Basic, Extension } from "@medplum/fhirtypes";

export const REMITTANCE_BATCH_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/odos-remittance";
export const REMITTANCE_BATCH_CODE = "remittance-batch";
export const REMITTANCE_BATCH_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/remittance-batch";
export const REMITTANCE_BATCH_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-remittance-batch";
export const PROVIDER_ADJUSTMENT_CODE = "provider-level-adjustment";
export const PROVIDER_ADJUSTMENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/provider-level-adjustment";
export const PROVIDER_ADJUSTMENT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-provider-level-adjustment";

export type RemittanceProvenance = "clearinghouse" | "paper" | "fax" | "manual";
export type AllocationOrigin = "machine-proposed" | "human-entered";

export interface RemittanceBatchInput {
  payerReference: string;
  paymentReference: string;
  remittanceDate?: string;
  creationDate: string;
  totalAmountCents: number;
  provenance: RemittanceProvenance;
  sourceReference: string;
  status?: ManualEobStatus;
  depositDate?: string;
}

export interface RemittanceAllocation {
  id: string;
  claimReference: string;
  claimResponseReference?: string;
  paymentReconciliationReference?: string;
  amountCents: number;
  origin: AllocationOrigin;
  confidence?: number;
  recordedAt: string;
  reversalOfAllocationId?: string;
  reversalOfBatchReference?: string;
}

export interface RemittanceBatch extends RemittanceBatchInput {
  id: string;
  status: ManualEobStatus;
  allocations: RemittanceAllocation[];
}

export interface ProviderAdjustmentInput {
  batchReference: string;
  payerReference: string;
  identifier: string;
  reasonCode?: string;
  reasonText: string;
  rawSourceAmountCents: number;
  sourceSystem: "stedi-835" | "manual-ledger";
  createdAt: string;
  claimReference?: never;
}

export interface ProviderAdjustment extends ProviderAdjustmentInput {
  id: string;
  amountCents: number;
}

export interface RemittanceBatchProjection extends RemittanceBatch {
  claimActivityCents: number;
  providerActivityCents: number;
  accountedAmountCents: number;
  unallocatedAmountCents: number;
  balanced: boolean;
  ageDays: number;
}

export function buildRemittanceBatch(input: RemittanceBatchInput): Basic {
  validateRemittanceBatchInput(input);
  return remittanceBatchResource(input, []);
}

export function appendRemittanceAllocation(basic: Basic, allocation: RemittanceAllocation): Basic {
  const batch = parseRemittanceBatch(basic);
  validateAllocation(allocation);
  if (batch.allocations.some((entry) => entry.id === allocation.id)) {
    throw new ManualEobValidationError(`Allocation ${allocation.id} already exists on this remittance batch.`);
  }
  if (allocation.reversalOfBatchReference) {
    validateExternalReversal(allocation);
  } else if (allocation.reversalOfAllocationId) {
    validateReversal(batch.allocations, allocation);
  }
  return remittanceBatchResource(batch, [...batch.allocations, allocation], basic);
}

export function reverseRemittanceAllocation(
  basic: Basic,
  input: { allocationId: string; reversalAllocationId: string; recordedAt: string },
): Basic {
  const batch = parseRemittanceBatch(basic);
  const original = batch.allocations.find((entry) => entry.id === input.allocationId);
  if (!original) {
    throw new ManualEobValidationError(`Allocation ${input.allocationId} does not exist on this remittance batch.`);
  }
  if (original.reversalOfAllocationId) {
    throw new ManualEobValidationError("A reversal allocation cannot itself be reversed.");
  }
  if (batch.allocations.some((entry) => entry.reversalOfAllocationId === original.id)) {
    throw new ManualEobValidationError(`Allocation ${original.id} is already reversed.`);
  }
  return appendRemittanceAllocation(basic, {
    id: input.reversalAllocationId,
    claimReference: original.claimReference,
    ...(original.claimResponseReference
      ? { claimResponseReference: original.claimResponseReference }
      : {}),
    ...(original.paymentReconciliationReference
      ? { paymentReconciliationReference: original.paymentReconciliationReference }
      : {}),
    amountCents: -original.amountCents,
    origin: "human-entered",
    recordedAt: input.recordedAt,
    reversalOfAllocationId: original.id,
  });
}

export function parseRemittanceBatch(basic: Basic): RemittanceBatch {
  const code = basic.code?.coding?.find(
    (coding) => coding.system === REMITTANCE_BATCH_CODE_SYSTEM && coding.code === REMITTANCE_BATCH_CODE,
  );
  if (!code) throw new ManualEobValidationError("Basic resource is not an ODOS remittance batch.");
  if (!basic.id) throw new ManualEobValidationError("Remittance batch is missing its id.");
  const values = basic.extension?.find((entry) => entry.url === REMITTANCE_BATCH_EXTENSION_URL)?.extension;
  if (!values) throw new ManualEobValidationError("Remittance batch extension is missing.");
  const payerReference = requiredExtension(values, "payer").valueReference?.reference;
  const paymentReference = requiredExtension(values, "payment-reference").valueString;
  const remittanceDate = values.find((entry) => entry.url === "remittance-date")?.valueDate;
  const creationDate = requiredExtension(values, "creation-date").valueDateTime;
  const provenance = requiredExtension(values, "provenance").valueCode;
  const sourceReference = requiredExtension(values, "source-reference").valueUri;
  if (!payerReference || !paymentReference || !creationDate || !sourceReference) {
    throw new ManualEobValidationError("Remittance batch contains an incomplete required field.");
  }
  if (!isRemittanceProvenance(provenance)) {
    throw new ManualEobValidationError("Remittance batch provenance is invalid.");
  }
  const parsed: RemittanceBatch = {
    id: basic.id,
    payerReference,
    paymentReference,
    ...(remittanceDate ? { remittanceDate } : {}),
    creationDate,
    totalAmountCents: moneyToCents(requiredExtension(values, "total-amount").valueMoney?.value),
    provenance,
    sourceReference,
    status: parseRemittanceStatus(values),
    ...(values.find((entry) => entry.url === "deposit-date")?.valueDate
      ? { depositDate: values.find((entry) => entry.url === "deposit-date")!.valueDate }
      : {}),
    allocations: values.filter((entry) => entry.url === "allocation").map(parseAllocation),
  };
  validateRemittanceBatchInput(parsed);
  const seenIds = new Set<string>();
  for (const allocation of parsed.allocations) {
    validateAllocation(allocation);
    if (seenIds.has(allocation.id)) {
      throw new ManualEobValidationError(`Allocation ${allocation.id} is duplicated.`);
    }
    if (allocation.reversalOfBatchReference) {
      validateExternalReversal(allocation);
    } else if (allocation.reversalOfAllocationId) {
      validateReversal(parsed.allocations, allocation);
    }
    seenIds.add(allocation.id);
  }
  return parsed;
}

export function buildProviderAdjustment(input: ProviderAdjustmentInput): Basic {
  if ((input as ProviderAdjustmentInput & { claimReference?: string }).claimReference) {
    throw new ManualEobValidationError("A provider-level adjustment cannot be posted as a claim-level event.");
  }
  validateReference(input.batchReference, "Basic", "batchReference");
  validateReference(input.payerReference, "Organization", "payerReference");
  if (!input.identifier.trim()) throw new ManualEobValidationError("provider adjustment identifier is required.");
  if (!input.reasonText.trim()) throw new ManualEobValidationError("provider adjustment reasonText is required.");
  signedCents(input.rawSourceAmountCents, "rawSourceAmountCents");
  if (input.sourceSystem !== "stedi-835" && input.sourceSystem !== "manual-ledger") {
    throw new ManualEobValidationError("provider adjustment sourceSystem is invalid.");
  }
  if (!input.createdAt) throw new ManualEobValidationError("provider adjustment createdAt is required.");
  const amountCents = input.sourceSystem === "stedi-835"
    ? -input.rawSourceAmountCents
    : input.rawSourceAmountCents;
  return {
    resourceType: "Basic",
    identifier: [{ system: PROVIDER_ADJUSTMENT_IDENTIFIER_SYSTEM, value: input.identifier }],
    code: {
      coding: [{
        system: REMITTANCE_BATCH_CODE_SYSTEM,
        code: PROVIDER_ADJUSTMENT_CODE,
        display: "ODOS provider-level adjustment",
      }],
      text: "Provider-level adjustment",
    },
    extension: [{
      url: PROVIDER_ADJUSTMENT_EXTENSION_URL,
      extension: [
        { url: "batch", valueReference: { reference: input.batchReference } },
        { url: "payer", valueReference: { reference: input.payerReference } },
        { url: "identifier", valueString: input.identifier },
        ...(input.reasonCode ? [{ url: "reason-code", valueCode: input.reasonCode }] : []),
        { url: "reason-text", valueString: input.reasonText },
        { url: "raw-source-amount", valueMoney: money(input.rawSourceAmountCents) },
        { url: "amount", valueMoney: money(amountCents) },
        { url: "source-system", valueCode: input.sourceSystem },
        { url: "created-at", valueDateTime: input.createdAt },
      ],
    }],
  };
}

export function parseProviderAdjustment(basic: Basic): ProviderAdjustment {
  const code = basic.code?.coding?.find(
    (coding) => coding.system === REMITTANCE_BATCH_CODE_SYSTEM && coding.code === PROVIDER_ADJUSTMENT_CODE,
  );
  if (!code) throw new ManualEobValidationError("Basic resource is not an ODOS provider-level adjustment.");
  if (!basic.id) throw new ManualEobValidationError("Provider-level adjustment is missing its id.");
  const values = basic.extension?.find((entry) => entry.url === PROVIDER_ADJUSTMENT_EXTENSION_URL)?.extension;
  if (!values) throw new ManualEobValidationError("Provider-level adjustment extension is missing.");
  const batchReference = requiredExtension(values, "batch").valueReference?.reference;
  const payerReference = requiredExtension(values, "payer").valueReference?.reference;
  const identifier = requiredExtension(values, "identifier").valueString;
  const reasonCode = values.find((entry) => entry.url === "reason-code")?.valueCode;
  const reasonText = requiredExtension(values, "reason-text").valueString;
  const sourceSystem = requiredExtension(values, "source-system").valueCode;
  const createdAt = requiredExtension(values, "created-at").valueDateTime;
  if (!batchReference || !payerReference || !identifier || !reasonText || !createdAt) {
    throw new ManualEobValidationError("Provider-level adjustment contains an incomplete required field.");
  }
  if (sourceSystem !== "stedi-835" && sourceSystem !== "manual-ledger") {
    throw new ManualEobValidationError("Provider-level adjustment sourceSystem is invalid.");
  }
  const rawSourceAmountCents = moneyToCents(
    requiredExtension(values, "raw-source-amount").valueMoney?.value,
  );
  const amountCents = moneyToCents(requiredExtension(values, "amount").valueMoney?.value);
  const expectedAmountCents = sourceSystem === "stedi-835"
    ? -rawSourceAmountCents
    : rawSourceAmountCents;
  if (amountCents !== expectedAmountCents) {
    throw new ManualEobValidationError("Provider-level adjustment sign normalization is inconsistent.");
  }
  return {
    id: basic.id,
    batchReference,
    payerReference,
    identifier,
    ...(reasonCode ? { reasonCode } : {}),
    reasonText,
    rawSourceAmountCents,
    sourceSystem,
    createdAt,
    amountCents,
  };
}

export function projectRemittanceBatch(
  basic: Basic,
  adjustmentResources: readonly Basic[],
  asOf: string,
): RemittanceBatchProjection {
  const batch = parseRemittanceBatch(basic);
  const adjustments = adjustmentResources.map(parseProviderAdjustment);
  for (const adjustment of adjustments) {
    if (adjustment.batchReference !== `Basic/${batch.id}`) {
      throw new ManualEobValidationError("Provider-level adjustment belongs to a different remittance batch.");
    }
    if (adjustment.payerReference !== batch.payerReference) {
      throw new ManualEobValidationError("Provider-level adjustment payer does not match the remittance batch.");
    }
  }
  const claimActivityCents = batch.allocations.reduce((sum, entry) => sum + entry.amountCents, 0);
  const providerActivityCents = adjustments.reduce((sum, entry) => sum + entry.amountCents, 0);
  const accountedAmountCents = claimActivityCents + providerActivityCents;
  const unallocatedAmountCents = batch.totalAmountCents - accountedAmountCents;
  const ageBasis = batch.remittanceDate
    ? `${batch.remittanceDate}T00:00:00.000Z`
    : batch.creationDate;
  const asOfMillis = Date.parse(asOf);
  const ageBasisMillis = Date.parse(ageBasis);
  if (!Number.isFinite(asOfMillis) || !Number.isFinite(ageBasisMillis)) {
    throw new ManualEobValidationError("Remittance batch age requires valid dates.");
  }
  return {
    ...batch,
    claimActivityCents,
    providerActivityCents,
    accountedAmountCents,
    unallocatedAmountCents,
    balanced: unallocatedAmountCents === 0,
    ageDays: Math.max(0, Math.floor((asOfMillis - ageBasisMillis) / 86_400_000)),
  };
}

function remittanceBatchResource(
  input: RemittanceBatchInput,
  allocations: readonly RemittanceAllocation[],
  existing?: Basic,
): Basic {
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: REMITTANCE_BATCH_IDENTIFIER_SYSTEM, value: input.paymentReference }],
    code: {
      coding: [{ system: REMITTANCE_BATCH_CODE_SYSTEM, code: REMITTANCE_BATCH_CODE, display: "ODOS remittance batch" }],
      text: "Remittance batch",
    },
    extension: [{
      url: REMITTANCE_BATCH_EXTENSION_URL,
      extension: [
        { url: "payer", valueReference: { reference: input.payerReference } },
        { url: "payment-reference", valueString: input.paymentReference },
        ...(input.remittanceDate ? [{ url: "remittance-date", valueDate: input.remittanceDate }] : []),
        { url: "creation-date", valueDateTime: input.creationDate },
        { url: "total-amount", valueMoney: money(input.totalAmountCents) },
        { url: "provenance", valueCode: input.provenance },
        { url: "source-reference", valueUri: input.sourceReference },
        { url: "status", valueCode: input.status ?? "draft" },
        ...(input.depositDate ? [{ url: "deposit-date", valueDate: input.depositDate }] : []),
        ...allocations.map(allocationExtension),
      ],
    }],
  };
}

function allocationExtension(allocation: RemittanceAllocation): Extension {
  return {
    url: "allocation",
    extension: [
      { url: "id", valueString: allocation.id },
      { url: "claim", valueReference: { reference: allocation.claimReference } },
      ...(allocation.claimResponseReference
        ? [{ url: "claim-response", valueReference: { reference: allocation.claimResponseReference } }]
        : []),
      ...(allocation.paymentReconciliationReference
        ? [{
            url: "payment-reconciliation",
            valueReference: { reference: allocation.paymentReconciliationReference },
          }]
        : []),
      { url: "amount", valueMoney: money(allocation.amountCents) },
      { url: "origin", valueCode: allocation.origin },
      ...(allocation.confidence === undefined
        ? []
        : [{ url: "confidence", valueDecimal: allocation.confidence }]),
      { url: "recorded-at", valueDateTime: allocation.recordedAt },
      ...(allocation.reversalOfAllocationId
        ? [{ url: "reversal-of", valueString: allocation.reversalOfAllocationId }]
        : []),
      ...(allocation.reversalOfBatchReference
        ? [{ url: "reversal-of-batch", valueReference: { reference: allocation.reversalOfBatchReference } }]
        : []),
    ],
  };
}

function parseAllocation(extension: Extension): RemittanceAllocation {
  const values = extension.extension;
  if (!values) throw new ManualEobValidationError("Remittance allocation extension is incomplete.");
  const id = requiredExtension(values, "id").valueString;
  const claimReference = requiredExtension(values, "claim").valueReference?.reference;
  const claimResponseReference = values.find((entry) => entry.url === "claim-response")?.valueReference?.reference;
  const paymentReconciliationReference = values.find(
    (entry) => entry.url === "payment-reconciliation",
  )?.valueReference?.reference;
  const origin = requiredExtension(values, "origin").valueCode;
  const confidence = values.find((entry) => entry.url === "confidence")?.valueDecimal;
  const recordedAt = requiredExtension(values, "recorded-at").valueDateTime;
  const reversalOfAllocationId = values.find((entry) => entry.url === "reversal-of")?.valueString;
  const reversalOfBatchReference = values.find(
    (entry) => entry.url === "reversal-of-batch",
  )?.valueReference?.reference;
  if (!id || !claimReference || !isAllocationOrigin(origin) || !recordedAt) {
    throw new ManualEobValidationError("Remittance allocation contains an incomplete required field.");
  }
  return {
    id,
    claimReference,
    ...(claimResponseReference ? { claimResponseReference } : {}),
    ...(paymentReconciliationReference ? { paymentReconciliationReference } : {}),
    amountCents: moneyToCents(requiredExtension(values, "amount").valueMoney?.value),
    origin,
    ...(confidence === undefined ? {} : { confidence }),
    recordedAt,
    ...(reversalOfAllocationId ? { reversalOfAllocationId } : {}),
    ...(reversalOfBatchReference ? { reversalOfBatchReference } : {}),
  };
}

function validateRemittanceBatchInput(input: RemittanceBatchInput): void {
  validateReference(input.payerReference, "Organization", "payerReference");
  if (!input.paymentReference.trim()) throw new ManualEobValidationError("paymentReference is required.");
  if (input.remittanceDate) r4Date(input.remittanceDate, "remittanceDate");
  if (!Number.isFinite(Date.parse(input.creationDate))) {
    throw new ManualEobValidationError("creationDate must be a valid dateTime.");
  }
  integerCents(input.totalAmountCents, "totalAmountCents");
  if (!isRemittanceProvenance(input.provenance)) {
    throw new ManualEobValidationError("provenance is invalid.");
  }
  if (!input.sourceReference.trim()) throw new ManualEobValidationError("sourceReference is required.");
  if (input.status && input.status !== "draft" && input.status !== "closed") {
    throw new ManualEobValidationError("status must be draft or closed.");
  }
  if (input.depositDate) r4Date(input.depositDate, "depositDate");
}

function validateAllocation(allocation: RemittanceAllocation): void {
  if (!/^[A-Za-z0-9.-]+$/.test(allocation.id)) {
    throw new ManualEobValidationError("allocation id is invalid.");
  }
  validateReference(allocation.claimReference, "Claim", "claimReference");
  if (allocation.claimResponseReference) {
    validateReference(allocation.claimResponseReference, "ClaimResponse", "claimResponseReference");
  }
  if (allocation.paymentReconciliationReference) {
    validateReference(
      allocation.paymentReconciliationReference,
      "PaymentReconciliation",
      "paymentReconciliationReference",
    );
  }
  signedCents(allocation.amountCents, "allocation amountCents");
  if (!isAllocationOrigin(allocation.origin)) {
    throw new ManualEobValidationError("allocation origin is invalid.");
  }
  if (allocation.origin === "machine-proposed") {
    if (allocation.confidence === undefined || allocation.confidence < 0 || allocation.confidence > 1) {
      throw new ManualEobValidationError("machine-proposed allocation confidence must be between 0 and 1.");
    }
  } else if (allocation.confidence !== undefined) {
    throw new ManualEobValidationError("human-entered allocations cannot carry machine confidence.");
  }
  if (!Number.isFinite(Date.parse(allocation.recordedAt))) {
    throw new ManualEobValidationError("allocation recordedAt must be a valid dateTime.");
  }
  if (allocation.reversalOfBatchReference && !allocation.reversalOfAllocationId) {
    throw new ManualEobValidationError("External reversal must identify both its batch and allocation.");
  }
}

function validateReversal(
  allocations: readonly RemittanceAllocation[],
  reversal: RemittanceAllocation,
): void {
  const original = allocations.find((entry) => entry.id === reversal.reversalOfAllocationId);
  if (!original) throw new ManualEobValidationError("Reversal allocation does not identify an existing allocation.");
  if (original.reversalOfAllocationId) {
    throw new ManualEobValidationError("A reversal allocation cannot itself be reversed.");
  }
  if (reversal.amountCents !== -original.amountCents) {
    throw new ManualEobValidationError("Reversal allocation must exactly negate the original amount.");
  }
  if (reversal.claimReference !== original.claimReference) {
    throw new ManualEobValidationError("Reversal allocation must retain the original claim lineage.");
  }
  const duplicate = allocations.some(
    (entry) => entry.id !== reversal.id && entry.reversalOfAllocationId === original.id,
  );
  if (duplicate) throw new ManualEobValidationError(`Allocation ${original.id} is already reversed.`);
}

function validateExternalReversal(reversal: RemittanceAllocation): void {
  if (!reversal.reversalOfAllocationId || !reversal.reversalOfBatchReference) {
    throw new ManualEobValidationError("External reversal must identify both its batch and allocation.");
  }
  validateReference(reversal.reversalOfBatchReference, "Basic", "reversalOfBatchReference");
  if (reversal.origin !== "machine-proposed") {
    throw new ManualEobValidationError("Imported cross-batch reversals must retain machine provenance.");
  }
}

function isRemittanceProvenance(value: string | undefined): value is RemittanceProvenance {
  return value === "clearinghouse" || value === "paper" || value === "fax" || value === "manual";
}

function isAllocationOrigin(value: string | undefined): value is AllocationOrigin {
  return value === "machine-proposed" || value === "human-entered";
}

function parseRemittanceStatus(values: readonly Extension[]): ManualEobStatus {
  const status = requiredExtension(values, "status").valueCode;
  if (status !== "draft" && status !== "closed") {
    throw new ManualEobValidationError("Remittance batch status must be draft or closed.");
  }
  return status;
}

function signedCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value === 0) {
    throw new ManualEobValidationError(`${field} must be a non-zero integer number of cents.`);
  }
}

function integerCents(value: number, field: string): void {
  if (!Number.isInteger(value)) {
    throw new ManualEobValidationError(`${field} must be an integer number of cents.`);
  }
}

const LEGACY_MANUAL_EOB_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/odos-manual-eob";
const LEGACY_MANUAL_EOB_CODE = "odos-manual-eob";
const LEGACY_MANUAL_EOB_HEADER_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-manual-eob-header";
export const MANUAL_EOB_CODE_SYSTEM = REMITTANCE_BATCH_CODE_SYSTEM;
export const MANUAL_EOB_CODE = REMITTANCE_BATCH_CODE;
export const MANUAL_EOB_IDENTIFIER_SYSTEM = REMITTANCE_BATCH_IDENTIFIER_SYSTEM;
export const MANUAL_EOB_HEADER_EXTENSION_URL = REMITTANCE_BATCH_EXTENSION_URL;

export type ManualEobStatus = "draft" | "closed";

export interface ManualEobPosting {
  claimReference: string;
  claimResponseReference: string;
  paymentReconciliationReference: string;
  amountCents: number;
  postedAt: string;
}

export interface ManualEobHeaderInput {
  payerReference: string;
  paymentReference: string;
  paymentDate: string;
  depositDate: string;
  totalAmountCents: number;
  createdAt: string;
  provenance?: "clearinghouse" | "paper" | "fax" | "manual";
  sourceReference?: string;
}

export interface ManualEobHeader extends ManualEobHeaderInput {
  id: string;
  status: ManualEobStatus;
  appliedAmountCents: number;
  remainingAmountCents: number;
  postings: ManualEobPosting[];
}

export class ManualEobValidationError extends Error {}

export function buildManualEobHeader(input: ManualEobHeaderInput): Basic {
  validateHeaderInput(input);
  return buildRemittanceBatch({
    payerReference: input.payerReference,
    paymentReference: input.paymentReference,
    remittanceDate: input.paymentDate,
    creationDate: input.createdAt,
    totalAmountCents: input.totalAmountCents,
    provenance: input.provenance ?? "manual",
    sourceReference: input.sourceReference ?? `urn:odos:manual-eob:${input.paymentReference}`,
    status: "draft",
    depositDate: input.depositDate,
  });
}

export function appendManualEobPosting(basic: Basic, posting: ManualEobPosting): Basic {
  const header = parseManualEobHeader(basic);
  if (header.status !== "draft") {
    throw new ManualEobValidationError("Only a draft manual EOB can receive claim postings.");
  }
  if (header.postings.some((entry) => entry.claimReference === posting.claimReference)) {
    throw new ManualEobValidationError(`${posting.claimReference} is already posted on this manual EOB.`);
  }
  validateReference(posting.claimReference, "Claim", "claimReference");
  validateReference(posting.claimResponseReference, "ClaimResponse", "claimResponseReference");
  validateReference(
    posting.paymentReconciliationReference,
    "PaymentReconciliation",
    "paymentReconciliationReference",
  );
  positiveCents(posting.amountCents, "posting amountCents");
  if (!posting.postedAt) throw new ManualEobValidationError("posting postedAt is required.");

  const appliedAmountCents = header.appliedAmountCents + posting.amountCents;
  if (appliedAmountCents > header.totalAmountCents) {
    throw new ManualEobValidationError("Posting amount exceeds the manual EOB remaining amount.");
  }
  if (isGenericRemittanceBatch(basic)) {
    return appendRemittanceAllocation(basic, {
      id: allocationIdFromPosting(posting),
      claimReference: posting.claimReference,
      claimResponseReference: posting.claimResponseReference,
      paymentReconciliationReference: posting.paymentReconciliationReference,
      amountCents: posting.amountCents,
      origin: "human-entered",
      recordedAt: posting.postedAt,
    });
  }
  return headerResource(header, "draft", [...header.postings, posting], appliedAmountCents, basic);
}

export function closeManualEobHeader(basic: Basic): Basic {
  const header = parseManualEobHeader(basic);
  if (header.status === "closed") return basic;
  if (isGenericRemittanceBatch(basic)) {
    const batch = parseRemittanceBatch(basic);
    return remittanceBatchResource({ ...batch, status: "closed" }, batch.allocations, basic);
  }
  return headerResource(header, "closed", header.postings, header.appliedAmountCents, basic);
}

export function parseManualEobHeader(basic: Basic): ManualEobHeader {
  if (isGenericRemittanceBatch(basic)) {
    const batch = parseRemittanceBatch(basic);
    const postings = batch.allocations.map((allocation) => {
      if (!allocation.claimResponseReference || !allocation.paymentReconciliationReference) {
        throw new ManualEobValidationError("Manual remittance allocation is missing posting references.");
      }
      return {
        claimReference: allocation.claimReference,
        claimResponseReference: allocation.claimResponseReference,
        paymentReconciliationReference: allocation.paymentReconciliationReference,
        amountCents: allocation.amountCents,
        postedAt: allocation.recordedAt,
      };
    });
    const appliedAmountCents = postings.reduce((sum, posting) => sum + posting.amountCents, 0);
    return {
      id: batch.id,
      payerReference: batch.payerReference,
      paymentReference: batch.paymentReference,
      paymentDate: batch.remittanceDate ?? batch.creationDate.slice(0, 10),
      depositDate: batch.depositDate ?? batch.remittanceDate ?? batch.creationDate.slice(0, 10),
      totalAmountCents: batch.totalAmountCents,
      createdAt: batch.creationDate,
      provenance: batch.provenance,
      sourceReference: batch.sourceReference,
      status: batch.status,
      appliedAmountCents,
      remainingAmountCents: batch.totalAmountCents - appliedAmountCents,
      postings,
    };
  }
  return parseLegacyManualEobHeader(basic);
}

function parseLegacyManualEobHeader(basic: Basic): ManualEobHeader {
  const code = basic.code?.coding?.find((coding) =>
    coding.system === LEGACY_MANUAL_EOB_CODE_SYSTEM && coding.code === LEGACY_MANUAL_EOB_CODE,
  );
  if (!code) throw new ManualEobValidationError("Basic resource is not an ODOS manual EOB header.");
  if (!basic.id) throw new ManualEobValidationError("Manual EOB header is missing its id.");
  const values = basic.extension?.find((extension) => extension.url === LEGACY_MANUAL_EOB_HEADER_EXTENSION_URL)?.extension;
  if (!values) throw new ManualEobValidationError("Manual EOB header extension is missing.");

  const payerReference = requiredExtension(values, "payer").valueReference?.reference;
  const paymentReference = requiredExtension(values, "payment-reference").valueString;
  const paymentDate = requiredExtension(values, "payment-date").valueDate;
  const depositDate = requiredExtension(values, "deposit-date").valueDate;
  const totalAmountCents = moneyToCents(requiredExtension(values, "total-amount").valueMoney?.value);
  const appliedAmountCents = moneyToCents(requiredExtension(values, "applied-amount").valueMoney?.value);
  const status = requiredExtension(values, "status").valueCode;
  const createdAt = requiredExtension(values, "created-at").valueDateTime;
  if (!payerReference || !paymentReference || !paymentDate || !depositDate || !createdAt) {
    throw new ManualEobValidationError("Manual EOB header contains an incomplete required field.");
  }
  if (status !== "draft" && status !== "closed") {
    throw new ManualEobValidationError("Manual EOB status must be draft or closed.");
  }
  const postings = values
    .filter((extension) => extension.url === "posting")
    .map(parsePosting);
  const postingTotalCents = postings.reduce((sum, posting) => sum + posting.amountCents, 0);
  if (postingTotalCents !== appliedAmountCents) {
    throw new ManualEobValidationError("Manual EOB applied amount does not match its persisted postings.");
  }
  if (appliedAmountCents > totalAmountCents) {
    throw new ManualEobValidationError("Manual EOB applied amount exceeds its total amount.");
  }

  return {
    id: basic.id,
    payerReference,
    paymentReference,
    paymentDate,
    depositDate,
    totalAmountCents,
    appliedAmountCents,
    remainingAmountCents: totalAmountCents - appliedAmountCents,
    status,
    createdAt,
    postings,
  };
}

function isGenericRemittanceBatch(basic: Basic): boolean {
  return basic.code?.coding?.some((coding) =>
    coding.system === REMITTANCE_BATCH_CODE_SYSTEM && coding.code === REMITTANCE_BATCH_CODE,
  ) ?? false;
}

function allocationIdFromPosting(posting: ManualEobPosting): string {
  return `manual-${posting.claimResponseReference.slice("ClaimResponse/".length)}`;
}

function headerResource(
  input: ManualEobHeaderInput,
  status: ManualEobStatus,
  postings: readonly ManualEobPosting[],
  appliedAmountCents: number,
  existing?: Basic,
): Basic {
  const extension: Extension[] = [
    { url: "payer", valueReference: { reference: input.payerReference } },
    { url: "payment-reference", valueString: input.paymentReference },
    { url: "payment-date", valueDate: input.paymentDate },
    { url: "remittance-date", valueDate: input.paymentDate },
    { url: "deposit-date", valueDate: input.depositDate },
    { url: "total-amount", valueMoney: money(input.totalAmountCents) },
    { url: "applied-amount", valueMoney: money(appliedAmountCents) },
    { url: "status", valueCode: status },
    { url: "created-at", valueDateTime: input.createdAt },
    { url: "provenance", valueCode: input.provenance ?? "manual" },
    { url: "source-reference", valueUri: input.sourceReference ?? `urn:odos:manual-eob:${input.paymentReference}` },
    ...postings.map((posting) => ({
      url: "posting",
      extension: [
        { url: "claim", valueReference: { reference: posting.claimReference } },
        { url: "claim-response", valueReference: { reference: posting.claimResponseReference } },
        {
          url: "payment-reconciliation",
          valueReference: { reference: posting.paymentReconciliationReference },
        },
        { url: "amount", valueMoney: money(posting.amountCents) },
        { url: "posted-at", valueDateTime: posting.postedAt },
      ],
    })),
  ];
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: "https://odos2020.com/fhir/NamingSystem/manual-eob", value: input.paymentReference }],
    code: {
      coding: [{ system: LEGACY_MANUAL_EOB_CODE_SYSTEM, code: LEGACY_MANUAL_EOB_CODE, display: "ODOS manual EOB" }],
      text: "Manual EOB",
    },
    extension: [{ url: LEGACY_MANUAL_EOB_HEADER_EXTENSION_URL, extension }],
  };
}

function parsePosting(extension: Extension): ManualEobPosting {
  const values = extension.extension;
  if (!values) throw new ManualEobValidationError("Manual EOB posting extension is incomplete.");
  const claimReference = requiredExtension(values, "claim").valueReference?.reference;
  const claimResponseReference = requiredExtension(values, "claim-response").valueReference?.reference;
  const paymentReconciliationReference = requiredExtension(values, "payment-reconciliation").valueReference?.reference;
  const postedAt = requiredExtension(values, "posted-at").valueDateTime;
  if (!claimReference || !claimResponseReference || !paymentReconciliationReference || !postedAt) {
    throw new ManualEobValidationError("Manual EOB posting contains an incomplete required field.");
  }
  return {
    claimReference,
    claimResponseReference,
    paymentReconciliationReference,
    amountCents: moneyToCents(requiredExtension(values, "amount").valueMoney?.value),
    postedAt,
  };
}

function validateHeaderInput(input: ManualEobHeaderInput): void {
  validateReference(input.payerReference, "Organization", "payerReference");
  if (!input.paymentReference.trim()) {
    throw new ManualEobValidationError("paymentReference is required.");
  }
  r4Date(input.paymentDate, "paymentDate");
  r4Date(input.depositDate, "depositDate");
  positiveCents(input.totalAmountCents, "totalAmountCents");
  if (!input.createdAt) throw new ManualEobValidationError("createdAt is required.");
}

function requiredExtension(values: readonly Extension[], url: string): Extension {
  const extension = values.find((entry) => entry.url === url);
  if (!extension) throw new ManualEobValidationError(`Manual EOB header is missing ${url}.`);
  return extension;
}

function validateReference(value: string, resourceType: string, field: string): void {
  if (!new RegExp(`^${resourceType}/[A-Za-z0-9.-]+$`).test(value)) {
    throw new ManualEobValidationError(`${field} must reference ${resourceType}/<id>.`);
  }
}

function positiveCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ManualEobValidationError(`${field} must be a positive integer number of cents.`);
  }
}

function r4Date(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ManualEobValidationError(`${field} must be an R4 date (YYYY-MM-DD).`);
  }
}

function money(cents: number) {
  return { value: cents / 100, currency: "USD" as const };
}

function moneyToCents(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new ManualEobValidationError("Manual EOB Money value is missing or invalid.");
  }
  return Math.round(value * 100);
}
