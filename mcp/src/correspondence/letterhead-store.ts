import type { Basic } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";

export const CORRESPONDENCE_LETTERHEAD_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/basic-kind";
export const CORRESPONDENCE_LETTERHEAD_CODE = "correspondence-letterhead";
export const CORRESPONDENCE_LETTERHEAD_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/correspondence-letterhead";
export const CORRESPONDENCE_LETTERHEAD_IDENTIFIER_VALUE = "primary";
export const CORRESPONDENCE_LETTERHEAD_WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/correspondence-letterhead",
} as const;

export interface CorrespondenceLetterheadInput {
  logoReference?: string;
  contactBlock: string;
  phone: string;
  footerText: string;
  signatureImageReference?: string;
}

export interface CorrespondenceLetterhead extends CorrespondenceLetterheadInput {
  active: boolean;
}

type LetterheadFhirClient = Pick<
  MedplumClient,
  "baseUrl" | "search" | "searchUrl" | "create" | "update"
>;

export class CorrespondenceLetterheadStore {
  constructor(private readonly fhir: LetterheadFhirClient) {}

  async read(): Promise<CorrespondenceLetterhead | undefined> {
    const resource = await this.readResource();
    if (!resource) return undefined;
    const letterhead = parseCorrespondenceLetterhead(resource);
    return letterhead.active ? letterhead : undefined;
  }

  async save(input: CorrespondenceLetterheadInput): Promise<CorrespondenceLetterhead> {
    validateLetterhead(input);
    const existing = await this.readResource();
    const resource = buildCorrespondenceLetterheadResource({ ...input, active: true }, existing);
    const saved = existing?.id
      ? await this.fhir.update(
          "Basic",
          existing.id,
          resource,
          CORRESPONDENCE_LETTERHEAD_WRITE_HEADERS,
        )
      : await this.fhir.create(resource, {
          ...CORRESPONDENCE_LETTERHEAD_WRITE_HEADERS,
          "If-None-Exist":
            `identifier=${CORRESPONDENCE_LETTERHEAD_IDENTIFIER_SYSTEM}|${CORRESPONDENCE_LETTERHEAD_IDENTIFIER_VALUE}`,
        });
    return parseCorrespondenceLetterhead(saved);
  }

  async clear(): Promise<void> {
    const existing = await this.readResource();
    if (!existing?.id) return;
    const parsed = parseCorrespondenceLetterhead(existing);
    await this.fhir.update(
      "Basic",
      existing.id,
      buildCorrespondenceLetterheadResource({ ...parsed, active: false }, existing),
      CORRESPONDENCE_LETTERHEAD_WRITE_HEADERS,
    );
  }

  private async readResource(): Promise<Basic | undefined> {
    const resources = await searchAll<Basic>(this.fhir, "Basic", {
      code: `${CORRESPONDENCE_LETTERHEAD_CODE_SYSTEM}|${CORRESPONDENCE_LETTERHEAD_CODE}`,
      identifier:
        `${CORRESPONDENCE_LETTERHEAD_IDENTIFIER_SYSTEM}|${CORRESPONDENCE_LETTERHEAD_IDENTIFIER_VALUE}`,
      _count: "2",
    });
    return resources.find((resource) =>
      resource.identifier?.some((identifier) =>
        identifier.system === CORRESPONDENCE_LETTERHEAD_IDENTIFIER_SYSTEM
        && identifier.value === CORRESPONDENCE_LETTERHEAD_IDENTIFIER_VALUE));
  }
}

export function buildCorrespondenceLetterheadResource(
  letterhead: CorrespondenceLetterhead,
  existing?: Basic,
): Basic {
  validateLetterhead(letterhead);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{
      system: CORRESPONDENCE_LETTERHEAD_IDENTIFIER_SYSTEM,
      value: CORRESPONDENCE_LETTERHEAD_IDENTIFIER_VALUE,
    }],
    code: {
      coding: [{
        system: CORRESPONDENCE_LETTERHEAD_CODE_SYSTEM,
        code: CORRESPONDENCE_LETTERHEAD_CODE,
        display: "Correspondence letterhead",
      }],
      text: CORRESPONDENCE_LETTERHEAD_CODE,
    },
    extension: [
      ...(letterhead.logoReference
        ? [{ url: "logo-reference", valueReference: { reference: letterhead.logoReference } }]
        : []),
      { url: "contact-block", valueString: letterhead.contactBlock },
      { url: "phone", valueString: letterhead.phone },
      { url: "footer-text", valueString: letterhead.footerText },
      ...(letterhead.signatureImageReference
        ? [{
            url: "signature-image-reference",
            valueReference: { reference: letterhead.signatureImageReference },
          }]
        : []),
      { url: "active", valueBoolean: letterhead.active },
    ],
  };
}

export function parseCorrespondenceLetterhead(resource: Basic): CorrespondenceLetterhead {
  if (!resource.code?.coding?.some((coding) =>
    coding.system === CORRESPONDENCE_LETTERHEAD_CODE_SYSTEM
    && coding.code === CORRESPONDENCE_LETTERHEAD_CODE)) {
    throw new Error("Basic resource is not correspondence letterhead config.");
  }
  const letterhead: CorrespondenceLetterhead = {
    contactBlock: stringExtension(resource, "contact-block"),
    phone: stringExtension(resource, "phone"),
    footerText: stringExtension(resource, "footer-text", false),
    active: resource.extension?.find((extension) => extension.url === "active")?.valueBoolean ?? true,
    ...referenceExtension(resource, "logo-reference", "logoReference"),
    ...referenceExtension(resource, "signature-image-reference", "signatureImageReference"),
  };
  validateLetterhead(letterhead);
  return letterhead;
}

function validateLetterhead(input: CorrespondenceLetterheadInput): void {
  if (!input.contactBlock.trim()) throw new Error("Letterhead contact block is required.");
  if (!input.phone.trim()) throw new Error("Letterhead phone is required.");
  if (input.logoReference) assertImageReference(input.logoReference);
  if (input.signatureImageReference) assertImageReference(input.signatureImageReference);
}

function assertImageReference(value: string): void {
  if (!/^(Media|Binary)\/[A-Za-z0-9.-]{1,64}$/.test(value)) {
    throw new Error("Letterhead images must use a local Media or Binary reference.");
  }
}

function stringExtension(resource: Basic, url: string, required = true): string {
  const value = resource.extension?.find((extension) => extension.url === url)?.valueString;
  if (required && !value?.trim()) throw new Error(`Letterhead ${url} is missing.`);
  return value ?? "";
}

function referenceExtension<
  K extends "logoReference" | "signatureImageReference",
>(resource: Basic, url: string, key: K): Partial<Record<K, string>> {
  const value = resource.extension?.find(
    (extension) => extension.url === url,
  )?.valueReference?.reference;
  return value ? { [key]: value } as Record<K, string> : {};
}
