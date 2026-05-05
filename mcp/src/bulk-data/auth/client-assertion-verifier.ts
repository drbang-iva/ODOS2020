import type { Request } from "express";

export interface BulkDataClientAssertionInput {
  readonly clientId: string;
  readonly assertion: string;
  readonly assertionType: string;
  readonly tokenEndpointAudience: string;
}

export function clientAssertionFromTokenRequest(
  req: Request,
  tokenEndpointAudience: string,
): BulkDataClientAssertionInput | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const assertion = typeof body?.client_assertion === "string" ? body.client_assertion : undefined;
  const assertionType = typeof body?.client_assertion_type === "string" ? body.client_assertion_type : undefined;
  const clientId = typeof body?.client_id === "string" ? body.client_id : undefined;
  if (!assertion || !assertionType || !clientId) {
    return undefined;
  }
  return { clientId, assertion, assertionType, tokenEndpointAudience };
}

export function assertClientAssertionIsTokenEndpointOnly(context: "token-endpoint" | "resource-download"): void {
  if (context !== "token-endpoint") {
    throw new Error("private_key_jwt client assertions are valid only at the token endpoint.");
  }
}
