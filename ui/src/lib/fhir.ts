/**
 * Browser-side FHIR client. Mirrors osod/src/fhir-client.ts (node-side) but uses
 * Web Crypto API for PKCE. Zero Medplum SDK coupling — swappable backend.
 */

import type { Bundle, OperationOutcome, Resource } from "@medplum/fhirtypes";

const BASE = "/fhir/R4"; // Vite dev proxy -> http://localhost:8103
const AUTH = "";

let token: string | undefined;

export type JsonPatchOperation =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

type TransactionResponse<T> = Bundle & { readonly __osodResponseType?: T };

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

async function toError(res: Response): Promise<Error> {
  const body = await res.text();
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
    "X-OSOD-Source": `ui/${sourceTag}`,
  };
}

export const fhir = {
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
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    token = access_token;
  },

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const query = new URLSearchParams(params).toString();
    const url = `${BASE}/${resourceType}${query ? "?" + query : ""}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as Bundle<T>;
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

  async create<T extends Resource>(resource: T, sourceTag: string): Promise<T> {
    const res = await fetch(`${BASE}/${resource.resourceType}`, {
      method: "POST",
      headers: sourceHeaders(sourceTag),
      body: JSON.stringify(resource),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  },

  async patch<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    ops: JsonPatchOperation[],
    sourceTag: string,
  ): Promise<T> {
    const res = await fetch(`${BASE}/${resourceType}/${id}`, {
      method: "PATCH",
      headers: {
        ...sourceHeaders(sourceTag),
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify(ops),
    });
    if (!res.ok) throw await toError(res);
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
    return (await res.json()) as TransactionResponse<T>;
  },
};

function formatOperationOutcome(outcome: OperationOutcome): string | undefined {
  return outcome.issue
    ?.map((issue) => {
      const expression = issue.expression?.length
        ? ` [${issue.expression.join(", ")}]`
        : "";
      return `${issue.diagnostics ?? issue.details?.text ?? issue.code}${expression}`;
    })
    .join("; ");
}
