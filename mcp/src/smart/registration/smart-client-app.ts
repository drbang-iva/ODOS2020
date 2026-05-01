import { randomUUID } from "node:crypto";
import type { Device, Endpoint, Extension, Resource } from "@medplum/fhirtypes";
import { parseSmartScopeList } from "../scope.js";

export const SMART_CLIENT_APP_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/smart-client-app";

export const SMART_APP_REGISTRY_POLICY_URL =
  "https://osod.dev/fhir/Policy/smart-app-registry";

export const SMART_APP_ACTIVITY_CODES = [
  "smart-app-register",
  "smart-app-install",
  "smart-app-remove",
  "smart-app-review",
] as const;

export const V055B_SMART_CAPABILITIES = [
  "launch-ehr",
  "launch-standalone",
  "client-public",
  "client-confidential-asymmetric",
  "client-confidential-symmetric",
  "sso-openid-connect",
  "context-banner",
  "context-style",
  "context-ehr-patient",
  "context-ehr-encounter",
  "context-standalone-patient",
  "permission-offline",
  "permission-online",
  "permission-patient",
  "permission-user",
  "permission-v2",
  "permission-v1",
] as const;

export type SmartAppShape = "endpoint" | "device";
export type SmartAppRiskClass = "low" | "moderate" | "high" | "predictive-dsi" | "autonomous-refraction";
export type SmartAppPhiBoundary = "none" | "metadata-only" | "patient-payload";
export type SmartAppLaunchMode = "ehr" | "standalone" | "backend" | "ehr-and-standalone";
export type SmartAppNetworkEgress = "none" | "local-only" | "external-vendor";
export type SmartAppClientType = "public" | "confidential";
export type SmartAppTokenEndpointAuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post"
  | "private_key_jwt";

export interface OSODSmartClientAppMetadata {
  readonly clientType: SmartAppClientType;
  readonly tokenEndpointAuthMethod: SmartAppTokenEndpointAuthMethod;
  readonly redirectUris: readonly string[];
  readonly jwksUri?: string;
  readonly launchUri?: string;
  readonly defaultScope: string;
  readonly allowedOrigin: readonly string[];
  readonly clientName: string;
}

export interface OSODSmartClientAppPolicy {
  readonly riskClass: SmartAppRiskClass;
  readonly phiBoundary: SmartAppPhiBoundary;
  readonly launchMode: SmartAppLaunchMode;
  readonly networkEgress: SmartAppNetworkEgress;
  readonly externalServicesRequired: boolean;
  readonly baaRequired: boolean;
  readonly imageAnalysisProhibited: boolean;
  readonly allowedJurisdictions: readonly string[];
  readonly prohibitedStates: readonly string[];
  readonly scopeRequestCanonical: string;
}

export interface OSODSmartClientApp {
  readonly shape: SmartAppShape;
  readonly canonicalRecord: Endpoint | Device;
  readonly metadata: OSODSmartClientAppMetadata;
  readonly policy: OSODSmartClientAppPolicy;
  readonly clientId?: string;
}

export interface DynamicClientRegistrationInput {
  readonly app_shape?: SmartAppShape;
  readonly redirect_uris?: readonly string[];
  readonly token_endpoint_auth_method?: SmartAppTokenEndpointAuthMethod;
  readonly grant_types?: readonly string[];
  readonly response_types?: readonly string[];
  readonly client_name?: string;
  readonly client_uri?: string;
  readonly logo_uri?: string;
  readonly scope?: string;
  readonly jwks_uri?: string;
  readonly launch_uri?: string;
  readonly allowed_origin?: readonly string[];
  readonly risk_class?: SmartAppRiskClass;
  readonly phi_boundary?: SmartAppPhiBoundary;
  readonly launch_mode?: SmartAppLaunchMode;
  readonly network_egress?: SmartAppNetworkEgress;
  readonly external_services_required?: boolean;
  readonly baa_required?: boolean;
  readonly image_analysis_prohibited?: boolean;
  readonly allowedJurisdictions?: readonly string[];
  readonly prohibitedStates?: readonly string[];
  readonly scope_request_canonical?: string;
}

export class SmartAppRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function buildCanonicalSmartClientApp(input: DynamicClientRegistrationInput): OSODSmartClientApp {
  const redirectUris = stringArray(input.redirect_uris, "redirect_uris");
  if (!redirectUris.length) {
    throw new SmartAppRegistryError("invalid_client_metadata", "redirect_uris is required.");
  }
  for (const redirectUri of redirectUris) {
    assertUrl(redirectUri, "redirect_uris");
  }

  const defaultScope = input.scope_request_canonical ?? input.scope;
  if (!defaultScope) {
    throw new SmartAppRegistryError("invalid_client_metadata", "scope_request_canonical is required.");
  }
  parseSmartScopeList(defaultScope);

  const metadata: OSODSmartClientAppMetadata = {
    clientType: clientType(input.token_endpoint_auth_method),
    tokenEndpointAuthMethod: input.token_endpoint_auth_method ?? "none",
    redirectUris,
    jwksUri: optionalUrl(input.jwks_uri, "jwks_uri"),
    launchUri: optionalUrl(input.launch_uri ?? input.client_uri ?? redirectUris[0], "launch_uri"),
    defaultScope,
    allowedOrigin: stringArray(input.allowed_origin ?? redirectOrigins(redirectUris), "allowed_origin"),
    clientName: input.client_name ?? "Local SMART App",
  };
  if (metadata.tokenEndpointAuthMethod === "private_key_jwt" && !metadata.jwksUri) {
    throw new SmartAppRegistryError("invalid_client_metadata", "jwks_uri is required for private_key_jwt.");
  }
  if (metadata.clientType === "public" && metadata.tokenEndpointAuthMethod !== "none") {
    throw new SmartAppRegistryError("invalid_client_metadata", "public clients must use token_endpoint_auth_method none.");
  }

  const policy: OSODSmartClientAppPolicy = {
    riskClass: requiredEnum(input.risk_class, "risk_class", [
      "low",
      "moderate",
      "high",
      "predictive-dsi",
      "autonomous-refraction",
    ]),
    phiBoundary: requiredEnum(input.phi_boundary, "phi_boundary", ["none", "metadata-only", "patient-payload"]),
    launchMode: requiredEnum(input.launch_mode, "launch_mode", [
      "ehr",
      "standalone",
      "backend",
      "ehr-and-standalone",
    ]),
    networkEgress: requiredEnum(input.network_egress, "network_egress", [
      "none",
      "local-only",
      "external-vendor",
    ]),
    externalServicesRequired: requiredBoolean(input.external_services_required, "external_services_required"),
    baaRequired: requiredBoolean(input.baa_required, "baa_required"),
    imageAnalysisProhibited: requiredBoolean(input.image_analysis_prohibited, "image_analysis_prohibited"),
    allowedJurisdictions: stringArray(input.allowedJurisdictions, "allowedJurisdictions"),
    prohibitedStates: stringArray(input.prohibitedStates, "prohibitedStates"),
    scopeRequestCanonical: defaultScope,
  };
  assertInstallPolicy(policy, { practiceJurisdiction: practiceJurisdiction() });

  const shape = input.app_shape ?? "endpoint";
  const extension = smartClientAppExtension(metadata, policy);
  const canonicalRecord =
    shape === "device"
      ? buildDeviceRecord(metadata, extension)
      : buildEndpointRecord(metadata, extension);
  return { shape, canonicalRecord, metadata, policy };
}

export function assertInstallPolicy(
  policy: OSODSmartClientAppPolicy,
  options: { readonly practiceJurisdiction?: string; readonly adminAttestedCompatibilityGap?: boolean } = {},
): void {
  if (policy.phiBoundary === "patient-payload" && !policy.baaRequired) {
    throw new SmartAppRegistryError(
      "phi-baa-mismatch",
      "Install blocked: patient-payload apps require BAA attestation.",
    );
  }
  if (!policy.imageAnalysisProhibited) {
    throw new SmartAppRegistryError(
      "image-scope-violation",
      "Install blocked: image analysis is prohibited by Mandate 13.",
    );
  }
  const jurisdiction = normalizeJurisdiction(options.practiceJurisdiction);
  if (!jurisdiction) {
    return;
  }
  const allowed = policy.allowedJurisdictions.map(normalizeJurisdiction).filter(Boolean);
  const prohibited = policy.prohibitedStates.map(normalizeJurisdiction).filter(Boolean);
  if (prohibited.includes(jurisdiction)) {
    throw new SmartAppRegistryError(
      "jurisdiction-violation",
      `Install blocked: ${jurisdiction} is prohibited for this app. SC ECCPL ruling 2026-01-21 - https://www.sccourts.org/media/opinions/HTMLFiles/SC/28310.pdf`,
    );
  }
  if (allowed.length && !allowed.includes(jurisdiction)) {
    throw new SmartAppRegistryError(
      "jurisdiction-violation",
      `Install blocked: ${jurisdiction} is outside this app's allowed jurisdictions.`,
    );
  }
}

export function readSmartClientApp(record: Endpoint | Device): OSODSmartClientApp {
  const extension = record.extension?.find((candidate) => candidate.url === SMART_CLIENT_APP_EXTENSION_URL);
  if (!extension) {
    throw new SmartAppRegistryError("missing-smart-client-app-extension", "SMART app extension is missing.");
  }
  const metadata: OSODSmartClientAppMetadata = {
    clientType: extensionCode(extension, "oauth_metadata", "client_type") as SmartAppClientType,
    tokenEndpointAuthMethod: extensionCode(
      extension,
      "oauth_metadata",
      "token_endpoint_auth_method",
    ) as SmartAppTokenEndpointAuthMethod,
    jwksUri: optionalText(extensionValue(extension, "oauth_metadata", "jwks_uri", "valueUri")),
    redirectUris: extensionValues(extension, "oauth_metadata", "redirect_uris", "valueUri"),
    launchUri: optionalText(extensionValue(extension, "oauth_metadata", "launch_uri", "valueUri")),
    defaultScope: requiredText(extensionValue(extension, "oauth_metadata", "default_scope", "valueString"), "default_scope"),
    allowedOrigin: extensionValues(extension, "oauth_metadata", "allowed_origin", "valueUri"),
    clientName: record.resourceType === "Endpoint" ? (record.name ?? "Local SMART App") : record.deviceName?.[0]?.name ?? "Local SMART App",
  };
  const policy: OSODSmartClientAppPolicy = {
    riskClass: requiredText(extensionValue(extension, "risk_class", undefined, "valueCode"), "risk_class") as SmartAppRiskClass,
    phiBoundary: requiredText(extensionValue(extension, "phi_boundary", undefined, "valueCode"), "phi_boundary") as SmartAppPhiBoundary,
    launchMode: requiredText(extensionValue(extension, "launch_mode", undefined, "valueCode"), "launch_mode") as SmartAppLaunchMode,
    networkEgress: requiredText(extensionValue(extension, "network_egress", undefined, "valueCode"), "network_egress") as SmartAppNetworkEgress,
    externalServicesRequired: requiredBool(
      extensionValue(extension, "external_services_required", undefined, "valueBoolean"),
      "external_services_required",
    ),
    baaRequired: requiredBool(extensionValue(extension, "baa_required", undefined, "valueBoolean"), "baa_required"),
    imageAnalysisProhibited: requiredBool(
      extensionValue(extension, "image_analysis_prohibited", undefined, "valueBoolean"),
      "image_analysis_prohibited",
    ),
    allowedJurisdictions: extensionValues(extension, "allowedJurisdictions", undefined, "valueString"),
    prohibitedStates: extensionValues(extension, "prohibitedStates", undefined, "valueString"),
    scopeRequestCanonical: requiredText(
      extensionValue(extension, "scope_request_canonical", undefined, "valueString"),
      "scope_request_canonical",
    ),
  };
  return {
    shape: record.resourceType === "Device" ? "device" : "endpoint",
    canonicalRecord: record,
    metadata,
    policy,
    clientId: record.id,
  };
}

export function smartClientAppExtension(
  metadata: OSODSmartClientAppMetadata,
  policy: OSODSmartClientAppPolicy,
): Extension {
  return {
    url: SMART_CLIENT_APP_EXTENSION_URL,
    extension: [
      {
        url: "oauth_metadata",
        extension: [
          { url: "client_type", valueCode: metadata.clientType },
          { url: "token_endpoint_auth_method", valueCode: metadata.tokenEndpointAuthMethod },
          ...(metadata.jwksUri ? [{ url: "jwks_uri", valueUri: metadata.jwksUri }] : []),
          ...metadata.redirectUris.map((value) => ({ url: "redirect_uris", valueUri: value })),
          ...(metadata.launchUri ? [{ url: "launch_uri", valueUri: metadata.launchUri }] : []),
          { url: "default_scope", valueString: metadata.defaultScope },
          ...metadata.allowedOrigin.map((value) => ({ url: "allowed_origin", valueUri: value })),
        ],
      },
      { url: "risk_class", valueCode: policy.riskClass },
      { url: "phi_boundary", valueCode: policy.phiBoundary },
      { url: "launch_mode", valueCode: policy.launchMode },
      { url: "network_egress", valueCode: policy.networkEgress },
      { url: "external_services_required", valueBoolean: policy.externalServicesRequired },
      { url: "baa_required", valueBoolean: policy.baaRequired },
      { url: "image_analysis_prohibited", valueBoolean: policy.imageAnalysisProhibited },
      ...policy.allowedJurisdictions.map((value) => ({ url: "allowedJurisdictions", valueString: value })),
      ...policy.prohibitedStates.map((value) => ({ url: "prohibitedStates", valueString: value })),
      { url: "scope_request_canonical", valueString: policy.scopeRequestCanonical },
    ],
  };
}

export function smartClientRegistrationResponse(input: {
  readonly app: OSODSmartClientApp;
  readonly clientId: string;
  readonly clientSecret?: string;
}): Record<string, unknown> {
  return {
    client_id: input.clientId,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    client_name: input.app.metadata.clientName,
    redirect_uris: input.app.metadata.redirectUris,
    token_endpoint_auth_method: input.app.metadata.tokenEndpointAuthMethod,
    jwks_uri: input.app.metadata.jwksUri,
    scope: input.app.metadata.defaultScope,
    launch_uri: input.app.metadata.launchUri,
    allowed_origin: input.app.metadata.allowedOrigin,
    app_shape: input.app.shape,
    risk_class: input.app.policy.riskClass,
    phi_boundary: input.app.policy.phiBoundary,
    launch_mode: input.app.policy.launchMode,
    network_egress: input.app.policy.networkEgress,
    external_services_required: input.app.policy.externalServicesRequired,
    baa_required: input.app.policy.baaRequired,
    image_analysis_prohibited: input.app.policy.imageAnalysisProhibited,
    allowedJurisdictions: input.app.policy.allowedJurisdictions,
    prohibitedStates: input.app.policy.prohibitedStates,
    scope_request_canonical: input.app.policy.scopeRequestCanonical,
  };
}

function buildEndpointRecord(metadata: OSODSmartClientAppMetadata, extension: Extension): Endpoint {
  return {
    resourceType: "Endpoint",
    id: `smart-app-${randomUUID()}`,
    status: "active",
    connectionType: {
      system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
      code: "hl7-fhir-rest",
      display: "HL7 FHIR",
    },
    name: metadata.clientName,
    payloadType: [{ text: "SMART App Launch client metadata" }],
    payloadMimeType: ["application/fhir+json"],
    address: metadata.launchUri ?? metadata.redirectUris[0]!,
    extension: [extension],
  };
}

function buildDeviceRecord(metadata: OSODSmartClientAppMetadata, extension: Extension): Device {
  return {
    resourceType: "Device",
    id: `smart-app-${randomUUID()}`,
    status: "active",
    deviceName: [{ name: metadata.clientName, type: "user-friendly-name" }],
    extension: [extension],
  };
}

function clientType(method: SmartAppTokenEndpointAuthMethod | undefined): SmartAppClientType {
  return method === undefined || method === "none" ? "public" : "confidential";
}

function requiredEnum<T extends string>(value: string | undefined, field: string, allowed: readonly T[]): T {
  if (!value || !allowed.includes(value as T)) {
    throw new SmartAppRegistryError("invalid_client_metadata", `${field} is required.`);
  }
  return value as T;
}

function requiredBoolean(value: boolean | undefined, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new SmartAppRegistryError("invalid_client_metadata", `${field} is required.`);
  }
  return value;
}

function stringArray(value: readonly string[] | undefined, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new SmartAppRegistryError("invalid_client_metadata", `${field} is required.`);
  }
  if (value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new SmartAppRegistryError("invalid_client_metadata", `${field} must contain strings.`);
  }
  return value.map((entry) => entry.trim());
}

function optionalUrl(value: string | undefined, field: string): string | undefined {
  if (!value) {
    return undefined;
  }
  assertUrl(value, field);
  return value;
}

function assertUrl(value: string, field: string): void {
  try {
    new URL(value);
  } catch {
    throw new SmartAppRegistryError("invalid_client_metadata", `${field} must be an absolute URL.`);
  }
}

function redirectOrigins(redirectUris: readonly string[]): string[] {
  return [...new Set(redirectUris.map((value) => new URL(value).origin))];
}

function practiceJurisdiction(): string | undefined {
  return process.env.OSOD_PRACTICE_JURISDICTION ?? process.env.OSOD_PRACTICE_STATE;
}

function normalizeJurisdiction(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const upper = value.trim().toUpperCase();
  if (!upper) {
    return undefined;
  }
  return upper.includes("-") ? upper : `US-${upper}`;
}

function extensionCode(extension: Extension, parent: string, child: string): string {
  return requiredText(extensionValue(extension, parent, child, "valueCode"), child);
}

function extensionValue(
  extension: Extension,
  url: string,
  nestedUrl: string | undefined,
  key: "valueBoolean" | "valueCode" | "valueString" | "valueUri",
): string | boolean | undefined {
  const child = extension.extension?.find((candidate) => candidate.url === url);
  const target = nestedUrl ? child?.extension?.find((candidate) => candidate.url === nestedUrl) : child;
  return target?.[key];
}

function extensionValues(
  extension: Extension,
  url: string,
  nestedUrl: string | undefined,
  key: "valueString" | "valueUri",
): string[] {
  const parent = extension.extension?.find((candidate) => candidate.url === url);
  const values = nestedUrl
    ? parent?.extension?.filter((candidate) => candidate.url === nestedUrl).map((candidate) => candidate[key])
    : extension.extension?.filter((candidate) => candidate.url === url).map((candidate) => candidate[key]);
  return (values ?? []).filter((value): value is string => typeof value === "string");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new SmartAppRegistryError("invalid_client_metadata", `${field} is required.`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new SmartAppRegistryError("invalid_client_metadata", `${field} is required.`);
  }
  return value;
}

export type SmartAppCanonicalRecord = Extract<Resource, Endpoint | Device> | Endpoint | Device;
