import type { ClearinghouseAdapter } from "./clearinghouse-adapter.js";
import type { StediProfessionalClaimPayload } from "./stedi-fhir.js";

export const STEDI_DEFAULT_BASE_URL = "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork";
export const STEDI_DEFAULT_CORE_BASE_URL = "https://core.us.stedi.com/2023-08-01";

export interface StediConfig {
  baseUrl: string;
  coreBaseUrl: string;
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
    super(`Stedi request failed with HTTP ${status}.`);
    this.name = "StediRequestError";
    if (isRecord(responseBody)) {
      if (Array.isArray(responseBody.errors)) {
        this.errors = responseBody.errors.filter((error): error is StediErrorDetail => isRecord(error));
      }
      const claimReference = responseBody.claimReference;
      if (isRecord(claimReference) && typeof claimReference.correlationId === "string") {
        this.correlationId = claimReference.correlationId;
      }
    }
  }
}

export function stediConfigFromEnv(env: Record<string, string | undefined>): StediConfig | null {
  const touched = ["STEDI_API_KEY", "STEDI_SUBMITTER_ID", "STEDI_BASE_URL", "STEDI_CORE_BASE_URL", "STEDI_MODE"]
    .some((name) => Boolean(env[name]));
  if (!touched) return null;
  if (!env.STEDI_API_KEY) throw new Error("Stedi adapter is partially configured — missing STEDI_API_KEY.");
  if (!env.STEDI_SUBMITTER_ID) throw new Error("Stedi adapter is partially configured — missing STEDI_SUBMITTER_ID.");
  return {
    apiKey: env.STEDI_API_KEY,
    submitterId: env.STEDI_SUBMITTER_ID,
    baseUrl: (env.STEDI_BASE_URL ?? STEDI_DEFAULT_BASE_URL).replace(/\/$/, ""),
    coreBaseUrl: (env.STEDI_CORE_BASE_URL ?? STEDI_DEFAULT_CORE_BASE_URL).replace(/\/$/, ""),
    mode: env.STEDI_MODE === "production" ? "production" : "test",
  };
}

export function createStediAdapter(opts: { config: StediConfig; fetchImpl?: typeof fetch; now?: () => Date }): StediAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.config.baseUrl.replace(/\/$/, "");
  const coreBaseUrl = opts.config.coreBaseUrl.replace(/\/$/, "");
  const jsonHeaders = (): Record<string, string> => ({
    Authorization: opts.config.apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  });

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
    listEras: (input: { pageToken?: string; startDateTime?: string } = {}) => {
      const startDateTime = input.startDateTime
        ?? new Date((opts.now?.() ?? new Date()).getTime() - 86_400_000).toISOString();
      const query = input.pageToken
        ? `pageToken=${encodeURIComponent(input.pageToken)}`
        : `startDateTime=${encodeURIComponent(startDateTime)}`;
      return requestJson(fetchImpl, `${coreBaseUrl}/polling/transactions?${query}`, { method: "GET", headers: jsonHeaders() });
    },
    retrieveEraData: (transactionId) => requestJson(
      fetchImpl,
      `${baseUrl}/reports/v2/${encodeURIComponent(transactionId)}/835`,
      { method: "GET", headers: jsonHeaders() },
    ),
  };
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
