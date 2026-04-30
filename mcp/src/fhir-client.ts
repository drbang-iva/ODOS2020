/**
 * Node-side FHIR client for the OSOD MCP server.
 * Mirrors osod/src/fhir-client.ts (the POC) — PKCE OAuth2, zero SDK coupling.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Binary, Bundle, OperationOutcome, Resource } from "@medplum/fhirtypes";
import {
  buildOsodAuditEventRow,
  type BuildOsodAuditEventInput,
  type OsodActorRole,
  type OsodAuditEventRecord,
  type OsodAuditEventType,
} from "./authz/osodAudit.js";
import {
  assertBinaryCreateThroughParser,
  assertBinaryPatchAllowed,
} from "./parsers/binarySecurityContext.js";

export type JsonPatchOperation =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

export interface FhirAuditContext {
  actorId?: string;
  actorRole?: OsodActorRole;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  policyUrl?: string;
}

export interface FhirAuditRecorder {
  record<T>(row: OsodAuditEventRecord, operation: () => Promise<T> | T): Promise<T>;
  recordDenied(row: OsodAuditEventRecord): Promise<void>;
}

export interface MedplumClient {
  login(email: string, password: string): Promise<void>;
  read<T extends Resource>(rt: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    rt: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  history<T extends Resource>(
    rt: T["resourceType"],
    id?: string,
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  vread<T extends Resource>(rt: T["resourceType"], id: string, versionId: string): Promise<T>;
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
  deleteAttempt(rt: string, id: string, reason?: string): Promise<never>;
  nullifyAttempt(rt: string, id: string, reason?: string): Promise<never>;
}

export function createMedplumClient(opts: {
  baseUrl: string;
  accessToken?: string;
  audit?: FhirAuditRecorder;
  auditContext?: FhirAuditContext;
}): MedplumClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  let token: string | undefined = opts.accessToken;
  const audit = opts.audit;
  const auditContext = opts.auditContext ?? {};

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
    const error = new Error(`FHIR ${res.status} ${res.statusText}: ${detail}`);
    (error as Error & { status?: number }).status = res.status;
    return error;
  }

  async function audited<T>(
    input: BuildOsodAuditEventInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!audit) {
      return operation();
    }

    try {
      return await audit.record(buildOsodAuditEventRow({ ...auditContext, ...input }), operation);
    } catch (error) {
      if (isAccessDeniedError(error)) {
        await audit.recordDenied(
          buildOsodAuditEventRow({
            ...auditContext,
            ...input,
            eventType: "denied",
            actionOutcome: "denied",
            actionReason: denialReason(error),
          }),
        );
      }
      throw error;
    }
  }

  async function auditedLogin(email: string, operation: () => Promise<void>): Promise<void> {
    if (!audit) {
      return operation();
    }

    try {
      await audit.record(
        buildOsodAuditEventRow({
          ...auditContext,
          eventType: "login",
          actorId: auditContext.actorId ?? email,
          actorRole: auditContext.actorRole ?? "system",
          actionOutcome: "granted",
          actionReason: "authentication-success",
        }),
        operation,
      );
    } catch (error) {
      if (!isAuditSubstrateError(error)) {
        await audit.recordDenied(
          buildOsodAuditEventRow({
            ...auditContext,
            eventType: "login-failed",
            actorId: auditContext.actorId ?? email,
            actorRole: auditContext.actorRole ?? "system",
            actionOutcome: "denied",
            actionReason: "authentication-failed",
          }),
        );
      }
      throw error;
    }
  }

  return {
    async login(email: string, password: string): Promise<void> {
      await auditedLogin(email, async () => {
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
      });
    },

    async read<T extends Resource>(rt: T["resourceType"], id: string): Promise<T> {
      return audited(
        {
          eventType: "read",
          resourceType: String(rt),
          resourceId: id,
          patientId: String(rt) === "Patient" ? id : undefined,
          targetReference: `${String(rt)}/${id}`,
          actionOutcome: "granted",
        },
        async () => {
          const res = await fetch(`${base}/fhir/R4/${rt}/${id}`, { headers: headers() });
          if (!res.ok) throw await toError(res);
          return (await res.json()) as T;
        },
      );
    },

    async search<T extends Resource>(
      rt: T["resourceType"],
      params: Record<string, string> = {},
    ): Promise<Bundle<T>> {
      return audited(
        {
          eventType: "search",
          resourceType: String(rt),
          patientId: patientIdFromSearch(String(rt), params),
          actionOutcome: "granted",
        },
        async () => {
          const qs = new URLSearchParams(params).toString();
          const res = await fetch(`${base}/fhir/R4/${rt}${qs ? "?" + qs : ""}`, {
            headers: headers(),
          });
          if (!res.ok) throw await toError(res);
          return (await res.json()) as Bundle<T>;
        },
      );
    },

    async history<T extends Resource>(
      rt: T["resourceType"],
      id?: string,
      params: Record<string, string> = {},
    ): Promise<Bundle<T>> {
      return audited(
        {
          eventType: "history",
          resourceType: String(rt),
          resourceId: id,
          patientId: String(rt) === "Patient" ? id : undefined,
          targetReference: id ? `${String(rt)}/${id}` : undefined,
          actionOutcome: "granted",
        },
        async () => {
          const qs = new URLSearchParams(params).toString();
          const path = id ? `${rt}/${id}/_history` : `${rt}/_history`;
          const res = await fetch(`${base}/fhir/R4/${path}${qs ? "?" + qs : ""}`, {
            headers: headers(),
          });
          if (!res.ok) throw await toError(res);
          return (await res.json()) as Bundle<T>;
        },
      );
    },

    async vread<T extends Resource>(
      rt: T["resourceType"],
      id: string,
      versionId: string,
    ): Promise<T> {
      return audited(
        {
          eventType: "vread",
          resourceType: String(rt),
          resourceId: id,
          patientId: String(rt) === "Patient" ? id : undefined,
          targetReference: `${String(rt)}/${id}`,
          actionOutcome: "granted",
        },
        async () => {
          const res = await fetch(`${base}/fhir/R4/${rt}/${id}/_history/${versionId}`, {
            headers: headers(),
          });
          if (!res.ok) throw await toError(res);
          return (await res.json()) as T;
        },
      );
    },

    async create<T extends Resource>(
      r: T,
      extraHeaders: Record<string, string> = {},
    ): Promise<T> {
      if (isBinaryResource(r)) {
        assertBinaryCreateThroughParser(r, extraHeaders);
      }
      return audited(
        {
          eventType: auditEventTypeForFhirWrite(r.resourceType, "create"),
          resourceType: r.resourceType,
          resourceId: r.id,
          patientId: patientIdFromResource(r),
          targetReference: r.id ? `${r.resourceType}/${r.id}` : undefined,
          actionOutcome: "granted",
        },
        async () => {
          const res = await fetch(`${base}/fhir/R4/${r.resourceType}`, {
            method: "POST",
            headers: { ...headers(), ...extraHeaders },
            body: JSON.stringify(r),
          });
          if (!res.ok) throw await toError(res);
          return (await res.json()) as T;
        },
      );
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
      return audited(
        {
          eventType: auditEventTypeForFhirWrite(String(rt), "update"),
          resourceType: String(rt),
          resourceId: id,
          patientId: patientIdFromResource(r) ?? (String(rt) === "Patient" ? id : undefined),
          targetReference: `${String(rt)}/${id}`,
          actionOutcome: "granted",
        },
        async () => {
          const res = await fetch(`${base}/fhir/R4/${rt}/${id}`, {
            method: "PUT",
            headers: { ...headers(), ...extraHeaders },
            body: JSON.stringify(r),
          });
          if (!res.ok) throw await toError(res);
          return (await res.json()) as T;
        },
      );
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
      return audited(
        {
          eventType: auditEventTypeForFhirWrite(String(rt), "patch"),
          resourceType: String(rt),
          resourceId: id,
          patientId: String(rt) === "Patient" ? id : undefined,
          targetReference: `${String(rt)}/${id}`,
          actionOutcome: "granted",
        },
        async () => {
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
      );
    },

    async executeTransaction(
      bundle: Bundle,
      extraHeaders: Record<string, string> = {},
    ): Promise<Bundle> {
      const transactionBundle: Bundle = { ...bundle, type: "transaction" };
      assertTransactionBinaryWritesUseParser(transactionBundle, extraHeaders);
      return audited(
        {
          eventType: "transaction",
          resourceType: "Bundle",
          resourceId: transactionBundle.id,
          patientId: patientIdFromBundle(transactionBundle),
          actionOutcome: "granted",
        },
        async () => {
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
      );
    },

    async deleteAttempt(rt: string, id: string, reason = "mandate-8-boundary delete-attempt"): Promise<never> {
      if (audit) {
        await audit.recordDenied(
          buildOsodAuditEventRow({
            ...auditContext,
            eventType: "delete-attempt",
            resourceType: rt,
            resourceId: id,
            patientId: rt === "Patient" ? id : undefined,
            targetReference: `${rt}/${id}`,
            actionOutcome: "denied",
            actionReason: reason,
          }),
        );
      }
      throw new Error("OSOD FHIR DELETE is disabled; use entered-in-error/nullification workflows.");
    },

    async nullifyAttempt(rt: string, id: string, reason = "mandate-8-boundary nullify-attempt"): Promise<never> {
      if (audit) {
        await audit.recordDenied(
          buildOsodAuditEventRow({
            ...auditContext,
            eventType: "nullify-attempt",
            resourceType: rt,
            resourceId: id,
            patientId: rt === "Patient" ? id : undefined,
            targetReference: `${rt}/${id}`,
            actionOutcome: "denied",
            actionReason: reason,
          }),
        );
      }
      throw new Error("OSOD FHIR nullification must use an explicit clinical status workflow.");
    },
  };
}

function isBinaryResource(resource: Resource): resource is Binary {
  return resource.resourceType === "Binary";
}

function patientIdFromSearch(resourceType: string, params: Record<string, string>): string | undefined {
  if (resourceType === "Patient") {
    return stripReferenceId(params._id ?? params.id, "Patient");
  }
  return (
    stripReferenceId(params.subject, "Patient") ??
    stripReferenceId(params.patient, "Patient") ??
    stripReferenceId(params.context, "Patient")
  );
}

function patientIdFromBundle(bundle: Bundle): string | undefined {
  for (const entry of bundle.entry ?? []) {
    if (entry.resource) {
      const patientId = patientIdFromResource(entry.resource);
      if (patientId) {
        return patientId;
      }
    }
  }
  return undefined;
}

function patientIdFromResource(resource: Resource): string | undefined {
  if (resource.resourceType === "Patient") {
    return resource.id;
  }

  const withReferences = resource as Resource & {
    subject?: { reference?: string };
    patient?: { reference?: string };
    for?: { reference?: string };
    securityContext?: { reference?: string };
    context?: { reference?: string };
  };

  return (
    stripReferenceId(withReferences.subject?.reference, "Patient") ??
    stripReferenceId(withReferences.patient?.reference, "Patient") ??
    stripReferenceId(withReferences.for?.reference, "Patient") ??
    stripReferenceId(withReferences.securityContext?.reference, "Patient") ??
    stripReferenceId(withReferences.context?.reference, "Patient")
  );
}

export function auditEventTypeForFhirWrite(
  resourceType: string,
  fallback: Extract<OsodAuditEventType, "create" | "update" | "patch">,
): OsodAuditEventType {
  if (resourceType === "AccessPolicy") {
    return "policy-change";
  }
  if (resourceType === "ProjectMembership") {
    return fallback === "create" ? "projectmembership-lifecycle" : "role-change";
  }
  return fallback;
}

function stripReferenceId(value: string | undefined, resourceType: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const prefix = `${resourceType}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length).split("/")[0] : undefined;
}

function isAccessDeniedError(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  return status === 401 || status === 403;
}

function isAuditSubstrateError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("audit substrate unavailable");
}

function denialReason(error: unknown): string {
  const status = (error as { status?: number } | undefined)?.status;
  if (status === 401) {
    return "authentication-failed";
  }
  return `access-policy-compartment-isolation: ${
    error instanceof Error ? error.message : String(error)
  }`;
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
