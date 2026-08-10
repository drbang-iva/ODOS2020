/**
 * Node-side FHIR client for the ODOS MCP server.
 * Mirrors odos/src/fhir-client.ts (the POC) — PKCE OAuth2, zero SDK coupling.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Binary, Bundle, OperationOutcome, ProjectMembership, Resource } from "@medplum/fhirtypes";
import {
  buildOdosAuditEventRow,
  type BuildOdosAuditEventInput,
  type OdosActorRole,
  type OdosAuditEventRecord,
  type OdosAuditEventType,
} from "./authz/odosAudit.js";
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
  actorRole?: OdosActorRole;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  policyUrl?: string;
}

export interface FhirAuditRecorder {
  record<T>(row: OdosAuditEventRecord, operation: () => Promise<T> | T): Promise<T>;
  recordDenied(row: OdosAuditEventRecord): Promise<void>;
}

export interface MedplumClient {
  login(email: string, password: string): Promise<void>;
  read<T extends Resource>(rt: T["resourceType"], id: string): Promise<T>;
  readBinaryData(id: string): Promise<{ contentType: string; bytes: Uint8Array }>;
  search<T extends Resource>(
    rt: T["resourceType"],
    params?: FhirSearchParams,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
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
  executeTransaction(
    bundle: Bundle,
    extraHeaders?: Record<string, string>,
    options?: FhirTransactionExecutionOptions,
  ): Promise<Bundle>;
  getActiveProjectId(): Promise<string>;
  invitePractitioner(
    projectId: string,
    input: MedplumPractitionerInvite,
  ): Promise<ProjectMembership>;
  deleteAttempt(rt: string, id: string, reason?: string): Promise<never>;
  nullifyAttempt(rt: string, id: string, reason?: string): Promise<never>;
}

export interface FhirTransactionExecutionOptions {
  autoRollbackCreatedEntries?: boolean;
}

export type FhirSearchParams = Record<string, string> | URLSearchParams | Array<[string, string]>;

export interface MedplumPractitionerInvite {
  resourceType: "Practitioner";
  email: string;
  firstName: string;
  lastName: string;
  sendEmail: true;
}

interface UnauditedMedplumClientOptions {
  baseUrl: string;
  accessToken?: string;
  refreshAuthentication?: () => Promise<void>;
  now?: () => number;
}

export interface MedplumClientOptions extends UnauditedMedplumClientOptions {
  audit: FhirAuditRecorder;
  auditContext: FhirAuditContext;
}

export function createStaffRouteFhirClient(opts: {
  baseUrl: string;
  accessToken: string;
  staffReference: string;
  actorRole: OdosActorRole;
  audit: FhirAuditRecorder;
}): MedplumClient {
  return createMedplumClient({
    baseUrl: opts.baseUrl,
    accessToken: opts.accessToken,
    audit: opts.audit,
    auditContext: {
      actorId: opts.staffReference.replace(/^Practitioner\//, ""),
      actorRole: opts.actorRole,
    },
  });
}

export function createMedplumClient(opts: MedplumClientOptions): MedplumClient {
  return createMedplumClientInternal(opts);
}

export function createUnauditedMedplumClient_bootOnly(
  opts: UnauditedMedplumClientOptions,
): MedplumClient {
  return createMedplumClientInternal(opts);
}

export function createOperatorScriptFhirClient(
  opts: UnauditedMedplumClientOptions & { reason: string },
): MedplumClient {
  if (!opts.reason.trim()) {
    throw new Error("Operator script FHIR client requires a non-blank unaudited reason.");
  }
  const { reason: _reason, ...clientOptions } = opts;
  return createMedplumClientInternal(clientOptions);
}

function createMedplumClientInternal(opts: UnauditedMedplumClientOptions & {
  audit?: FhirAuditRecorder;
  auditContext?: FhirAuditContext;
}): MedplumClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  let token: string | undefined = opts.accessToken;
  let refreshPromise: Promise<void> | undefined;
  let loginCredentials: { email: string; password: string } | undefined;
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

  async function refresh(): Promise<void> {
    const operation = opts.refreshAuthentication ?? (loginCredentials
      ? () => performLogin(loginCredentials!.email, loginCredentials!.password)
      : undefined);
    if (!operation) return;
    refreshPromise ??= operation().finally(() => {
      refreshPromise = undefined;
    });
    await refreshPromise;
  }

  async function authorizedFetch(
    url: string | URL,
    init: () => RequestInit,
  ): Promise<Response> {
    const canRefresh = Boolean(opts.refreshAuthentication || loginCredentials);
    if (canRefresh && tokenExpiresSoon(token, opts.now?.() ?? Date.now())) {
      await refresh();
    }
    let response = await fetch(url, init());
    if (response.status === 401 && canRefresh) {
      await refresh();
      response = await fetch(url, init());
    }
    return response;
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
    input: BuildOdosAuditEventInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!audit) {
      return operation();
    }

    try {
      return await audit.record(buildOdosAuditEventRow({ ...auditContext, ...input }), operation);
    } catch (error) {
      if (isAccessDeniedError(error)) {
        await audit.recordDenied(
          buildOdosAuditEventRow({
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
        buildOdosAuditEventRow({
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
          buildOdosAuditEventRow({
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

  async function performLogin(email: string, password: string): Promise<void> {
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
  }

  return {
    async login(email: string, password: string): Promise<void> {
      loginCredentials = { email, password };
      await performLogin(email, password);
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
          const res = await authorizedFetch(`${base}/fhir/R4/${rt}/${id}`, () => ({ headers: headers() }));
          if (!res.ok) throw await toError(res);
          return (await res.json()) as T;
        },
      );
    },

    async readBinaryData(id: string): Promise<{ contentType: string; bytes: Uint8Array }> {
      return audited(
        {
          eventType: "read",
          resourceType: "Binary",
          resourceId: id,
          targetReference: `Binary/${id}`,
          actionOutcome: "granted",
        },
        async () => {
          const res = await authorizedFetch(`${base}/fhir/R4/Binary/${id}`, () => ({
            headers: {
              Accept: "application/octet-stream",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          }));
          if (!res.ok) throw await toError(res);
          return {
            contentType: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
            bytes: new Uint8Array(await res.arrayBuffer()),
          };
        },
      );
    },

    async search<T extends Resource>(
      rt: T["resourceType"],
      params: FhirSearchParams = {},
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
          const res = await authorizedFetch(`${base}/fhir/R4/${rt}${qs ? "?" + qs : ""}`, () => ({
            headers: headers(),
          }));
          if (!res.ok) throw await toError(res);
          return (await res.json()) as Bundle<T>;
        },
      );
    },

    async searchUrl<T extends Resource>(url: string, expectedResourceType: T["resourceType"]): Promise<Bundle<T>> {
      const resolved = new URL(url, `${base}/fhir/R4/${expectedResourceType}`);
      const fhirRoot = new URL(`${base}/fhir/R4/`);
      if (resolved.origin !== fhirRoot.origin || !resolved.pathname.startsWith(fhirRoot.pathname)) {
        throw new Error("FHIR next link must stay within the configured FHIR endpoint.");
      }
      const resourceType = resolved.pathname.slice(fhirRoot.pathname.length).split("/")[0];
      if (!resourceType) {
        throw new Error("FHIR next link does not identify a resource search.");
      }
      if (resourceType !== expectedResourceType) {
        throw new Error(`FHIR next link changed resource type from ${expectedResourceType} to ${resourceType}.`);
      }
      const params = Object.fromEntries(resolved.searchParams);
      return audited(
        {
          eventType: "search",
          resourceType,
          patientId: patientIdFromSearch(resourceType, params),
          actionOutcome: "granted",
        },
        async () => {
          const res = await authorizedFetch(resolved, () => ({ headers: headers() }));
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
          const res = await authorizedFetch(`${base}/fhir/R4/${path}${qs ? "?" + qs : ""}`, () => ({
            headers: headers(),
          }));
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
          const res = await authorizedFetch(`${base}/fhir/R4/${rt}/${id}/_history/${versionId}`, () => ({
            headers: headers(),
          }));
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
          const res = await authorizedFetch(`${base}/fhir/R4/${r.resourceType}`, () => ({
            method: "POST",
            headers: { ...headers(), ...extraHeaders },
            body: JSON.stringify(r),
          }));
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
          const res = await authorizedFetch(`${base}/fhir/R4/${rt}/${id}`, () => ({
            method: "PUT",
            headers: { ...headers(), ...extraHeaders },
            body: JSON.stringify(r),
          }));
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
          const res = await authorizedFetch(`${base}/fhir/R4/${rt}/${id}`, () => ({
            method: "PATCH",
            headers: {
              ...headers(),
              "Content-Type": "application/json-patch+json",
              ...extraHeaders,
            },
            body: JSON.stringify(operations),
          }));
          if (!res.ok) throw await toError(res);
          return (await res.json()) as T;
        },
      );
    },

    async executeTransaction(
      bundle: Bundle,
      extraHeaders: Record<string, string> = {},
      options: FhirTransactionExecutionOptions = {},
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
          const res = await authorizedFetch(`${base}/fhir/R4`, () => ({
            method: "POST",
            headers: { ...headers(), ...extraHeaders },
            body: JSON.stringify(transactionBundle),
          }));
          if (!res.ok) throw await toError(res);
          const responseBundle = (await res.json()) as Bundle;
          if (options.autoRollbackCreatedEntries !== false && hasEntryFailure(responseBundle)) {
            await rollbackCreatedEntries(base, headers(), responseBundle, extraHeaders);
          }
          return responseBundle;
        },
      );
    },

    async getActiveProjectId(): Promise<string> {
      const res = await authorizedFetch(`${base}/auth/me`, () => ({ headers: headers() }));
      if (!res.ok) throw await toError(res);
      const body = (await res.json()) as { project?: { id?: string } };
      if (!body.project?.id) throw new Error("The service session has no active Medplum project.");
      return body.project.id;
    },

    async invitePractitioner(
      projectId: string,
      input: MedplumPractitionerInvite,
    ): Promise<ProjectMembership> {
      const res = await authorizedFetch(`${base}/admin/projects/${encodeURIComponent(projectId)}/invite`, () => ({
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }));
      if (!res.ok) throw await toError(res);
      return (await res.json()) as ProjectMembership;
    },

    async deleteAttempt(rt: string, id: string, reason = "mandate-8-boundary delete-attempt"): Promise<never> {
      if (audit) {
        await audit.recordDenied(
          buildOdosAuditEventRow({
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
      throw new Error("ODOS FHIR DELETE is disabled; use entered-in-error/nullification workflows.");
    },

    async nullifyAttempt(rt: string, id: string, reason = "mandate-8-boundary nullify-attempt"): Promise<never> {
      if (audit) {
        await audit.recordDenied(
          buildOdosAuditEventRow({
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
      throw new Error("ODOS FHIR nullification must use an explicit clinical status workflow.");
    },
  };
}

function isBinaryResource(resource: Resource): resource is Binary {
  return resource.resourceType === "Binary";
}

export function tokenExpiresSoon(token: string | undefined, nowMs: number): boolean {
  if (!token) return false;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" && payload.exp * 1000 <= nowMs + 5 * 60_000;
  } catch {
    return false;
  }
}

function patientIdFromSearch(resourceType: string, params: FhirSearchParams): string | undefined {
  const values = params instanceof URLSearchParams
    ? params
    : new URLSearchParams(params);
  if (resourceType === "Patient") {
    return stripReferenceId(values.get("_id") ?? values.get("id") ?? undefined, "Patient");
  }
  return (
    stripReferenceId(values.get("subject") ?? undefined, "Patient") ??
    stripReferenceId(values.get("patient") ?? undefined, "Patient") ??
    stripReferenceId(values.get("context") ?? undefined, "Patient")
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
  fallback: Extract<OdosAuditEventType, "create" | "update" | "patch">,
): OdosAuditEventType {
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
