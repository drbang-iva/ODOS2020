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
  createdAt: string;
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

export interface PendingPackageSale {
  patientReference: string;
  definition: PackageDefinition;
  tender: PackageSaleTender;
  invoiceReference: string;
}

const PENDING_PACKAGE_SALE_STORAGE_PREFIX = "odos.pending-package-sale.v1:";

interface ApiOptions {
  fetchImpl?: typeof fetch;
  authHeader?: () => string | undefined;
  storage?: Storage;
}

export function readPendingPackageSale(
  patientReference: string,
  storage = browserSessionStorage(),
): PendingPackageSale | undefined {
  const storageKey = pendingPackageSaleStorageKey(patientReference);
  const value = storageValue(storage, storageKey);
  if (!value) return undefined;
  try {
    const pending = JSON.parse(value) as Partial<PendingPackageSale>;
    if (pending.patientReference !== patientReference
      || !pending.definition
      || typeof pending.definition.id !== "string"
      || typeof pending.invoiceReference !== "string"
      || !pending.invoiceReference.startsWith("Invoice/")
      || !(["CASH", "CHECK", "CARD_MANUAL"] as const).includes(pending.tender as PackageSaleTender)) {
      removeStorageValue(storage, storageKey);
      return undefined;
    }
    return pending as PendingPackageSale;
  } catch {
    removeStorageValue(storage, storageKey);
    return undefined;
  }
}

function pendingPackageSaleStorageKey(patientReference: string): string {
  return `${PENDING_PACKAGE_SALE_STORAGE_PREFIX}${encodeURIComponent(patientReference)}`;
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
  const storageKey = pendingPackageSaleStorageKey(input.patientReference);
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
    if (readPendingPackageSale(input.patientReference, storage)?.invoiceReference === invoiceReference) {
      removeStorageValue(storage, storageKey);
    }
    return finalized.package;
  } catch (cause) {
    throw new PackageFinalizationError(
      `Payment succeeded, but package activation needs retry: ${cause instanceof Error ? cause.message : String(cause)}`,
      invoiceReference,
    );
  }
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
