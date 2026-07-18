import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export type PackageRefundPolicy = "non_refundable" | "store_credit_only" | "prorated_cash";

export interface PackageDefinition {
  id: string;
  name: string;
  eligibleProcedureTypeCodes: string[];
  sessionCount: number;
  priceCents: number;
  expiryDays: number;
  refundPolicy: PackageRefundPolicy;
  active: boolean;
  soldCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PackageLedgerEntry {
  id: string;
  entryType: "deposit" | "consumption" | "adjustment" | "expiry";
  sessionsDelta: number;
  actorUserId: string;
  reason?: string;
  linkedFhirInvoiceId?: string;
  linkedFhirProcedureId?: string;
  externalReference?: string;
  createdAt: string;
}

export interface CreditBankLedgerEntry {
  id: string;
  entryType: "deposit" | "bonus" | "spend" | "refund_in" | "adjustment" | "expiry";
  amountCents: number;
  actorUserId: string;
  reason?: string;
  linkedFhirInvoiceId?: string;
  createdAt: string;
}

export interface PatientCreditBank {
  patientFhirId: string;
  balanceCents: number;
  ledger: CreditBankLedgerEntry[];
}

export interface PackageLifecycleResult {
  package: PatientPackageInstance;
  amountCents: number;
  creditBank?: PatientCreditBank;
}

export interface PatientPackageInstance {
  id: string;
  patientFhirId: string;
  definitionId: string;
  name: string;
  eligibleProcedureTypeCodes: string[];
  sessionCount: number;
  priceCents: number;
  expiryDate: string;
  refundPolicy: PackageRefundPolicy;
  sourceSaleInvoiceId: string;
  remainingSessions: number;
  createdAt: string;
  ledger: PackageLedgerEntry[];
}

export type PackageDefinitionDraft = Pick<
  PackageDefinition,
  "name" | "eligibleProcedureTypeCodes" | "sessionCount" | "priceCents" | "expiryDays" | "refundPolicy"
> & { id?: string };

export type PackageSaleTender = "CASH" | "CHECK" | "CARD_MANUAL";

export class PackageFinalizationError extends Error {
  constructor(message: string, readonly invoiceReference: string) {
    super(message);
    this.name = "PackageFinalizationError";
  }
}

export class CreditBankFinalizationError extends Error {
  constructor(message: string, readonly invoiceReference: string) {
    super(message);
    this.name = "CreditBankFinalizationError";
  }
}

export interface PendingPackageSale {
  patientReference: string;
  definition: PackageDefinition;
  tender: PackageSaleTender;
  invoiceReference: string;
}

const PENDING_PACKAGE_SALE_STORAGE_PREFIX = "odos.pending-package-sale.v1:";
const PENDING_CREDIT_BANK_DEPOSIT_STORAGE_PREFIX = "odos.pending-credit-bank-deposit.v1:";

interface ApiOptions {
  fetchImpl?: typeof fetch;
  authHeader?: () => string | undefined;
  storage?: Storage;
}

export function readPendingPackageSale(
  patientReference: string,
  storage = browserSessionStorage(),
): PendingPackageSale | undefined {
  for (const storageKey of storageKeys(storage, PENDING_PACKAGE_SALE_STORAGE_PREFIX)) {
    const value = storageValue(storage, storageKey);
    if (!value) continue;
    try {
      const pending = JSON.parse(value) as Partial<PendingPackageSale>;
      if (!pending.definition
        || typeof pending.definition.id !== "string"
        || typeof pending.invoiceReference !== "string"
        || storageKey !== pendingPackageSaleStorageKey(pending.invoiceReference)
        || !pending.invoiceReference.startsWith("Invoice/")
        || !(["CASH", "CHECK", "CARD_MANUAL"] as const).includes(pending.tender as PackageSaleTender)) {
        removeStorageValue(storage, storageKey);
        continue;
      }
      if (pending.patientReference === patientReference) return pending as PendingPackageSale;
    } catch {
      removeStorageValue(storage, storageKey);
    }
  }
  return undefined;
}

function pendingPackageSaleStorageKey(invoiceReference: string): string {
  return `${PENDING_PACKAGE_SALE_STORAGE_PREFIX}${encodeURIComponent(invoiceReference)}`;
}

export async function fetchPackageDefinitions(
  includeArchived = false,
  options: ApiOptions = {},
): Promise<PackageDefinition[]> {
  const response = await authorizedFetch(`/commercial-engine/definitions?includeArchived=${includeArchived}`, undefined, options);
  const body = await json(response);
  if (!response.ok) throw apiError(response, body);
  return arrayField<PackageDefinition>(body, "definitions");
}

export async function savePackageDefinition(
  draft: PackageDefinitionDraft,
  options: ApiOptions = {},
): Promise<PackageDefinition> {
  const response = await authorizedFetch("/commercial-engine/definitions", draft, options);
  const body = await json(response);
  if (!response.ok) throw apiError(response, body);
  return objectField<PackageDefinition>(body, "definition");
}

export async function archivePackageDefinition(id: string, options: ApiOptions = {}): Promise<PackageDefinition> {
  const response = await authorizedFetch(`/commercial-engine/definitions/${encodeURIComponent(id)}/archive`, {}, options);
  const body = await json(response);
  if (!response.ok) throw apiError(response, body);
  return objectField<PackageDefinition>(body, "definition");
}

export async function fetchPatientPackages(patientReference: string, options: ApiOptions = {}): Promise<PatientPackageInstance[]> {
  const patientId = patientReference.replace(/^Patient\//, "");
  const response = await authorizedFetch(`/commercial-engine/patients/${encodeURIComponent(patientId)}/packages`, undefined, options);
  const body = await json(response);
  if (!response.ok) throw apiError(response, body);
  return arrayField<PatientPackageInstance>(body, "packages");
}

export async function fetchCreditBank(patientReference: string, options: ApiOptions = {}): Promise<PatientCreditBank> {
  const patientId = patientReference.replace(/^Patient\//, "");
  const response = await authorizedFetch(`/commercial-engine/patients/${encodeURIComponent(patientId)}/credit-bank`, undefined, options);
  const body = await json(response);
  if (!response.ok) throw apiError(response, body);
  return objectField<PatientCreditBank>(body, "creditBank");
}

export async function fetchApplicablePackages(
  patientReference: string,
  procedureCode: string,
  options: ApiOptions = {},
): Promise<PatientPackageInstance[]> {
  const patientId = patientReference.replace(/^Patient\//, "");
  const query = new URLSearchParams({ procedureCode });
  const response = await authorizedFetch(`/commercial-engine/patients/${encodeURIComponent(patientId)}/applicable?${query}`, undefined, options);
  const body = await json(response);
  if (!response.ok) throw apiError(response, body);
  return arrayField<PatientPackageInstance>(body, "packages");
}

export async function sellPackage(
  input: {
    patientReference: string;
    definition: PackageDefinition;
    tender: PackageSaleTender;
    paidInvoiceReference?: string;
  },
  options: ApiOptions = {},
): Promise<PatientPackageInstance> {
  let invoiceReference = input.paidInvoiceReference;
  if (!invoiceReference) {
    const prepared = await post<{ invoiceReference: string }>("/commercial-engine/sales/prepare", {
      patientReference: input.patientReference,
      definitionId: input.definition.id,
    }, options);
    invoiceReference = prepared.invoiceReference;
    const charged = await post<{ outcome: string }>("/payments/charge", {
      method: "manual-cash",
      amountCents: input.definition.priceCents,
      patientReference: input.patientReference,
      invoiceReference,
      description: input.definition.name,
      surface: "manual",
      tender: { code: input.tender },
    }, options);
    if (charged.outcome !== "success") throw new Error(`Package payment did not complete (${charged.outcome}).`);
  }
  const storage = options.storage ?? browserSessionStorage();
  const storageKey = pendingPackageSaleStorageKey(invoiceReference);
  persistPendingPackageSale(storage, storageKey, {
    patientReference: input.patientReference,
    definition: input.definition,
    tender: input.tender,
    invoiceReference,
  });
  try {
    const finalized = await post<{ package: PatientPackageInstance }>("/commercial-engine/sales/finalize", {
      patientReference: input.patientReference,
      definitionId: input.definition.id,
      invoiceReference,
    }, options);
    removeStorageValue(storage, storageKey);
    return finalized.package;
  } catch (cause) {
    throw new PackageFinalizationError(
      `Payment succeeded, but package activation needs retry: ${cause instanceof Error ? cause.message : String(cause)}`,
      invoiceReference,
    );
  }
}

export async function depositCreditBank(
  input: {
    patientReference: string;
    depositCents: number;
    bonusCents?: number;
    bonusReason?: string;
    tender: PackageSaleTender;
    paidInvoiceReference?: string;
  },
  options: ApiOptions = {},
): Promise<PatientCreditBank> {
  let invoiceReference = input.paidInvoiceReference;
  if (!invoiceReference) {
    const prepared = await post<{ invoiceReference: string }>("/commercial-engine/credit-bank/deposits/prepare", {
      patientReference: input.patientReference,
      depositCents: input.depositCents,
      bonusCents: input.bonusCents ?? 0,
      ...(input.bonusReason ? { bonusReason: input.bonusReason } : {}),
    }, options);
    invoiceReference = prepared.invoiceReference;
    const charged = await post<{ outcome: string }>("/payments/charge", {
      method: "manual-cash",
      amountCents: input.depositCents,
      patientReference: input.patientReference,
      invoiceReference,
      description: "Credit Bank deposit",
      surface: "manual",
      tender: { code: input.tender },
    }, options);
    if (charged.outcome !== "success") throw new Error(`Credit Bank payment did not complete (${charged.outcome}).`);
  }
  const storage = options.storage ?? browserSessionStorage();
  const storageKey = pendingCreditBankDepositStorageKey(invoiceReference);
  persistPendingCreditBankDeposit(storage, storageKey, {
    patientReference: input.patientReference,
    depositCents: input.depositCents,
    bonusCents: input.bonusCents ?? 0,
    ...(input.bonusReason ? { bonusReason: input.bonusReason } : {}),
    tender: input.tender,
    invoiceReference,
  });
  try {
    const finalized = await post<{ creditBank: PatientCreditBank }>("/commercial-engine/credit-bank/deposits/finalize", {
      patientReference: input.patientReference,
      invoiceReference,
    }, options);
    removeStorageValue(storage, storageKey);
    return finalized.creditBank;
  } catch (cause) {
    throw new CreditBankFinalizationError(
      `Payment succeeded, but Credit Bank funding needs retry: ${cause instanceof Error ? cause.message : String(cause)}`,
      invoiceReference,
    );
  }
}

export interface PendingCreditBankDeposit {
  patientReference: string;
  depositCents: number;
  bonusCents: number;
  bonusReason?: string;
  tender: PackageSaleTender;
  invoiceReference: string;
}

export function readPendingCreditBankDeposit(
  patientReference: string,
  storage = browserSessionStorage(),
): PendingCreditBankDeposit | undefined {
  for (const storageKey of storageKeys(storage, PENDING_CREDIT_BANK_DEPOSIT_STORAGE_PREFIX)) {
    const value = storageValue(storage, storageKey);
    if (!value) continue;
    try {
      const pending = JSON.parse(value) as Partial<PendingCreditBankDeposit>;
      if (pending.patientReference === patientReference
        && typeof pending.depositCents === "number"
        && typeof pending.bonusCents === "number"
        && typeof pending.invoiceReference === "string"
        && storageKey === pendingCreditBankDepositStorageKey(pending.invoiceReference)
        && (["CASH", "CHECK", "CARD_MANUAL"] as const).includes(pending.tender as PackageSaleTender)) {
        return pending as PendingCreditBankDeposit;
      }
    } catch {
      removeStorageValue(storage, storageKey);
    }
  }
  return undefined;
}

export async function spendCreditBank(
  input: { patientReference: string; chargeItemReference: string },
  options: ApiOptions = {},
): Promise<{ creditBank: PatientCreditBank; invoiceReference: string; paymentReference: string }> {
  return post("/commercial-engine/credit-bank/spends", input, options);
}

export async function convertPackageToCreditBank(
  input: { patientReference: string; packageInstanceId: string; reason: string },
  options: ApiOptions = {},
): Promise<PackageLifecycleResult> {
  return post("/commercial-engine/packages/convert-to-credit-bank", input, options);
}

export async function attestPackageCashRefund(
  input: { patientReference: string; packageInstanceId: string; reason: string; externalReference: string },
  options: ApiOptions = {},
): Promise<PackageLifecycleResult> {
  return post("/commercial-engine/packages/attest-cash-refund", input, options);
}

function browserSessionStorage(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function storageValue(storage: Storage | undefined, key: string): string | null | undefined {
  try {
    return storage?.getItem(key);
  } catch {
    return undefined;
  }
}

function persistPendingPackageSale(
  storage: Storage | undefined,
  key: string,
  pending: PendingPackageSale,
): void {
  try {
    storage?.setItem(key, JSON.stringify(pending));
  } catch {
    return;
  }
}

function persistPendingCreditBankDeposit(
  storage: Storage | undefined,
  key: string,
  pending: PendingCreditBankDeposit,
): void {
  try {
    storage?.setItem(key, JSON.stringify(pending));
  } catch {
    return;
  }
}

function pendingCreditBankDepositStorageKey(invoiceReference: string): string {
  return `${PENDING_CREDIT_BANK_DEPOSIT_STORAGE_PREFIX}${encodeURIComponent(invoiceReference)}`;
}

function storageKeys(storage: Storage | undefined, prefix: string): string[] {
  try {
    if (!storage) return [];
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(prefix)));
  } catch {
    return [];
  }
}

function removeStorageValue(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    return;
  }
}

export async function redeemPackage(
  input: {
    patientReference: string;
    packageInstanceId: string;
    procedureReference: string;
    chargeItemReference: string;
  },
  options: ApiOptions = {},
): Promise<{ package: PatientPackageInstance; invoiceReference: string; paymentReference: string }> {
  return post("/commercial-engine/redemptions", input, options);
}

async function post<T>(path: string, body: unknown, options: ApiOptions): Promise<T> {
  const response = await authorizedFetch(path, body, options);
  const parsed = await json(response);
  if (!response.ok) throw apiError(response, parsed);
  if (!parsed || typeof parsed !== "object") throw new Error("Commercial engine response is invalid.");
  return parsed as T;
}

async function authorizedFetch(path: string, body: unknown | undefined, options: ApiOptions): Promise<Response> {
  const authorization = options.authHeader?.() ?? authHeaders().Authorization;
  if (!authorization) throw new Error("A signed-in staff session is required.");
  return (options.fetchImpl ?? fetch)(`${clinicalGraphApiBase()}${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  });
}

async function json(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

function apiError(response: Response, body: unknown): Error {
  const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : response.statusText;
  return new Error(`${response.status} ${message}`.trim());
}

function arrayField<T>(body: unknown, key: string): T[] {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(value)) throw new Error(`Commercial engine ${key} response is invalid.`);
  return value as T[];
}

function objectField<T>(body: unknown, key: string): T {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Commercial engine ${key} response is invalid.`);
  return value as T;
}
