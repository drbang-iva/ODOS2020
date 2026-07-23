import type { Basic } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";

export const ODOS_BILLING_IDENTITY_CONFIG_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/billing-identity-config";
export const ODOS_BILLING_IDENTITY_CONFIG_CODE = "odos-billing-identity-config";
export const ODOS_BILLING_IDENTITY_CONFIG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-billing-identity-config";
export const ODOS_BILLING_IDENTITY_CONFIG_RESOURCE_ID = "billing-identity-config";

export interface BillingIdentityConfig {
  name: string;
  npi: string;
  taxId: string;
  taxIdType: "E" | "S";
  taxonomy: string;
  address1: string;
  city: string;
  state: string;
  zip: string;
  phone?: string;
  email?: string;
  fax?: string;
}

export function validateBillingIdentityConfig(config: BillingIdentityConfig): void {
  for (const [label, value] of [
    ["Practice name", config.name],
    ["Taxonomy", config.taxonomy],
    ["Address", config.address1],
    ["City", config.city],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  }
  const npi = typeof config.npi === "string" ? config.npi.trim() : "";
  if (!/^\d{10}$/.test(npi)) {
    throw new Error("NPI must be exactly 10 digits.");
  }
  if (!hasValidNpiCheckDigit(npi)) throw new Error("NPI check digit is invalid.");
  if (typeof config.taxId !== "string" || !/^\d{9}$/.test(config.taxId.trim())) {
    throw new Error("Tax ID must be exactly 9 digits.");
  }
  if (config.taxIdType !== "E" && config.taxIdType !== "S") {
    throw new Error("Tax ID type must be EIN or SSN.");
  }
  if (typeof config.state !== "string" || !/^[A-Za-z]{2}$/.test(config.state.trim())) {
    throw new Error("State must be a 2-letter abbreviation.");
  }
  if (typeof config.zip !== "string" || !/^\d{5}(?:-?\d{4})?$/.test(config.zip.trim())) {
    throw new Error("ZIP must be 5 or 9 digits.");
  }
  if (config.phone !== undefined && typeof config.phone !== "string") {
    throw new Error("Phone must be text.");
  }
  if (config.email !== undefined && typeof config.email !== "string") {
    throw new Error("Email must be text.");
  }
  if (config.fax !== undefined && typeof config.fax !== "string") {
    throw new Error("Fax must be text.");
  }
}

function hasValidNpiCheckDigit(npi: string): boolean {
  const value = `80840${npi}`;
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export function buildBillingIdentityResource(
  config: BillingIdentityConfig,
  existing?: Basic,
): Basic {
  validateBillingIdentityConfig(config);
  const persisted = cleanBillingIdentity(config);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [{
        system: ODOS_BILLING_IDENTITY_CONFIG_SYSTEM,
        code: ODOS_BILLING_IDENTITY_CONFIG_CODE,
        display: "ODOS Billing Identity Config",
      }],
      text: "ODOS Billing Identity Config",
    },
    extension: [{
      url: ODOS_BILLING_IDENTITY_CONFIG_EXTENSION_URL,
      valueString: JSON.stringify(persisted),
    }],
  };
}

export function parseBillingIdentityConfig(basic: Basic): BillingIdentityConfig {
  const coding = basic.code?.coding?.find((candidate) =>
    candidate.system === ODOS_BILLING_IDENTITY_CONFIG_SYSTEM
    && candidate.code === ODOS_BILLING_IDENTITY_CONFIG_CODE
  );
  if (!coding) throw new Error("Basic resource is not the odos billing-identity-config singleton.");
  const raw = basic.extension?.find((extension) =>
    extension.url === ODOS_BILLING_IDENTITY_CONFIG_EXTENSION_URL
  )?.valueString;
  if (!raw) throw new Error("Billing-identity-config singleton is missing its config extension.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Billing-identity-config JSON is malformed and cannot be parsed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Billing-identity-config JSON is malformed and cannot be parsed.");
  }
  const config = parsed as BillingIdentityConfig;
  validateBillingIdentityConfig(config);
  return cleanBillingIdentity(config);
}

export async function loadBillingIdentityConfig(
  client: Pick<MedplumClient, "search" | "searchUrl">,
): Promise<BillingIdentityConfig | undefined> {
  const resources = await searchAll<Basic>(client, "Basic", {
    code: `${ODOS_BILLING_IDENTITY_CONFIG_SYSTEM}|${ODOS_BILLING_IDENTITY_CONFIG_CODE}`,
    _count: "10",
  });
  const resource = [...resources].sort((left, right) => lastUpdatedMs(right) - lastUpdatedMs(left))[0];
  return resource ? parseBillingIdentityConfig(resource) : undefined;
}

function lastUpdatedMs(resource: Basic): number {
  return resource.meta?.lastUpdated ? Date.parse(resource.meta.lastUpdated) || 0 : 0;
}

function cleanBillingIdentity(config: BillingIdentityConfig): BillingIdentityConfig {
  return {
    name: config.name.trim(),
    npi: config.npi.trim(),
    taxId: config.taxId.trim(),
    taxIdType: config.taxIdType,
    taxonomy: config.taxonomy.trim(),
    address1: config.address1.trim(),
    city: config.city.trim(),
    state: config.state.trim().toUpperCase(),
    zip: config.zip.trim(),
    ...(config.phone?.trim() ? { phone: config.phone.trim() } : {}),
    ...(config.email?.trim() ? { email: config.email.trim() } : {}),
    ...(config.fax?.trim() ? { fax: config.fax.trim() } : {}),
  };
}
