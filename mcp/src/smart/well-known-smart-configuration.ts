import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { sanitizeSmartDiscoveryStrings } from "./well-known-synthesis.js";

export interface SmartConfigurationSnapshot {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly introspectionEndpoint: string;
  readonly revocationEndpoint: string;
  readonly jwksUri: string;
  readonly registrationEndpoint: string;
  readonly cdsHooksEndpoint: string;
  readonly cdsCapabilities: readonly string[];
  readonly osodExtensions?: {
    readonly agentopsEndpoint?: string;
    readonly agentopsCapabilities?: readonly string[];
  };
  readonly scopesSupported: readonly string[];
  readonly responseTypesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
  readonly capabilities: readonly string[];
  readonly tokenEndpointAuthMethodsSupported: readonly string[];
  readonly tokenEndpointAuthSigningAlgValuesSupported: readonly string[];
  readonly grantTypesSupported: readonly string[];
  readonly updatedAt: string;
  readonly practicePublicBaseUrl?: string;
}

export interface SmartConfigurationDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly token_endpoint_auth_signing_alg_values_supported: readonly string[];
  readonly revocation_endpoint: string;
  readonly introspection_endpoint: string;
  readonly jwks_uri: string;
  readonly registration_endpoint: string;
  readonly cds_hooks_endpoint: string;
  readonly cds_capabilities: readonly string[];
  readonly osod_extensions?: {
    readonly agentops_endpoint?: string;
    readonly agentops_capabilities?: readonly string[];
    readonly bulk_data?: {
      readonly export_endpoints: {
        readonly group_export: "Group/{id}/$export";
        readonly patient_export: "Patient/$export";
        readonly system_export: "$export";
      };
      readonly requires_access_token_default: true;
      readonly retention_days_default: number;
      readonly supported_type_filter: boolean;
    };
  };
  readonly scopes_supported: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly capabilities: readonly string[];
}

export function buildSmartConfiguration(snapshot: SmartConfigurationSnapshot): SmartConfigurationDocument {
  const document = {
    issuer: snapshot.issuer,
    authorization_endpoint: snapshot.authorizationEndpoint,
    token_endpoint: snapshot.tokenEndpoint,
    token_endpoint_auth_methods_supported: snapshot.tokenEndpointAuthMethodsSupported,
    token_endpoint_auth_signing_alg_values_supported: snapshot.tokenEndpointAuthSigningAlgValuesSupported,
    revocation_endpoint: snapshot.revocationEndpoint,
    introspection_endpoint: snapshot.introspectionEndpoint,
    jwks_uri: snapshot.jwksUri,
    registration_endpoint: snapshot.registrationEndpoint,
    cds_hooks_endpoint: snapshot.cdsHooksEndpoint,
    cds_capabilities: snapshot.cdsCapabilities,
    ...(snapshot.osodExtensions
      ? {
          osod_extensions: {
            agentops_endpoint: snapshot.osodExtensions.agentopsEndpoint,
            agentops_capabilities: snapshot.osodExtensions.agentopsCapabilities,
            bulk_data: {
              export_endpoints: {
                group_export: "Group/{id}/$export",
                patient_export: "Patient/$export",
                system_export: "$export",
              } as const,
              requires_access_token_default: true as const,
              retention_days_default: Number(process.env.OSOD_BULK_EXPORT_RETENTION_DAYS ?? 7),
              supported_type_filter: false,
            },
          },
        }
      : {}),
    scopes_supported: snapshot.scopesSupported,
    response_types_supported: snapshot.responseTypesSupported,
    grant_types_supported: snapshot.grantTypesSupported,
    code_challenge_methods_supported: snapshot.codeChallengeMethodsSupported,
    capabilities: snapshot.capabilities,
  };
  return sanitizeSmartDiscoveryStrings(
    document,
    snapshot.practicePublicBaseUrl ?? process.env.OSOD_PRACTICE_PUBLIC_BASE_URL ?? snapshot.issuer,
  );
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
  res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
  res.setHeader("ETag", etag);
  if (req.header("if-none-match") === etag) {
    res.status(304).end();
    return;
  }
  res.json(buildSmartConfiguration(snapshot));
}
