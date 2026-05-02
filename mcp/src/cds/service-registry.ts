import type { Endpoint, Extension, Provenance, Resource } from "@medplum/fhirtypes";
import {
  CDS_SERVICE_ACTIVITY_CODE_SYSTEM,
  CDS_SERVICE_EXTENSION_URL,
  CDS_SERVICE_REGISTRY_POLICY_URL,
  DEFAULT_CARD_TTL_MINUTES,
  DEFAULT_EXTERNAL_CDS_TIMEOUT_SECONDS,
  type CdsHookId,
  type CdsServiceDiscoveryEntry,
  type CdsServiceMetadata,
  type CdsNetworkEgress,
  type CdsPhiBoundary,
  type CdsRiskClass,
} from "./types.js";
import type { OsodActorRole } from "../authz/osodAudit.js";

export interface CdsServiceRegistrationInput {
  readonly service_id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly endpoint_url?: string;
  readonly cds_risk_class?: CdsRiskClass;
  readonly phi_boundary?: CdsPhiBoundary;
  readonly launch_mode?: "cds-service";
  readonly network_egress?: CdsNetworkEgress;
  readonly external_services_required?: boolean;
  readonly baa_required?: boolean;
  readonly admin_baa_confirmed?: boolean;
  readonly image_analysis_prohibited?: boolean;
  readonly image_analysis_payload?: boolean;
  readonly patient_engagement_vendor_profile?: boolean;
  readonly allowedJurisdictions?: readonly string[];
  readonly prohibitedStates?: readonly string[];
  readonly scope_request_canonical?: string;
  readonly hook_subscriptions?: readonly CdsHookId[];
  readonly card_ttl_minutes?: number;
  readonly request_timeout_seconds?: number;
  readonly admin_review_approved?: boolean;
}

export interface CdsServiceRegistryStore {
  create(record: Endpoint): Promise<Endpoint>;
  update?(record: Endpoint): Promise<Endpoint>;
  createProvenance?(provenance: Provenance): Promise<Provenance>;
  read(id: string): Promise<Endpoint | undefined>;
  list(): Promise<Endpoint[]>;
}

export interface RegisteredCdsService {
  readonly endpoint: Endpoint;
  readonly metadata: CdsServiceMetadata;
}

export class CdsServiceRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class InMemoryCdsServiceRegistryStore implements CdsServiceRegistryStore {
  readonly records = new Map<string, Endpoint>();
  readonly provenance = new Map<string, Provenance>();

  async create(record: Endpoint): Promise<Endpoint> {
    const stored = { ...record, id: record.id ?? `cds-service-${this.records.size + 1}` };
    this.records.set(stored.id!, stored);
    return stored;
  }

  async update(record: Endpoint): Promise<Endpoint> {
    if (!record.id || !this.records.has(record.id)) {
      throw new CdsServiceRegistryError("not_found", "CDS service not found.", 404);
    }
    this.records.set(record.id, record);
    return record;
  }

  async createProvenance(provenance: Provenance): Promise<Provenance> {
    const stored = { ...provenance, id: provenance.id ?? `cds-service-provenance-${this.provenance.size + 1}` };
    this.provenance.set(stored.id!, stored);
    return stored;
  }

  async read(id: string): Promise<Endpoint | undefined> {
    return this.records.get(id);
  }

  async list(): Promise<Endpoint[]> {
    return [...this.records.values()];
  }
}

export function buildCanonicalCdsService(input: CdsServiceRegistrationInput): RegisteredCdsService {
  if (!input.admin_review_approved) {
    throw new CdsServiceRegistryError(
      "pending_admin_review",
      "CDS service registration requires staged practice-admin review before activation.",
      202,
    );
  }
  const metadata: CdsServiceMetadata = {
    serviceId: requiredText(input.service_id, "service_id"),
    title: requiredText(input.title, "title"),
    description: requiredText(input.description, "description"),
    endpointUrl: requiredUrl(input.endpoint_url, "endpoint_url"),
    cdsRiskClass: requiredEnum(input.cds_risk_class, "cds_risk_class", [
      "LOW",
      "MEDIUM",
      "HIGH",
      "SaMD-boundary-adjacent",
    ]),
    phiBoundary: requiredEnum(input.phi_boundary, "phi_boundary", [
      "none",
      "read-only",
      "read-write",
      "patient-payload",
    ]),
    launchMode: requiredEnum(input.launch_mode, "launch_mode", ["cds-service"]),
    networkEgress: requiredEnum(input.network_egress, "network_egress", [
      "none",
      "allowlist-required",
      "unrestricted",
    ]),
    externalServicesRequired: requiredBoolean(input.external_services_required, "external_services_required"),
    baaRequired: requiredBoolean(input.baa_required, "baa_required"),
    imageAnalysisProhibited: requiredBoolean(input.image_analysis_prohibited, "image_analysis_prohibited"),
    allowedJurisdictions: stringArray(input.allowedJurisdictions ?? [], "allowedJurisdictions"),
    prohibitedStates: stringArray(input.prohibitedStates ?? [], "prohibitedStates"),
    scopeRequestCanonical: requiredText(input.scope_request_canonical, "scope_request_canonical"),
    hookSubscriptions: hookArray(input.hook_subscriptions),
    cardTtlMinutes: positiveInteger(input.card_ttl_minutes ?? DEFAULT_CARD_TTL_MINUTES, "card_ttl_minutes"),
    requestTimeoutSeconds: positiveInteger(
      input.request_timeout_seconds ?? DEFAULT_EXTERNAL_CDS_TIMEOUT_SECONDS,
      "request_timeout_seconds",
    ),
    adminReviewStatus: "approved",
  };
  assertCdsServicePolicy(metadata, input);
  return {
    metadata,
    endpoint: buildEndpointRecord(metadata),
  };
}

export function assertCdsServicePolicy(
  metadata: CdsServiceMetadata,
  input: Pick<
    CdsServiceRegistrationInput,
    "admin_baa_confirmed" | "image_analysis_payload" | "patient_engagement_vendor_profile"
  > = {},
  options: { readonly practiceJurisdiction?: string } = {},
): void {
  if (!metadata.imageAnalysisProhibited || input.image_analysis_payload) {
    throw new CdsServiceRegistryError(
      "image-scope-violation",
      "Registration blocked: CDS services cannot declare image-analysis payload handling in v0.55c.",
    );
  }
  if (metadata.baaRequired && !input.admin_baa_confirmed) {
    throw new CdsServiceRegistryError(
      "baa-attestation-required",
      "Registration blocked: practice-admin BAA confirmation is required for this CDS service.",
    );
  }
  if (metadata.phiBoundary === "patient-payload" && !metadata.baaRequired) {
    throw new CdsServiceRegistryError(
      "phi-baa-mismatch",
      "Registration blocked: patient-payload CDS services require BAA metadata.",
    );
  }
  if (input.patient_engagement_vendor_profile) {
    throw new CdsServiceRegistryError(
      "patient-engagement-excised",
      "Registration blocked: patient-engagement CDS services are outside v0.55c scope.",
    );
  }
  const jurisdiction = normalizeJurisdiction(options.practiceJurisdiction ?? practiceJurisdiction());
  if (!jurisdiction) {
    return;
  }
  const allowed = metadata.allowedJurisdictions.map(normalizeJurisdiction).filter(Boolean);
  const prohibited = metadata.prohibitedStates.map(normalizeJurisdiction).filter(Boolean);
  if (prohibited.includes(jurisdiction)) {
    throw new CdsServiceRegistryError(
      "jurisdiction-violation",
      `Registration blocked: ${jurisdiction} is prohibited for this CDS service.`,
    );
  }
  if (allowed.length && !allowed.includes(jurisdiction)) {
    throw new CdsServiceRegistryError(
      "jurisdiction-violation",
      `Registration blocked: ${jurisdiction} is outside this CDS service's allowed jurisdictions.`,
    );
  }
}

export function readCdsServiceEndpoint(record: Endpoint): RegisteredCdsService {
  const extension = record.extension?.find((candidate) => candidate.url === CDS_SERVICE_EXTENSION_URL);
  if (!extension) {
    throw new CdsServiceRegistryError("missing-cds-service-extension", "CDS service extension is missing.");
  }
  const metadata: CdsServiceMetadata = {
    serviceId: requiredText(record.id, "service_id"),
    title: record.name ?? requiredText(extensionText(extension, "title"), "title"),
    description: requiredText(extensionText(extension, "description"), "description"),
    endpointUrl: record.address ?? requiredText(extensionText(extension, "endpoint_url"), "endpoint_url"),
    cdsRiskClass: requiredText(extensionCode(extension, "cds_risk_class"), "cds_risk_class") as CdsRiskClass,
    phiBoundary: requiredText(extensionCode(extension, "phi_boundary"), "phi_boundary") as CdsPhiBoundary,
    launchMode: requiredText(extensionCode(extension, "launch_mode"), "launch_mode") as "cds-service",
    networkEgress: requiredText(extensionCode(extension, "network_egress"), "network_egress") as CdsNetworkEgress,
    externalServicesRequired: requiredBool(extensionValue(extension, "external_services_required", "valueBoolean"), "external_services_required"),
    baaRequired: requiredBool(extensionValue(extension, "baa_required", "valueBoolean"), "baa_required"),
    imageAnalysisProhibited: requiredBool(extensionValue(extension, "image_analysis_prohibited", "valueBoolean"), "image_analysis_prohibited"),
    allowedJurisdictions: extensionValues(extension, "allowedJurisdictions"),
    prohibitedStates: extensionValues(extension, "prohibitedStates"),
    scopeRequestCanonical: requiredText(extensionText(extension, "scope_request_canonical"), "scope_request_canonical"),
    hookSubscriptions: extensionValues(extension, "hook_subscriptions") as CdsHookId[],
    cardTtlMinutes: Number(extensionValue(extension, "card_ttl_minutes", "valueInteger") ?? DEFAULT_CARD_TTL_MINUTES),
    requestTimeoutSeconds: Number(
      extensionValue(extension, "request_timeout_seconds", "valueInteger") ?? DEFAULT_EXTERNAL_CDS_TIMEOUT_SECONDS,
    ),
    adminReviewStatus: requiredText(extensionCode(extension, "admin_review_status"), "admin_review_status") as CdsServiceMetadata["adminReviewStatus"],
  };
  return { endpoint: record, metadata };
}

export function cdsServiceDiscoveryEntry(service: RegisteredCdsService): CdsServiceDiscoveryEntry {
  return {
    id: service.metadata.serviceId,
    hook: service.metadata.hookSubscriptions[0] ?? "order-sign",
    title: service.metadata.title,
    description: service.metadata.description,
    usageRequirements: "External CDS services are per-practice opt-in only.",
  };
}

export function buildCdsServiceProvenance(input: {
  readonly target: string;
  readonly activityCode: "register" | "nullify" | "amend";
  readonly recorded: string;
  readonly actorId: string;
  readonly actorRole: OsodActorRole;
}): Provenance {
  return {
    resourceType: "Provenance",
    target: [{ reference: input.target }],
    recorded: input.recorded,
    policy: [CDS_SERVICE_REGISTRY_POLICY_URL],
    activity: {
      coding: [
        {
          system: CDS_SERVICE_ACTIVITY_CODE_SYSTEM,
          code: input.activityCode,
          display: input.activityCode,
        },
      ],
      text: input.activityCode,
    },
    agent: [
      {
        role: [{ text: input.actorRole }],
        who: { reference: input.actorRole === "system" ? "Device/osod-instance" : `Practitioner/${input.actorId}` },
      },
    ],
  };
}

export function activeCdsServiceEndpoints(records: readonly Endpoint[]): RegisteredCdsService[] {
  return records.flatMap((record) => {
    try {
      const service = readCdsServiceEndpoint(record);
      return record.status === "active" && service.metadata.adminReviewStatus === "approved" ? [service] : [];
    } catch {
      return [];
    }
  });
}

export function deactivateCdsServiceEndpoint(record: Endpoint): Endpoint {
  const service = readCdsServiceEndpoint(record);
  return {
    ...record,
    status: "off",
    extension: [
      cdsServiceExtension({
        ...service.metadata,
        adminReviewStatus: "deactivated",
      }),
    ],
  };
}

function buildEndpointRecord(metadata: CdsServiceMetadata): Endpoint {
  return {
    resourceType: "Endpoint",
    id: metadata.serviceId,
    status: "active",
    connectionType: {
      system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
      code: "hl7-fhir-rest",
      display: "HL7 FHIR",
    },
    name: metadata.title,
    payloadType: [{ text: "CDS Hooks 2.0.1 service metadata" }],
    payloadMimeType: ["application/json"],
    address: metadata.endpointUrl,
    extension: [cdsServiceExtension(metadata)],
  };
}

function cdsServiceExtension(metadata: CdsServiceMetadata): Extension {
  return {
    url: CDS_SERVICE_EXTENSION_URL,
    extension: [
      { url: "title", valueString: metadata.title },
      { url: "description", valueString: metadata.description },
      { url: "endpoint_url", valueUri: metadata.endpointUrl },
      { url: "cds_risk_class", valueCode: metadata.cdsRiskClass },
      { url: "phi_boundary", valueCode: metadata.phiBoundary },
      { url: "launch_mode", valueCode: metadata.launchMode },
      { url: "network_egress", valueCode: metadata.networkEgress },
      { url: "external_services_required", valueBoolean: metadata.externalServicesRequired },
      { url: "baa_required", valueBoolean: metadata.baaRequired },
      { url: "image_analysis_prohibited", valueBoolean: metadata.imageAnalysisProhibited },
      ...metadata.allowedJurisdictions.map((value) => ({ url: "allowedJurisdictions", valueString: value })),
      ...metadata.prohibitedStates.map((value) => ({ url: "prohibitedStates", valueString: value })),
      { url: "scope_request_canonical", valueString: metadata.scopeRequestCanonical },
      ...metadata.hookSubscriptions.map((value) => ({ url: "hook_subscriptions", valueString: value })),
      { url: "card_ttl_minutes", valueInteger: metadata.cardTtlMinutes },
      { url: "request_timeout_seconds", valueInteger: metadata.requestTimeoutSeconds },
      { url: "admin_review_status", valueCode: metadata.adminReviewStatus },
    ],
  };
}

function requiredEnum<T extends string>(value: string | undefined, field: string, allowed: readonly T[]): T {
  if (!value || !allowed.includes(value as T)) {
    throw new CdsServiceRegistryError("invalid_cds_service_metadata", `${field} is required.`);
  }
  return value as T;
}

function requiredBoolean(value: boolean | undefined, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CdsServiceRegistryError("invalid_cds_service_metadata", `${field} is required.`);
  }
  return value;
}

function requiredText(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CdsServiceRegistryError("invalid_cds_service_metadata", `${field} is required.`);
  }
  return value.trim();
}

function requiredUrl(value: string | undefined, field: string): string {
  const text = requiredText(value, field);
  const url = new URL(text);
  if (url.protocol !== "https:") {
    throw new CdsServiceRegistryError("invalid_cds_service_metadata", `${field} must use HTTPS.`);
  }
  return text;
}

function stringArray(value: readonly string[], field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new CdsServiceRegistryError("invalid_cds_service_metadata", `${field} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim());
}

function hookArray(value: readonly CdsHookId[] | undefined): CdsHookId[] {
  const hooks = stringArray(value ?? [], "hook_subscriptions") as CdsHookId[];
  if (!hooks.length) {
    throw new CdsServiceRegistryError("invalid_cds_service_metadata", "hook_subscriptions is required.");
  }
  for (const hook of hooks) {
    if (!["order-sign", "order-select", "encounter-discharge"].includes(hook)) {
      throw new CdsServiceRegistryError("invalid_cds_service_metadata", `unsupported hook: ${hook}`);
    }
  }
  return hooks;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new CdsServiceRegistryError("invalid_cds_service_metadata", `${field} must be a positive integer.`);
  }
  return value;
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

function extensionCode(extension: Extension, url: string): string | undefined {
  return extensionValue(extension, url, "valueCode") as string | undefined;
}

function extensionText(extension: Extension, url: string): string | undefined {
  return extensionValue(extension, url, "valueString") as string | undefined;
}

function extensionValue(
  extension: Extension,
  url: string,
  key: "valueBoolean" | "valueCode" | "valueInteger" | "valueString" | "valueUri",
): string | boolean | number | undefined {
  const child = extension.extension?.find((candidate) => candidate.url === url);
  return child?.[key];
}

function extensionValues(extension: Extension, url: string): string[] {
  return (extension.extension ?? [])
    .filter((candidate) => candidate.url === url)
    .map((candidate) => candidate.valueString)
    .filter((value): value is string => typeof value === "string");
}

function requiredBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CdsServiceRegistryError("invalid_cds_service_metadata", `${field} is required.`);
  }
  return value;
}

export function safeReadCdsService(resource: Resource): RegisteredCdsService | undefined {
  if (resource.resourceType !== "Endpoint") {
    return undefined;
  }
  try {
    return readCdsServiceEndpoint(resource);
  } catch {
    return undefined;
  }
}
