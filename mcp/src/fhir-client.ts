/**
 * Node-side FHIR client for the OSOD MCP server.
 * Mirrors osod/src/fhir-client.ts (the POC) — PKCE OAuth2, zero SDK coupling.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Bundle, OperationOutcome, Resource } from "@medplum/fhirtypes";

export type JsonPatchOperation =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

interface MedplumClient {
  login(email: string, password: string): Promise<void>;
  read<T extends Resource>(rt: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    rt: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  create<T extends Resource>(r: T, extraHeaders?: Record<string, string>): Promise<T>;
  patch<T extends Resource>(
    rt: T["resourceType"],
    id: string,
    operations: JsonPatchOperation[],
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export function createMedplumClient(opts: { baseUrl: string }): MedplumClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  let token: string | undefined;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/fhir+json",
      Accept: "application/fhir+json",
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async function toError(res: Response): Promise<Error> {
    const body = await res.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as OperationOutcome;
      detail = parsed.issue?.map((i) => i.diagnostics ?? i.code).join("; ") ?? body;
    } catch {
      /* ignore */
    }
    return new Error(`FHIR ${res.status} ${res.statusText}: ${detail}`);
  }

  return {
    async login(email: string, password: string): Promise<void> {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const loginRes = await fetch(`${base}/auth/login`, {
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
      const { code } = (await loginRes.json()) as { login: string; code: string };

      const tokenRes = await fetch(`${base}/oauth2/token`, {
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

    async read<T extends Resource>(rt: T["resourceType"], id: string): Promise<T> {
      const res = await fetch(`${base}/fhir/R4/${rt}/${id}`, { headers: headers() });
      if (!res.ok) throw await toError(res);
      return (await res.json()) as T;
    },

    async search<T extends Resource>(
      rt: T["resourceType"],
      params: Record<string, string> = {},
    ): Promise<Bundle<T>> {
      const qs = new URLSearchParams(params).toString();
      const res = await fetch(`${base}/fhir/R4/${rt}${qs ? "?" + qs : ""}`, {
        headers: headers(),
      });
      if (!res.ok) throw await toError(res);
      return (await res.json()) as Bundle<T>;
    },

    async create<T extends Resource>(
      r: T,
      extraHeaders: Record<string, string> = {},
    ): Promise<T> {
      const res = await fetch(`${base}/fhir/R4/${r.resourceType}`, {
        method: "POST",
        headers: { ...headers(), ...extraHeaders },
        body: JSON.stringify(r),
      });
      if (!res.ok) throw await toError(res);
      return (await res.json()) as T;
    },

    async patch<T extends Resource>(
      rt: T["resourceType"],
      id: string,
      operations: JsonPatchOperation[],
      extraHeaders: Record<string, string> = {},
    ): Promise<T> {
      const res = await fetch(`${base}/fhir/R4/${rt}/${id}`, {
        method: "PATCH",
        headers: {
          ...headers(),
          "Content-Type": "application/json-patch+json",
          ...extraHeaders,
        },
        body: JSON.stringify(operations),
      });
      if (!res.ok) throw await toError(res);
      return (await res.json()) as T;
    },
  };
}
