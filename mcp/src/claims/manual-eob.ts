import type { Basic, Extension } from "@medplum/fhirtypes";

export const MANUAL_EOB_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/osod-manual-eob";
export const MANUAL_EOB_CODE = "osod-manual-eob";
export const MANUAL_EOB_IDENTIFIER_SYSTEM = "https://osod.dev/fhir/NamingSystem/manual-eob";
export const MANUAL_EOB_HEADER_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-manual-eob-header";

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
  return headerResource(input, "draft", [], 0);
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
  return headerResource(header, "draft", [...header.postings, posting], appliedAmountCents, basic);
}

export function closeManualEobHeader(basic: Basic): Basic {
  const header = parseManualEobHeader(basic);
  if (header.status === "closed") return basic;
  return headerResource(header, "closed", header.postings, header.appliedAmountCents, basic);
}

export function parseManualEobHeader(basic: Basic): ManualEobHeader {
  const code = basic.code?.coding?.find((coding) =>
    coding.system === MANUAL_EOB_CODE_SYSTEM && coding.code === MANUAL_EOB_CODE,
  );
  if (!code) throw new ManualEobValidationError("Basic resource is not an OSOD manual EOB header.");
  if (!basic.id) throw new ManualEobValidationError("Manual EOB header is missing its id.");
  const values = basic.extension?.find((extension) => extension.url === MANUAL_EOB_HEADER_EXTENSION_URL)?.extension;
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
    { url: "deposit-date", valueDate: input.depositDate },
    { url: "total-amount", valueMoney: money(input.totalAmountCents) },
    { url: "applied-amount", valueMoney: money(appliedAmountCents) },
    { url: "status", valueCode: status },
    { url: "created-at", valueDateTime: input.createdAt },
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
    identifier: [{ system: MANUAL_EOB_IDENTIFIER_SYSTEM, value: input.paymentReference }],
    code: {
      coding: [{ system: MANUAL_EOB_CODE_SYSTEM, code: MANUAL_EOB_CODE, display: "OSOD manual EOB" }],
      text: "Manual EOB",
    },
    extension: [{ url: MANUAL_EOB_HEADER_EXTENSION_URL, extension }],
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
