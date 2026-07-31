import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import {
  CorrespondenceLetterheadStore,
  parseCorrespondenceLetterhead,
} from "../src/correspondence/letterhead-store.js";

test("letterhead store maintains one locked practice layout with reference-only image seams", async () => {
  const fhir = new BasicFhir();
  const store = new CorrespondenceLetterheadStore(fhir);
  const saved = await store.save({
    logoReference: "Media/logo-1",
    contactBlock: "Rivera Eye Care\n100 Main Street\nGreenville, SC 29601",
    phone: "864-555-0100",
    footerText: "Confidential clinical correspondence",
    signatureImageReference: "Binary/signature-1",
  });

  assert.equal(fhir.resources.length, 1);
  assert.deepEqual(await store.read(), saved);

  const updated = await store.save({
    ...saved,
    footerText: "Updated footer",
  });
  assert.equal(fhir.resources.length, 1);
  assert.equal(updated.footerText, "Updated footer");

  await store.clear();
  assert.equal(await store.read(), undefined);
  assert.equal(parseCorrespondenceLetterhead(fhir.resources[0]!).active, false);
});

test("letterhead rejects per-letter layout material and unsupported image references", async () => {
  const store = new CorrespondenceLetterheadStore(new BasicFhir());
  await assert.rejects(
    store.save({
      contactBlock: "Practice",
      phone: "864-555-0100",
      footerText: "",
      logoReference: "https://remote.example/logo.png",
    }),
    /Media or Binary reference/,
  );
});

class BasicFhir {
  readonly resources: Basic[] = [];

  async search(): Promise<Bundle<Basic>> {
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: this.resources.map((resource) => ({ resource })),
    };
  }

  async searchUrl(): Promise<Bundle<Basic>> {
    return this.search();
  }

  async create(resource: Basic): Promise<Basic> {
    const created = { ...resource, id: "letterhead-1" };
    this.resources.push(created);
    return created;
  }

  async update(_resourceType: "Basic", id: string, resource: Basic): Promise<Basic> {
    const updated = { ...resource, id };
    this.resources[0] = updated;
    return updated;
  }
}
