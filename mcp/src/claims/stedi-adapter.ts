import type { ClearinghouseAdapter } from "./clearinghouse-adapter.js";
import type { StediProfessionalClaimPayload } from "./stedi-fhir.js";

export const STEDI_DEFAULT_BASE_URL = "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork";
export const STEDI_DEFAULT_CORE_BASE_URL = "https://core.us.stedi.com/2023-08-01";
export const STEDI_DEFAULT_HEALTHCARE_BASE_URL = "https://healthcare.us.stedi.com/2024-04-01";
export const STEDI_DEFAULT_MANAGER_BASE_URL = "https://manager.us.stedi.com/2024-04-01";

export interface StediConfig {
  baseUrl: string;
  coreBaseUrl: string;
  healthcareBaseUrl?: string;
  managerBaseUrl?: string;
  apiKey: string;
  submitterId: string;
  mode: "test" | "production";
}

export interface StediSubmitResult {
  claimReference?: {
    correlationId?: string;
    customerClaimNumber?: string;
    patientControlNumber?: string;
  };
  [key: string]: unknown;
}

export interface StediAdapter extends ClearinghouseAdapter {
  readonly id: "stedi";
  readonly mode: "test" | "production";
  readonly submitterId: string;
  submitProfessionalClaim(input: { payload: StediProfessionalClaimPayload; idempotencyKey: string }): Promise<StediSubmitResult>;
  list277s(input?: { pageToken?: string; startDateTime?: string }): Promise<unknown>;
  retrieve277Data(transactionId: string): Promise<unknown>;
  submitBatchEligibility(input: {
    items: unknown[];
    name: string;
    maxRetryHours?: number;
  }): Promise<unknown>;
  getBatchEligibilityItems(batchId: string, input?: { pageSize?: number; pageToken?: string }): Promise<unknown>;
  pollBatchEligibility(input: { batchId?: string; startDateTime?: string; pageSize?: number; pageToken?: string }): Promise<unknown>;
  checkCoordinationOfBenefits(payload: unknown): Promise<unknown>;
  submitInsuranceDiscovery(payload: unknown): Promise<unknown>;
  getInsuranceDiscoveryResults(discoveryId: string): Promise<unknown>;
}

export interface StediErrorDetail {
  code?: string;
  description?: string;
  followupAction?: string;
  [key: string]: unknown;
}

export class StediRequestError extends Error {
  readonly errors?: StediErrorDetail[];
  readonly correlationId?: string;

  constructor(readonly status: number, readonly responseBody?: unknown) {
    const errors = stediErrors(responseBody);
    const correlationId = stediCorrelationId(responseBody);
    super(stediRequestErrorMessage(status, errors, correlationId));
    this.name = "StediRequestError";
    this.errors = errors;
    this.correlationId = correlationId;
  }
}

export function stediConfigFromEnv(env: Record<string, string | undefined>): StediConfig | null {
  const touched = [
    "STEDI_API_KEY",
    "STEDI_SUBMITTER_ID",
    "STEDI_BASE_URL",
    "STEDI_CORE_BASE_URL",
    "STEDI_HEALTHCARE_BASE_URL",
    "STEDI_MANAGER_BASE_URL",
    "STEDI_MODE",
  ]
    .some((name) => Boolean(env[name]));
  if (!touched) return null;
  if (!env.STEDI_API_KEY) throw new Error("Stedi adapter is partially configured — missing STEDI_API_KEY.");
  if (!env.STEDI_SUBMITTER_ID) throw new Error("Stedi adapter is partially configured — missing STEDI_SUBMITTER_ID.");
  return {
    apiKey: env.STEDI_API_KEY,
    submitterId: env.STEDI_SUBMITTER_ID,
    baseUrl: (env.STEDI_BASE_URL ?? STEDI_DEFAULT_BASE_URL).replace(/\/$/, ""),
    coreBaseUrl: (env.STEDI_CORE_BASE_URL ?? STEDI_DEFAULT_CORE_BASE_URL).replace(/\/$/, ""),
    healthcareBaseUrl: (env.STEDI_HEALTHCARE_BASE_URL ?? STEDI_DEFAULT_HEALTHCARE_BASE_URL).replace(/\/$/, ""),
    managerBaseUrl: (env.STEDI_MANAGER_BASE_URL ?? STEDI_DEFAULT_MANAGER_BASE_URL).replace(/\/$/, ""),
    mode: env.STEDI_MODE === "production" ? "production" : "test",
  };
}

export function createStediAdapter(opts: {
  config: StediConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  allowUnsupportedTestMode?: boolean;
}): StediAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.config.baseUrl.replace(/\/$/, "");
  const coreBaseUrl = opts.config.coreBaseUrl.replace(/\/$/, "");
  const healthcareBaseUrl = (opts.config.healthcareBaseUrl ?? STEDI_DEFAULT_HEALTHCARE_BASE_URL).replace(/\/$/, "");
  const managerBaseUrl = (opts.config.managerBaseUrl ?? STEDI_DEFAULT_MANAGER_BASE_URL).replace(/\/$/, "");
  const jsonHeaders = (): Record<string, string> => ({
    Authorization: opts.config.apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  const pollTransactions = async (
    input: { pageToken?: string; startDateTime?: string } = {},
  ): Promise<unknown> => {
    const startDateTime = input.startDateTime
      ?? new Date((opts.now?.() ?? new Date()).getTime() - 86_400_000).toISOString();
    const query = input.pageToken
      ? `pageToken=${encodeURIComponent(input.pageToken)}`
      : `startDateTime=${encodeURIComponent(startDateTime)}`;
    return requestJson(
      fetchImpl,
      `${coreBaseUrl}/polling/transactions?${query}`,
      { method: "GET", headers: jsonHeaders() },
    );
  };
  const preventiveRequest = async (url: string, init: RequestInit): Promise<unknown> => {
    if (opts.config.mode !== "production" && !opts.allowUnsupportedTestMode) {
      throw new Error("This Stedi preventive operation requires STEDI_MODE=production; use an injected mocked contract for development.");
    }
    return requestJson(fetchImpl, url, init);
  };

  return {
    id: "stedi",
    mode: opts.config.mode,
    submitterId: opts.config.submitterId,
    checkEligibility: (payload) => requestJson(fetchImpl, `${baseUrl}/eligibility/v3`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    }),
    async submitProfessionalClaim(input) {
      return requestJson(fetchImpl, `${baseUrl}/professionalclaims/v3/submission`, {
        method: "POST",
        headers: { ...jsonHeaders(), "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify(input.payload),
      }) as Promise<StediSubmitResult>;
    },
    checkClaimStatus: (payload) => requestJson(fetchImpl, `${baseUrl}/claimstatus/v2`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    }),
    listEras: (input) => pollTransactions(input),
    retrieveEraData: (transactionId) => requestJson(
      fetchImpl,
      `${baseUrl}/reports/v2/${encodeURIComponent(transactionId)}/835`,
      { method: "GET", headers: jsonHeaders() },
    ),
    list277s: async (input) => filterTransactions(await pollTransactions(input), "277"),
    retrieve277Data: (transactionId) => requestJson(
      fetchImpl,
      `${baseUrl}/reports/v2/${encodeURIComponent(transactionId)}/277`,
      { method: "GET", headers: jsonHeaders() },
    ),
    submitBatchEligibility: (input) => preventiveRequest(
      `${managerBaseUrl}/eligibility-manager/batch-eligibility`,
      { method: "POST", headers: jsonHeaders(), body: JSON.stringify(input) },
    ),
    getBatchEligibilityItems: (batchId, input = {}) => preventiveRequest(
      `${managerBaseUrl}/eligibility-manager/batch/${encodeURIComponent(batchId)}/items${queryString(input)}`,
      { method: "GET", headers: jsonHeaders() },
    ),
    pollBatchEligibility: (input) => preventiveRequest(
      `${managerBaseUrl}/eligibility-manager/polling/batch-eligibility${queryString(input)}`,
      { method: "GET", headers: jsonHeaders() },
    ),
    checkCoordinationOfBenefits: (payload) => preventiveRequest(
      `${healthcareBaseUrl}/coordination-of-benefits`,
      { method: "POST", headers: jsonHeaders(), body: JSON.stringify(payload) },
    ),
    submitInsuranceDiscovery: (payload) => preventiveRequest(
      `${healthcareBaseUrl}/insurance-discovery/check/v1`,
      { method: "POST", headers: jsonHeaders(), body: JSON.stringify(payload) },
    ),
    getInsuranceDiscoveryResults: (discoveryId) => preventiveRequest(
      `${healthcareBaseUrl}/insurance-discovery/check/v1/${encodeURIComponent(discoveryId)}`,
      { method: "GET", headers: jsonHeaders() },
    ),
  };
}

function queryString(input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = undefined;
    }
    throw new StediRequestError(response.status, responseBody);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Stedi returned a non-JSON response.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function transactionSetIdentifierOf(item: Record<string, unknown>): unknown {
  const x12 = isRecord(item.x12) ? item.x12 : undefined;
  const metadata = x12 && isRecord(x12.metadata) ? x12.metadata : undefined;
  const transaction = metadata && isRecord(metadata.transaction) ? metadata.transaction : undefined;
  return transaction?.transactionSetIdentifier;
}

function filterTransactions(result: unknown, transactionSetIdentifier: "277"): unknown {
  if (!isRecord(result) || !Array.isArray(result.items)) return result;
  return {
    ...result,
    items: result.items.filter((item) => isRecord(item)
      && item.direction === "INBOUND"
      && transactionSetIdentifierOf(item) === transactionSetIdentifier),
  };
}

function stediErrors(responseBody: unknown): StediErrorDetail[] | undefined {
  if (!isRecord(responseBody)) return undefined;
  if (Array.isArray(responseBody.errors)) {
    return responseBody.errors.filter((error): error is StediErrorDetail => isRecord(error));
  }
  if (responseBody.code !== "INVALID_REQUEST_BODY" || typeof responseBody.message !== "string") {
    return undefined;
  }
  try {
    const fields = JSON.parse(responseBody.message) as unknown;
    if (!isRecord(fields)) throw new Error("invalid field detail");
    const details = Object.entries(fields).flatMap(([path, messages]) =>
      Array.isArray(messages)
        ? messages.flatMap((message) => typeof message === "string"
          ? [{ code: "INVALID_REQUEST_BODY", description: `${path}: ${message}` }]
          : [])
        : []
    );
    return details.length ? details : [{ code: "INVALID_REQUEST_BODY", description: responseBody.message }];
  } catch {
    return [{ code: "INVALID_REQUEST_BODY", description: responseBody.message }];
  }
}

function stediCorrelationId(responseBody: unknown): string | undefined {
  if (!isRecord(responseBody) || !isRecord(responseBody.claimReference)) return undefined;
  return typeof responseBody.claimReference.correlationId === "string"
    ? responseBody.claimReference.correlationId
    : undefined;
}

function stediRequestErrorMessage(
  status: number,
  errors: StediErrorDetail[] | undefined,
  correlationId: string | undefined,
): string {
  const base = `Stedi request failed with HTTP ${status}.`;
  const formattedErrors = (errors ?? []).map(formatStediErrorDetail).filter(Boolean);
  const visibleErrors = formattedErrors.slice(0, 3);
  const omittedCount = formattedErrors.length - visibleErrors.length;
  const detail = [
    ...visibleErrors,
    ...(omittedCount ? [`${omittedCount} more Stedi error${omittedCount === 1 ? "" : "s"} omitted.`] : []),
  ].join("; ");
  return `${base}${detail ? ` ${detail}` : ""}${correlationId ? ` [correlationId: ${correlationId}]` : ""}`;
}

function formatStediErrorDetail(error: StediErrorDetail): string {
  const code = typeof error.code === "string" ? error.code.trim() : "";
  const description = typeof error.description === "string" ? error.description.trim() : "";
  const followupAction = typeof error.followupAction === "string" ? error.followupAction.trim() : "";
  const reason = code && description ? `${code}: ${description}` : code || description;
  return followupAction ? `${reason ? `${reason} ` : ""}(${followupAction})` : reason;
}
