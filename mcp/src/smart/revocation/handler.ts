import type { Request } from "express";
import type { SmartAuthorizationState, SmartTokenRecord } from "../authorization-server.js";

export interface PatientAccessGrantSummary {
  readonly grant_id: string;
  readonly client_id: string;
  readonly app_name: string;
  readonly vendor: string;
  readonly scopes: readonly string[];
  readonly granted_at: string;
}

export function bearerTokenRecord(
  state: SmartAuthorizationState,
  req: Request,
  now = new Date(),
): SmartTokenRecord | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = header.slice("Bearer ".length).trim();
  const record = state.tokens.get(token);
  if (!record?.active || record.exp <= Math.floor(now.getTime() / 1000)) {
    return undefined;
  }
  return record;
}

export function listActivePatientGrants(
  state: SmartAuthorizationState,
  username: string,
): SmartTokenRecord[] {
  const grants = new Map<string, SmartTokenRecord>();
  for (const record of state.tokens.values()) {
    if (
      record.active &&
      record.tokenKind === "refresh_token" &&
      record.grantId &&
      record.username === username &&
      record.launchContext.patient
    ) {
      grants.set(record.grantId, record);
    }
  }
  return [...grants.values()].sort((a, b) => b.iat - a.iat);
}

export function patientGrantSummaries(
  state: SmartAuthorizationState,
  username: string,
): PatientAccessGrantSummary[] {
  return listActivePatientGrants(state, username).map((grant) => {
    const client = state.clients.get(grant.clientId);
    return {
      grant_id: grant.grantId!,
      client_id: grant.clientId,
      app_name: client?.name ?? grant.clientId,
      vendor: client?.name ?? "Local SMART App",
      scopes: grant.scope.split(/\s+/).filter(Boolean),
      granted_at: new Date(grant.iat * 1000).toISOString(),
    };
  });
}

export function revokePatientGrant(
  state: SmartAuthorizationState,
  grantId: string,
  username: string,
): boolean {
  let matched = false;
  for (const record of state.tokens.values()) {
    if (record.grantId === grantId && record.username === username) {
      record.active = false;
      matched = true;
    }
  }
  if (matched) {
    state.touch();
  }
  return matched;
}
