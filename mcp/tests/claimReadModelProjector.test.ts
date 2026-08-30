import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Claim, Resource } from "@medplum/fhirtypes";
import { loadClaimReadModelTruth } from "../src/claims/claim-read-model-projector.js";

const AT = "2026-08-30T12:00:00.000Z";

test("FHIR projection pages beyond 1,000 Claims without freezing at the generic search ceiling", async () => {
  const claims = Array.from({ length: 1_001 }, (_, index) => claim(index + 1));
  let continuationCalls = 0;
  const fhir = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
      if (resourceType !== "Claim") return page<T>([]);
      return page<T>(claims.slice(0, 1_000), "/fhir/R4/Claim?_page=2");
    },
    searchUrl: async <T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> => {
      assert.equal(resourceType, "Claim");
      assert.equal(url, "/fhir/R4/Claim?_page=2");
      continuationCalls += 1;
      return page<T>(claims.slice(1_000));
    },
  };

  const truth = await loadClaimReadModelTruth(fhir, AT);

  assert.equal(truth.length, 1_001);
  const references = new Set(truth.map((row) => row.claimReference));
  assert.equal(references.has("Claim/claim-1"), true);
  assert.equal(references.has("Claim/claim-1001"), true);
  assert.equal(continuationCalls, 1);
});

function claim(number: number): Claim {
  return {
    resourceType: "Claim",
    id: `claim-${number}`,
    status: "active",
    use: "claim",
    patient: { reference: "Patient/patient-1", display: "Synthetic Patient" },
    provider: { reference: "Practitioner/provider-1", display: "Synthetic Provider" },
    insurer: { reference: "Organization/payer-1", display: "Synthetic Payer" },
    priority: { text: "normal" },
    type: { text: "professional" },
    created: "2026-06-01T12:00:00.000Z",
    total: { value: 125, currency: "USD" },
    identifier: [{ system: "https://odos.test/claim-number", value: `ODOS-${number}` }],
  };
}

function page<T extends Resource>(resources: Resource[], nextUrl?: string): Bundle<T> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.map((resource) => ({ resource: resource as T })),
    ...(nextUrl ? { link: [{ relation: "next", url: nextUrl }] } : {}),
  };
}
