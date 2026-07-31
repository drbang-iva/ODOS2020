/**
 * Browser-side FHIR client. Mirrors odos/src/fhir-client.ts (node-side) but uses
 * Web Crypto API for PKCE. Zero Medplum SDK coupling — swappable backend.
 */

import type { Bundle, MedicationRequest, OperationOutcome, Resource } from "@medplum/fhirtypes";

const BASE = "/fhir/R4"; // Vite dev proxy -> http://localhost:8103
const AUTH = "";
export const SESSION_STORAGE_KEY = "odos.session.v1";

let token: string | undefined;
let sessionStorageBackend: Storage | undefined;
const sessionClearedListeners = new Set<() => void>();

interface PersistedSession {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export type JsonPatchOperation =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

export const CONCURRENT_EDIT_MESSAGE =
  "This record was changed by someone else since you opened it. Reload and reapply your change.";

type TransactionResponse<T> = Bundle & { readonly __odosResponseType?: T };
export type FhirSearchParams = Record<string, string> | URLSearchParams | Array<[string, string]>;

export interface WenoDrugSearchResult {
  drugDbCode: string;
  drugDbCodeQualifier: string;
  quantityUnitOfMeasureCode: string;
  psnDescription: string;
  route: string;
  strength: string;
}

export interface WenoPharmacySearchResult {
  ncpdpId: string;
  npi?: string;
  businessName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  onWeno: boolean;
}

export interface WenoSwitchConfiguration {
  configured: boolean;
  reason: string;
}

export type WenoPrescriptionSendResult =
  | { kind: "status"; code: string; description: string }
  | { kind: "error"; code: string; descriptionCode: string; description: string }
  | { kind: "unknown"; messageId: string; description: string };

export interface WenoPrescriptionSendResponse {
  result: WenoPrescriptionSendResult;
  medicationRequest: MedicationRequest;
  resendable: boolean;
}

export interface WenoIndeterminateSendClearResponse {
  medicationRequest: MedicationRequest;
  clearedMessageId: string;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = btoa(String.fromCharCode(...verifierBytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hashed)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return { verifier, challenge };
}

export async function toError(res: Response, versionedWrite = false): Promise<Error> {
  const body = await res.text();
  if (versionedWrite && (res.status === 409 || res.status === 412)) {
    return new Error(CONCURRENT_EDIT_MESSAGE);
  }
  let detail = body;
  try {
    const parsed = JSON.parse(body) as OperationOutcome;
    detail = formatOperationOutcome(parsed) ?? body;
  } catch {
    /* ignore */
  }
  return new Error(`FHIR ${res.status} ${res.statusText}: ${detail}`);
}

function headers(): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/fhir+json",
    Accept: "application/fhir+json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function sourceHeaders(sourceTag: string): HeadersInit {
  return {
    ...headers(),
    "X-ODOS-Source": `ui/${sourceTag}`,
  };
}

function browserSessionStorage(): Storage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

function persistSession(session: PersistedSession, storage = browserSessionStorage()): void {
  storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function readPersistedSession(storage = browserSessionStorage()): PersistedSession | undefined {
  const value = storage?.getItem(SESSION_STORAGE_KEY);
  if (!value) return undefined;
  try {
    const session = JSON.parse(value) as Partial<PersistedSession>;
    if (typeof session.accessToken !== "string"
      || typeof session.expiresAt !== "number"
      || !Number.isFinite(session.expiresAt)
      || session.expiresAt <= Date.now()
      || (session.refreshToken !== undefined && typeof session.refreshToken !== "string")) {
      storage?.removeItem(SESSION_STORAGE_KEY);
      return undefined;
    }
    return session as PersistedSession;
  } catch {
    storage?.removeItem(SESSION_STORAGE_KEY);
    return undefined;
  }
}

export const fhir = {
  rehydrateSession(storage = browserSessionStorage()): boolean {
    sessionStorageBackend = storage;
    const session = readPersistedSession(storage);
    token = session?.accessToken;
    return token !== undefined;
  },

  isAuthenticated(): boolean {
    return token !== undefined;
  },

  logout(storage = sessionStorageBackend ?? browserSessionStorage()): void {
    const hadSession = token !== undefined || storage?.getItem(SESSION_STORAGE_KEY) != null;
    token = undefined;
    storage?.removeItem(SESSION_STORAGE_KEY);
    sessionStorageBackend = undefined;
    if (hadSession) {
      for (const listener of sessionClearedListeners) listener();
    }
  },

  onSessionCleared(listener: () => void): () => void {
    sessionClearedListeners.add(listener);
    return () => sessionClearedListeners.delete(listener);
  },

  interceptUnauthorizedResponses(host: { fetch: typeof fetch }): () => void {
    const originalFetch = host.fetch;
    const interceptedFetch: typeof fetch = async (...args) => {
      const sessionAuthorization = token ? `Bearer ${token}` : undefined;
      const requestAuthorization = authorizationHeader(args[0], args[1]);
      const response = await originalFetch(...args);
      if (response.status === 401
        && isOwnOriginRequest(args[0])
        && response.url !== ""
        && isOwnOriginRequest(response.url)
        && sessionAuthorization
        && requestAuthorization === sessionAuthorization) {
        fhir.logout();
      }
      return response;
    };
    host.fetch = interceptedFetch;
    return () => {
      if (host.fetch === interceptedFetch) host.fetch = originalFetch;
    };
  },

  authHeader(): string | undefined {
    return token ? `Bearer ${token}` : undefined;
  },

  practitionerId(): string | undefined {
    const profile = tokenClaims(token)?.profile;
    if (typeof profile !== "string" || !profile.startsWith("Practitioner/")) return undefined;
    return profile.slice("Practitioner/".length) || undefined;
  },

  async login(email: string, password: string): Promise<void> {
    const { verifier, challenge } = await pkce();
    const loginRes = await fetch(`${AUTH}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      }),
    });
    if (!loginRes.ok) throw await toError(loginRes);
    const { code } = (await loginRes.json()) as { code: string };

    const tokenRes = await fetch(`${AUTH}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
    });
    if (!tokenRes.ok) throw await toError(tokenRes);
    const { access_token, expires_in, refresh_token } = (await tokenRes.json()) as TokenResponse;
    token = access_token;
    sessionStorageBackend = browserSessionStorage();
    const expiresAt = Date.now() + expires_in * 1_000;
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      persistSession({
        accessToken: access_token,
        expiresAt,
        ...(refresh_token ? { refreshToken: refresh_token } : {}),
      }, sessionStorageBackend);
    }
  },

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: FhirSearchParams = {},
  ): Promise<Bundle<T>> {
    const query = new URLSearchParams(params).toString();
    const url = `${BASE}/${resourceType}${query ? "?" + query : ""}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as Bundle<T>;
  },

  async searchUrl<T extends Resource>(url: string): Promise<Bundle<T>> {
    const res = await fetch(normalizeFhirSearchUrl(url), { headers: headers() });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as Bundle<T>;
  },

  async searchWenoFormulary(
    baseUrl: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<WenoDrugSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    return apiSearch<WenoDrugSearchResult>(
      `${baseUrl}/weno/drugs/search?${params}`,
      "Formulary",
      signal,
    );
  },

  async searchWenoDirectory(
    baseUrl: string,
    input: { state: string; place: string; searchType: "local-retail" | "mail-order" },
    signal?: AbortSignal,
  ): Promise<WenoPharmacySearchResult[]> {
    const params = new URLSearchParams({
      state: input.state,
      searchType: input.searchType,
      all: "true",
    });
    if (/^\d{5}(?:-?\d{4})?$/.test(input.place)) {
      params.set("zip", input.place);
    } else {
      params.set("city", input.place);
    }
    return apiSearch<WenoPharmacySearchResult>(
      `${baseUrl}/weno/pharmacies/search?${params}`,
      "Directory",
      signal,
    );
  },

  async readWenoSwitchConfiguration(baseUrl: string): Promise<WenoSwitchConfiguration> {
    const res = await fetch(`${baseUrl}/weno/switch/configuration`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await res.json() as Partial<WenoSwitchConfiguration> & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `WENO Switch configuration check failed: ${res.status}`);
    if (typeof body.configured !== "boolean" || typeof body.reason !== "string") {
      throw new Error("WENO Switch configuration response is incomplete.");
    }
    return { configured: body.configured, reason: body.reason };
  },

  async sendWenoPrescription(
    baseUrl: string,
    medicationRequestId: string,
  ): Promise<WenoPrescriptionSendResponse> {
    const res = await fetch(
      `${baseUrl}/weno/medication-requests/${encodeURIComponent(medicationRequestId)}/send`,
      {
        method: "POST",
        headers: token
          ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
          : { "Content-Type": "application/json" },
      },
    );
    const body = await res.json() as Partial<WenoPrescriptionSendResponse> & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `WENO prescription send failed: ${res.status}`);
    if (!body.result || !body.medicationRequest || typeof body.resendable !== "boolean") {
      throw new Error("WENO prescription send response is incomplete.");
    }
    return body as WenoPrescriptionSendResponse;
  },

  async clearWenoIndeterminateSend(
    baseUrl: string,
    medicationRequestId: string,
  ): Promise<WenoIndeterminateSendClearResponse> {
    const res = await fetch(
      `${baseUrl}/weno/medication-requests/${encodeURIComponent(medicationRequestId)}/clear-indeterminate-send`,
      {
        method: "POST",
        headers: token
          ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
          : { "Content-Type": "application/json" },
      },
    );
    const body = await res.json() as Partial<WenoIndeterminateSendClearResponse> & {
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `WENO indeterminate send clear failed: ${res.status}`);
    }
    if (!body.medicationRequest || typeof body.clearedMessageId !== "string") {
      throw new Error("WENO indeterminate send clear response is incomplete.");
    }
    return body as WenoIndeterminateSendClearResponse;
  },

  async read<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
  ): Promise<T> {
    const url = `${BASE}/${resourceType}/${id}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  },

  async create<T extends Resource>(
    resource: T,
    sourceTag: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const res = await fetch(`${BASE}/${resource.resourceType}`, {
      method: "POST",
      headers: { ...sourceHeaders(sourceTag), ...extraHeaders },
      body: JSON.stringify(resource),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  },

  async update<T extends Resource>(
    resource: T,
    sourceTag: string,
    ifMatchVersionId?: string,
  ): Promise<T> {
    if (!resource.id) {
      throw new Error(`FHIR update requires ${resource.resourceType}.id.`);
    }
    const res = await fetch(`${BASE}/${resource.resourceType}/${resource.id}`, {
      method: "PUT",
      headers: {
        ...sourceHeaders(sourceTag),
        ...(ifMatchVersionId ? { "If-Match": `W/"${ifMatchVersionId}"` } : {}),
      },
      body: JSON.stringify(resource),
    });
    if (!res.ok) throw await toError(res, Boolean(ifMatchVersionId));
    return (await res.json()) as T;
  },

  async patch<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    ops: JsonPatchOperation[],
    sourceTag: string,
    ifMatchVersionId?: string,
  ): Promise<T> {
    const res = await fetch(`${BASE}/${resourceType}/${id}`, {
      method: "PATCH",
      headers: {
        ...sourceHeaders(sourceTag),
        "Content-Type": "application/json-patch+json",
        ...(ifMatchVersionId ? { "If-Match": `W/"${ifMatchVersionId}"` } : {}),
      },
      body: JSON.stringify(ops),
    });
    if (!res.ok) throw await toError(res, Boolean(ifMatchVersionId));
    return (await res.json()) as T;
  },

  async executeTransaction<T = unknown>(
    bundle: Bundle,
    sourceTag: string,
  ): Promise<TransactionResponse<T>> {
    const transactionBundle: Bundle = { ...bundle, type: "transaction" };
    const res = await fetch(BASE, {
      method: "POST",
      headers: sourceHeaders(sourceTag),
      body: JSON.stringify(transactionBundle),
    });
    if (!res.ok) throw await toError(res);
    const responseBundle = (await res.json()) as TransactionResponse<T>;
    if (hasEntryFailure(responseBundle)) {
      await rollbackCreatedEntries(responseBundle, sourceTag);
    }
    return responseBundle;
  },
};

function authorizationHeader(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  if (init && "headers" in init) {
    return new Headers(init.headers).get("Authorization") ?? undefined;
  }
  return typeof Request !== "undefined" && input instanceof Request
    ? input.headers.get("Authorization") ?? undefined
    : undefined;
}

function isOwnOriginRequest(input: RequestInfo | URL): boolean {
  if (typeof window === "undefined") return false;
  const candidate = input as { href?: unknown; url?: unknown };
  const value = typeof input === "string"
    ? input
    : typeof candidate.href === "string"
      ? candidate.href
      : typeof candidate.url === "string"
        ? candidate.url
        : undefined;
  if (!value) return false;
  try {
    return new URL(value, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

async function apiSearch<T>(url: string, label: string, signal?: AbortSignal): Promise<T[]> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  const body = await res.json() as { results?: T[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `${label} search failed: ${res.status}`);
  return body.results ?? [];
}

function tokenClaims(accessToken: string | undefined): Record<string, unknown> | undefined {
  const payload = accessToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeFhirSearchUrl(url: string): string {
  const parsed = new URL(url, "http://odos.local");
  if (parsed.pathname.startsWith(BASE)) {
    return `${parsed.pathname}${parsed.search}`;
  }
  return url;
}

export function formatOperationOutcome(outcome: OperationOutcome): string | undefined {
  return outcome.issue
    ?.map((issue) => {
      const expression = issue.expression?.length
        ? ` [${issue.expression.join(", ")}]`
        : "";
      return `${issue.diagnostics ?? issue.details?.text ?? issue.code}${expression}`;
    })
    .join("; ");
}

function hasEntryFailure(bundle: Bundle): boolean {
  return (bundle.entry ?? []).some((entry) => {
    const status = entry.response?.status;
    return !status || !/^2\d\d/.test(status);
  });
}

async function rollbackCreatedEntries(bundle: Bundle, sourceTag: string): Promise<void> {
  const createdLocations = (bundle.entry ?? [])
    .flatMap((entry) => {
      const status = entry.response?.status;
      const location = entry.response?.location;
      if (!status?.startsWith("201") || !location) {
        return [];
      }
      const match = location.match(/^([A-Za-z]+\/[^/]+)/);
      return match ? [match[1]] : [];
    })
    .reverse();

  for (const location of createdLocations) {
    await fetch(`${BASE}/${location}`, {
      method: "DELETE",
      headers: sourceHeaders(sourceTag),
    }).catch(() => undefined);
  }
}
