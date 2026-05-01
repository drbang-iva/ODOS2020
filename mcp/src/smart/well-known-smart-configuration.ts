import { createHash } from "node:crypto";
import type { Request, Response } from "express";

export interface SmartConfigurationSnapshot {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly introspectionEndpoint: string;
  readonly revocationEndpoint: string;
  readonly jwksUri: string;
  readonly registrationEndpoint: string;
  readonly scopesSupported: readonly string[];
  readonly responseTypesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
  readonly capabilities: readonly string[];
  readonly tokenEndpointAuthMethodsSupported: readonly string[];
  readonly grantTypesSupported: readonly string[];
  readonly updatedAt: string;
}

export interface SmartConfigurationDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly revocation_endpoint: string;
  readonly introspection_endpoint: string;
  readonly jwks_uri: string;
  readonly registration_endpoint: string;
  readonly scopes_supported: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly capabilities: readonly string[];
}

export function buildSmartConfiguration(snapshot: SmartConfigurationSnapshot): SmartConfigurationDocument {
  return {
    issuer: snapshot.issuer,
    authorization_endpoint: snapshot.authorizationEndpoint,
    token_endpoint: snapshot.tokenEndpoint,
    token_endpoint_auth_methods_supported: snapshot.tokenEndpointAuthMethodsSupported,
    revocation_endpoint: snapshot.revocationEndpoint,
    introspection_endpoint: snapshot.introspectionEndpoint,
    jwks_uri: snapshot.jwksUri,
    registration_endpoint: snapshot.registrationEndpoint,
    scopes_supported: snapshot.scopesSupported,
    response_types_supported: snapshot.responseTypesSupported,
    grant_types_supported: snapshot.grantTypesSupported,
    code_challenge_methods_supported: snapshot.codeChallengeMethodsSupported,
    capabilities: snapshot.capabilities,
  };
}

export function smartConfigurationEtag(snapshot: SmartConfigurationSnapshot): string {
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("base64url");
  return `"${hash}"`;
}

export function sendSmartConfiguration(
  req: Request,
  res: Response,
  snapshot: SmartConfigurationSnapshot,
): void {
  const etag = smartConfigurationEtag(snapshot);
  res.type("application/json");
  res.setHeader("Cache-Control", "private, max-age=60, must-revalidate");
  res.setHeader("ETag", etag);
  if (req.header("if-none-match") === etag) {
    res.status(304).end();
    return;
  }
  res.json(buildSmartConfiguration(snapshot));
}
