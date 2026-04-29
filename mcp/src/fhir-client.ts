/**
 * Node-side FHIR client for the OSOD MCP server.
 * Mirrors osod/src/fhir-client.ts (the POC) — PKCE OAuth2, zero SDK coupling.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Binary, Bundle, OperationOutcome, Resource } from "@medplum/fhirtypes";
import {
  assertBinaryCreateThroughParser,
  assertBinaryPatchAllowed,
} from "./parsers/binarySecurityContext.js";

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
  update<T extends Resource>(
    rt: T["resourceType"],
    id: string,
    r: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  patch<T extends Resource>(
    rt: T["resourceType"],
    id: string,
    operations: JsonPatchOperation[],
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  executeTransaction(bundle: Bundle, extraHeaders?: Record<string, string>): Promise<Bundle>;
}

export function createMedplumClient(opts: { baseUrl: string; accessToken?: string }): MedplumClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  let token: string | undefined = opts.accessToken;

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
      detail = formatOperationOutcome(parsed) ?? body;
    } catch {
      /* ignore */
    }
    return new Error(`FHIR ${res.status} ${res.statusText}: ${detail}`);
  }

  return {
    async login(email: string, password: string): Promise<void> {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const loginRes = await fetchWithThrottleRetry(`${base}/auth/login`, {
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

      const tokenRes = await fetchWithThrottleRetry(`${base}/oauth2/token`, {
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
      if (isBinaryResource(r)) {
        assertBinaryCreateThroughParser(r, extraHeaders);
      }
      const res = await fetch(`${base}/fhir/R4/${r.resourceType}`, {
        method: "POST",
        headers: { ...headers(), ...extraHeaders },
        body: JSON.stringify(r),
      });
      if (!res.ok) throw await toError(res);
      return (await res.json()) as T;
    },

    async update<T extends Resource>(
      rt: T["resourceType"],
      id: string,
      r: T,
      extraHeaders: Record<string, string> = {},
    ): Promise<T> {
      if (rt === "Binary" && isBinaryResource(r)) {
        assertBinaryCreateThroughParser(r, extraHeaders);
      }
      const res = await fetch(`${base}/fhir/R4/${rt}/${id}`, {
        method: "PUT",
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
      if (rt === "Binary") {
        assertBinaryPatchAllowed({ operations });
      }
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

    async executeTransaction(
      bundle: Bundle,
      extraHeaders: Record<string, string> = {},
    ): Promise<Bundle> {
      const transactionBundle: Bundle = { ...bundle, type: "transaction" };
      assertTransactionBinaryWritesUseParser(transactionBundle, extraHeaders);
      const res = await fetch(`${base}/fhir/R4`, {
        method: "POST",
        headers: { ...headers(), ...extraHeaders },
        body: JSON.stringify(transactionBundle),
      });
      if (!res.ok) throw await toError(res);
      const responseBundle = (await res.json()) as Bundle;
      if (hasEntryFailure(responseBundle)) {
        await rollbackCreatedEntries(base, headers(), responseBundle, extraHeaders);
      }
      return responseBundle;
    },
  };
}

function isBinaryResource(resource: Resource): resource is Binary {
  return resource.resourceType === "Binary";
}

function assertTransactionBinaryWritesUseParser(
  bundle: Bundle,
  extraHeaders: Record<string, string>,
): void {
  for (const entry of bundle.entry ?? []) {
    const method = entry.request?.method;
    const url = entry.request?.url ?? "";
    const isPersistedBinaryWrite =
      (method === "POST" && url === "Binary") ||
      ((method === "PUT" || method === "PATCH") && url.startsWith("Binary/"));

    if (!isPersistedBinaryWrite) {
      continue;
    }

    if (method === "PATCH") {
      assertBinaryPatchAllowed({ operations: binaryPatchOperations(entry.resource) });
      continue;
    }

    if (!entry.resource || !isBinaryResource(entry.resource)) {
      throw new Error("Binary transaction write must include a Binary resource body.");
    }
    assertBinaryCreateThroughParser(entry.resource, extraHeaders);
  }
}

function binaryPatchOperations(resource: Resource | undefined): JsonPatchOperation[] {
  if (!resource || resource.resourceType !== "Binary") {
    return [];
  }

  const data = (resource as Binary).data;
  if (!data) {
    return [];
  }

  try {
    return JSON.parse(Buffer.from(data, "base64").toString("utf8")) as JsonPatchOperation[];
  } catch {
    return [];
  }
}

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

function hasEntryFailure(bundle: Bundle): boolean {
  return (bundle.entry ?? []).some((entry) => {
    const status = entry.response?.status;
    return !status || !/^2\d\d/.test(status);
  });
}

async function rollbackCreatedEntries(
  base: string,
  authHeaders: Record<string, string>,
  bundle: Bundle,
  extraHeaders: Record<string, string>,
): Promise<void> {
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
    await fetch(`${base}/fhir/R4/${location}`, {
      method: "DELETE",
      headers: { ...authHeaders, ...extraHeaders },
    }).catch(() => undefined);
  }
}

async function fetchWithThrottleRetry(
  url: string,
  init: RequestInit,
  attempts = 2,
): Promise<Response> {
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt === attempts) {
      return res;
    }

    const body = await res.text();
    await wait(throttleDelayMs(body));
  }

  throw new Error("unreachable throttle retry state");
}

function throttleDelayMs(body: string): number {
  try {
    const parsed = JSON.parse(body) as { issue?: Array<{ diagnostics?: string }> };
    const diagnostics = parsed.issue?.find((issue) => issue.diagnostics)?.diagnostics;
    if (diagnostics) {
      const detail = JSON.parse(diagnostics) as { _msBeforeNext?: number };
      if (typeof detail._msBeforeNext === "number" && detail._msBeforeNext > 0) {
        return detail._msBeforeNext + 250;
      }
    }
  } catch {
    /* fall through */
  }

  return 5_000;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
