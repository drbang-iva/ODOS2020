import type { Basic, Bundle, Media, Resource } from "@medplum/fhirtypes";
import sharp from "sharp";
import { searchAll } from "../fhir-search.js";

export const PROVIDER_SIGNATURE_MAX_WIDTH = 1_200;
export const PROVIDER_SIGNATURE_MAX_HEIGHT = 400;
export const PROVIDER_SIGNATURE_JPEG_QUALITY = 82;
export const PROVIDER_SIGNATURE_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/basic-kind";
export const PROVIDER_SIGNATURE_CODE = "provider-signature-image";
export const PROVIDER_SIGNATURE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/provider-signature-image";
export const PROVIDER_SIGNATURE_WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/provider-signature-image",
} as const;

export interface ProviderSignatureImage {
  providerReference: string;
  mediaReference: string;
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export interface SignatureImageInput {
  bytes: Uint8Array;
  contentType: string;
}

export interface ProcessedSignatureImage {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export type SignatureImageProcessor = (input: {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg";
  maxWidth: number;
  maxHeight: number;
}) => Promise<ProcessedSignatureImage>;

interface SignatureFhirClient {
  readonly baseUrl: string;
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(
    url: string,
    resourceType?: T["resourceType"],
  ): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T>;
}

export class ProviderSignatureImageStore {
  constructor(
    private readonly fhir: SignatureFhirClient,
    private readonly processImage: SignatureImageProcessor = processProviderSignatureImage,
  ) {}

  async set(
    providerReference: string,
    input: SignatureImageInput,
  ): Promise<ProviderSignatureImage> {
    const providerId = providerIdOf(providerReference);
    const contentType = signatureContentType(input.contentType);
    if (input.bytes.byteLength === 0) throw new Error("Provider signature image is empty.");
    const processed = await this.processImage({
      bytes: input.bytes,
      contentType,
      maxWidth: PROVIDER_SIGNATURE_MAX_WIDTH,
      maxHeight: PROVIDER_SIGNATURE_MAX_HEIGHT,
    });
    const media = await this.fhir.create<Media>({
      resourceType: "Media",
      status: "completed",
      type: { text: "Provider graphical signature" },
      subject: { reference: providerReference },
      content: {
        contentType: processed.contentType,
        data: Buffer.from(processed.bytes).toString("base64"),
        title: "Provider signature",
        size: processed.bytes.byteLength,
      },
      width: processed.width,
      height: processed.height,
    }, PROVIDER_SIGNATURE_WRITE_HEADERS);
    if (!media.id) throw new Error("Provider signature Media create returned no id.");

    const existing = await this.readConfig(providerId);
    const config = buildProviderSignatureConfig({
      providerReference,
      mediaReference: `Media/${media.id}`,
      contentType: processed.contentType,
      width: processed.width,
      height: processed.height,
    }, true, existing);
    const saved = existing?.id
      ? await this.fhir.update(
          "Basic",
          existing.id,
          config,
          PROVIDER_SIGNATURE_WRITE_HEADERS,
        )
      : await this.fhir.create(config, {
          ...PROVIDER_SIGNATURE_WRITE_HEADERS,
          "If-None-Exist":
            `identifier=${PROVIDER_SIGNATURE_IDENTIFIER_SYSTEM}|${providerId}`,
        });
    return parseProviderSignatureConfig(saved);
  }

  async read(providerReference: string): Promise<ProviderSignatureImage | undefined> {
    const resource = await this.readConfig(providerIdOf(providerReference));
    if (!resource) return undefined;
    const active = resource.extension?.find((extension) => extension.url === "active")
      ?.valueBoolean ?? true;
    return active ? parseProviderSignatureConfig(resource) : undefined;
  }

  async readMedia(providerReference: string): Promise<{
    signature: ProviderSignatureImage;
    media: Media;
  } | undefined> {
    const signature = await this.read(providerReference);
    if (!signature) return undefined;
    const id = signature.mediaReference.match(/^Media\/([A-Za-z0-9.-]{1,64})$/)?.[1];
    if (!id) throw new Error("Provider signature Media reference is invalid.");
    const media = await this.fhir.read<Media>("Media", id);
    if (media.subject?.reference !== providerReference) {
      throw new Error("Provider signature Media belongs to a different provider.");
    }
    return { signature, media };
  }

  async clear(providerReference: string): Promise<void> {
    const providerId = providerIdOf(providerReference);
    const existing = await this.readConfig(providerId);
    if (!existing?.id) return;
    const parsed = parseProviderSignatureConfig(existing);
    await this.fhir.update(
      "Basic",
      existing.id,
      buildProviderSignatureConfig(parsed, false, existing),
      PROVIDER_SIGNATURE_WRITE_HEADERS,
    );
  }

  private async readConfig(providerId: string): Promise<Basic | undefined> {
    const resources = await searchAll<Basic>(this.fhir, "Basic", {
      code: `${PROVIDER_SIGNATURE_CODE_SYSTEM}|${PROVIDER_SIGNATURE_CODE}`,
      identifier: `${PROVIDER_SIGNATURE_IDENTIFIER_SYSTEM}|${providerId}`,
      _count: "2",
    });
    return resources.find((resource) => resource.identifier?.some(
      (identifier) =>
        identifier.system === PROVIDER_SIGNATURE_IDENTIFIER_SYSTEM
        && identifier.value === providerId,
    ));
  }
}

export async function processProviderSignatureImage(input: {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg";
  maxWidth: number;
  maxHeight: number;
}): Promise<ProcessedSignatureImage> {
  const pipeline = sharp(input.bytes, { failOn: "warning" })
    .rotate()
    .resize({
      width: input.maxWidth,
      height: input.maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    });
  const encoded = input.contentType === "image/png"
    ? pipeline.png({ compressionLevel: 9, palette: true })
    : pipeline.jpeg({ quality: PROVIDER_SIGNATURE_JPEG_QUALITY, mozjpeg: true });
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) {
    throw new Error("Provider signature image dimensions could not be determined.");
  }
  return {
    bytes: data,
    contentType: input.contentType,
    width: info.width,
    height: info.height,
  };
}

function buildProviderSignatureConfig(
  signature: ProviderSignatureImage,
  active: boolean,
  existing?: Basic,
): Basic {
  const providerId = providerIdOf(signature.providerReference);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{
      system: PROVIDER_SIGNATURE_IDENTIFIER_SYSTEM,
      value: providerId,
    }],
    code: {
      coding: [{
        system: PROVIDER_SIGNATURE_CODE_SYSTEM,
        code: PROVIDER_SIGNATURE_CODE,
        display: "Provider graphical signature image",
      }],
      text: PROVIDER_SIGNATURE_CODE,
    },
    subject: { reference: signature.providerReference },
    extension: [
      { url: "media-reference", valueReference: { reference: signature.mediaReference } },
      { url: "content-type", valueCode: signature.contentType },
      { url: "width", valuePositiveInt: signature.width },
      { url: "height", valuePositiveInt: signature.height },
      { url: "active", valueBoolean: active },
    ],
  };
}

function parseProviderSignatureConfig(resource: Basic): ProviderSignatureImage {
  const providerReference = resource.subject?.reference;
  const mediaReference = resource.extension?.find(
    (extension) => extension.url === "media-reference",
  )?.valueReference?.reference;
  const contentType = resource.extension?.find(
    (extension) => extension.url === "content-type",
  )?.valueCode;
  const width = resource.extension?.find(
    (extension) => extension.url === "width",
  )?.valuePositiveInt;
  const height = resource.extension?.find(
    (extension) => extension.url === "height",
  )?.valuePositiveInt;
  if (!providerReference || !mediaReference || !contentType || !width || !height) {
    throw new Error("Provider signature config is incomplete.");
  }
  providerIdOf(providerReference);
  if (!/^Media\/[A-Za-z0-9.-]{1,64}$/.test(mediaReference)) {
    throw new Error("Provider signature config Media reference is invalid.");
  }
  return {
    providerReference,
    mediaReference,
    contentType: signatureContentType(contentType),
    width,
    height,
  };
}

function providerIdOf(reference: string): string {
  const id = reference.match(/^Practitioner\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  if (!id) throw new Error("Provider signature requires a Practitioner reference.");
  return id;
}

function signatureContentType(value: string): "image/png" | "image/jpeg" {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "image/png" && normalized !== "image/jpeg") {
    throw new Error("Provider signature must be a PNG or JPEG image.");
  }
  return normalized;
}
