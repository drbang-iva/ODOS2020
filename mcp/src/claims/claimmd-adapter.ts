import type { ClaimMdProfessionalClaimPayload } from "./claimmd-fhir.js";

export const CLAIMMD_DEFAULT_BASE_URL = "https://svc.claim.md";

export interface ClaimMdConfig {
  baseUrl: string;
  accountKey: string;
  mode: "test" | "production";
}

export interface ClaimMdSubmitResult {
  claims: Array<{ claimMdClaimId?: string; claimMdId?: string; status?: string }>;
  raw: unknown;
}

export interface ClaimMdAdapter {
  submitProfessionalClaim(input: { fileName: string; payload: ClaimMdProfessionalClaimPayload }): Promise<ClaimMdSubmitResult>;
  checkEligibility(params: Record<string, string>): Promise<unknown>;
  checkClaimStatus(input: { claimMdClaimId: string; responseId?: string }): Promise<unknown>;
  listEras(input?: { eraId?: string }): Promise<unknown>;
  retrieveEraData(eraId: string): Promise<unknown>;
}

export function claimMdConfigFromEnv(env: Record<string, string | undefined>): ClaimMdConfig | null {
  const touched = ["CLAIMMD_ACCOUNT_KEY", "CLAIMMD_BASE_URL", "CLAIMMD_MODE"].some((name) => Boolean(env[name]));
  if (!touched) return null;
  if (!env.CLAIMMD_ACCOUNT_KEY) {
    throw new Error("Claim.MD adapter is partially configured — missing CLAIMMD_ACCOUNT_KEY.");
  }
  const mode = env.CLAIMMD_MODE === "production" ? "production" : "test";
  return {
    accountKey: env.CLAIMMD_ACCOUNT_KEY,
    baseUrl: (env.CLAIMMD_BASE_URL ?? CLAIMMD_DEFAULT_BASE_URL).replace(/\/$/, ""),
    mode,
  };
}

export function createClaimMdAdapter(opts: {
  config: ClaimMdConfig;
  fetchImpl?: typeof fetch;
}): ClaimMdAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.config.baseUrl.replace(/\/$/, "");

  return {
    async submitProfessionalClaim(input) {
      const form = new FormData();
      form.set("AccountKey", opts.config.accountKey);
      form.set("Filename", input.fileName);
      form.set("File", new Blob([JSON.stringify(input.payload)], { type: "application/json" }), input.fileName);
      const raw = await postFormData(fetchImpl, `${baseUrl}/services/upload/`, form);
      return {
        claims: claimRows(raw).map((claim) => ({
          claimMdClaimId: stringField(claim, "claimid"),
          claimMdId: stringField(claim, "claimmd_id"),
          status: stringField(claim, "status"),
        })),
        raw,
      };
    },

    async checkEligibility(params) {
      return postUrlEncoded(fetchImpl, `${baseUrl}/services/eligdata/`, {
        AccountKey: opts.config.accountKey,
        ...params,
      });
    },

    async checkClaimStatus(input) {
      return postUrlEncoded(fetchImpl, `${baseUrl}/services/response/`, {
        AccountKey: opts.config.accountKey,
        ResponseID: input.responseId ?? "0",
        ClaimID: input.claimMdClaimId,
      });
    },

    async listEras(input = {}) {
      return postUrlEncoded(fetchImpl, `${baseUrl}/services/eralist/`, {
        AccountKey: opts.config.accountKey,
        ...(input.eraId ? { ERAID: input.eraId } : {}),
      });
    },

    async retrieveEraData(eraId) {
      return postUrlEncoded(fetchImpl, `${baseUrl}/services/eradata/`, {
        AccountKey: opts.config.accountKey,
        eraid: eraId,
      });
    },
  };
}

async function postFormData(fetchImpl: typeof fetch, url: string, body: FormData): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
  });
  return parseClaimMdResponse(response);
}

async function postUrlEncoded(
  fetchImpl: typeof fetch,
  url: string,
  params: Record<string, string>,
): Promise<unknown> {
  const body = new URLSearchParams(params);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return parseClaimMdResponse(response);
}

async function parseClaimMdResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Claim.MD request failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Claim.MD returned a non-JSON response; endpoint must be called with Accept: application/json.");
  }
}

function claimRows(raw: unknown): Array<Record<string, unknown>> {
  const claim = (raw as { result?: { claim?: unknown } }).result?.claim;
  if (!claim) return [];
  return (Array.isArray(claim) ? claim : [claim]) as Array<Record<string, unknown>>;
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  return row[key] === undefined ? undefined : String(row[key]);
}
