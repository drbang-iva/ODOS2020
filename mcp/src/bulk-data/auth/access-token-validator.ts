import { createHash } from "node:crypto";
import type { Request } from "express";
import type { SmartAuthorizationState, SmartTokenRecord } from "../../smart/authorization-server.js";
import type { BulkExportJob } from "../types.js";

export type BulkDataAccessTokenValidation =
  | { readonly ok: true; readonly token: SmartTokenRecord }
  | { readonly ok: false; readonly reason: "missing" | "inactive" | "expired" | "wrong-client" | "wrong-scope" };

export type BulkDataAccessTokenValidator = (
  token: string,
  job: BulkExportJob,
  now?: Date,
) => Promise<BulkDataAccessTokenValidation>;

export function bearerTokenFromRequest(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length).trim();
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function createStateBackedAccessTokenValidator(
  state: SmartAuthorizationState,
): BulkDataAccessTokenValidator {
  return async (token, job, now = new Date()) => {
    const record = state.tokens.get(token);
    if (!record) {
      return { ok: false, reason: "inactive" };
    }
    if (!record.active) {
      return { ok: false, reason: "inactive" };
    }
    if (record.exp <= Math.floor(now.getTime() / 1000)) {
      return { ok: false, reason: "expired" };
    }
    if (record.clientId !== job.requestingClientId) {
      return { ok: false, reason: "wrong-client" };
    }
    if (!scopeCoversBulkExport(record.scope, job)) {
      return { ok: false, reason: "wrong-scope" };
    }
    return { ok: true, token: record };
  };
}

export async function validateBulkDataDownloadRequest(input: {
  readonly req: Request;
  readonly job: BulkExportJob;
  readonly validator: BulkDataAccessTokenValidator;
  readonly now?: Date;
}): Promise<BulkDataAccessTokenValidation> {
  const token = bearerTokenFromRequest(input.req);
  if (!token) {
    return { ok: false, reason: "missing" };
  }
  return input.validator(token, input.job, input.now);
}

export function scopeCoversBulkExport(scopeText: string, job: BulkExportJob): boolean {
  const scopes = new Set(scopeText.split(/\s+/).filter(Boolean));
  if (scopes.has(scopeFor("system", "*", "read")) || scopes.has(scopeFor("system", "*", "rs"))) {
    return true;
  }
  const requestedTypes = job.requestedTypes?.length ? job.requestedTypes : manifestResourceTypes(job);
  return requestedTypes.every((resourceType) =>
    scopes.has(scopeFor("system", resourceType, "read")) ||
    scopes.has(scopeFor("system", resourceType, "rs")) ||
    scopes.has(scopeFor("patient", resourceType, "read")) ||
    scopes.has(scopeFor("patient", resourceType, "rs")) ||
    scopes.has(scopeFor("user", resourceType, "read")) ||
    scopes.has(scopeFor("user", resourceType, "rs")),
  );
}

function scopeFor(prefix: "patient" | "system" | "user", resourceType: string, permission: "read" | "rs"): string {
  return `${prefix}/${resourceType}.${permission}`;
}

function manifestResourceTypes(job: BulkExportJob): readonly string[] {
  const outputTypes = job.manifest?.output.map((entry) => entry.type).filter(Boolean);
  return outputTypes?.length ? outputTypes : ["Patient"];
}
