import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Media, Resource } from "@medplum/fhirtypes";
import sharp from "sharp";
import {
  PROVIDER_SIGNATURE_MAX_HEIGHT,
  PROVIDER_SIGNATURE_MAX_WIDTH,
  ProviderSignatureImageStore,
  type SignatureImageProcessor,
  processProviderSignatureImage,
} from "../src/correspondence/signature-image-store.js";

test("oversized provider signature uploads are accepted, downscaled, and stored per provider", async () => {
  const fhir = new SignatureFhir();
  const processor: SignatureImageProcessor = async (input) => {
    assert.equal(input.bytes.byteLength, 512_000);
    assert.equal(input.maxWidth, PROVIDER_SIGNATURE_MAX_WIDTH);
    assert.equal(input.maxHeight, PROVIDER_SIGNATURE_MAX_HEIGHT);
    return {
      bytes: Buffer.from("derived-signature"),
      contentType: "image/jpeg",
      width: PROVIDER_SIGNATURE_MAX_WIDTH,
      height: 320,
    };
  };
  const store = new ProviderSignatureImageStore(fhir, processor);

  const saved = await store.set("Practitioner/doctor-1", {
    bytes: Buffer.alloc(512_000, 7),
    contentType: "image/jpeg",
  });

  assert.equal(saved.providerReference, "Practitioner/doctor-1");
  assert.equal(saved.contentType, "image/jpeg");
  assert.equal(saved.width, PROVIDER_SIGNATURE_MAX_WIDTH);
  assert.equal(saved.height, 320);
  assert.match(saved.mediaReference, /^Media\//);
  assert.deepEqual(await store.read("Practitioner/doctor-1"), saved);
  assert.equal(
    Buffer.from(fhir.resourcesOfType<Media>("Media")[0]!.content.data!, "base64").toString(),
    "derived-signature",
  );
});

test("provider signatures reject unsupported content types and clear without a placeholder", async () => {
  const fhir = new SignatureFhir();
  let processorCalled = false;
  const store = new ProviderSignatureImageStore(fhir, async () => {
    processorCalled = true;
    return { bytes: Buffer.from("x"), contentType: "image/png", width: 1, height: 1 };
  });

  await assert.rejects(
    store.set("Practitioner/doctor-1", {
      bytes: Buffer.from("<svg/>"),
      contentType: "image/svg+xml",
    }),
    /PNG or JPEG/,
  );
  assert.equal(processorCalled, false);

  await store.set("Practitioner/doctor-1", {
    bytes: Buffer.from("png"),
    contentType: "image/png",
  });
  await store.clear("Practitioner/doctor-1");
  assert.equal(await store.read("Practitioner/doctor-1"), undefined);
});

test("the production image processor downscales a phone-sized signature image to its print target", async () => {
  const phoneImage = await sharp({
    create: {
      width: 4_000,
      height: 2_000,
      channels: 3,
      background: "#ffffff",
    },
  }).jpeg({ quality: 95 }).toBuffer();

  const processed = await processProviderSignatureImage({
    bytes: phoneImage,
    contentType: "image/jpeg",
    maxWidth: PROVIDER_SIGNATURE_MAX_WIDTH,
    maxHeight: PROVIDER_SIGNATURE_MAX_HEIGHT,
  });

  assert.ok(processed.width <= PROVIDER_SIGNATURE_MAX_WIDTH);
  assert.ok(processed.height <= PROVIDER_SIGNATURE_MAX_HEIGHT);
  assert.equal(processed.width, 800);
  assert.equal(processed.height, 400);
  assert.equal(processed.contentType, "image/jpeg");
});

class SignatureFhir {
  private sequence = 0;
  readonly resources: Resource[] = [];

  resourcesOfType<T extends Resource>(resourceType: T["resourceType"]): T[] {
    return this.resources.filter((resource): resource is T => resource.resourceType === resourceType);
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>> {
    const resources = this.resourcesOfType<T>(resourceType).filter((resource) => {
      if (resource.resourceType !== "Basic") return true;
      const basic = resource as Basic;
      const identifier = params?.identifier?.split("|").at(-1);
      return !identifier || basic.identifier?.some((item) => item.value === identifier);
    });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource })),
    };
  }

  async searchUrl<T extends Resource>(
    _url: string,
    resourceType: T["resourceType"],
  ): Promise<Bundle<T>> {
    return this.search<T>(resourceType);
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resourcesOfType<T>(resourceType).find((candidate) => candidate.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return resource;
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const created = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${++this.sequence}` };
    this.resources.push(created);
    return created;
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const updated = { ...resource, id };
    const index = this.resources.findIndex(
      (candidate) => candidate.resourceType === resourceType && candidate.id === id,
    );
    if (index < 0) throw new Error(`${resourceType}/${id} not found`);
    this.resources[index] = updated;
    return updated;
  }
}
