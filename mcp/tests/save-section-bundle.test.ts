import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, BundleEntry, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import { BODY_SITE_REFERENCE_EXTENSION_URL } from "../src/fhir/ophthalmology/bodyStructure.js";
import {
  buildSectionSaveBundle,
  type SectionSaveSection,
} from "../src/fhir/ophthalmology/save-section-bundle.js";

const baseInput = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  operatorDisplay: "OSOD save-section test",
  measuredAt: "2026-04-25T12:00:00.000Z",
  recordedAt: "2026-04-25T12:00:00.001Z",
};

test("VA section save composer emits BodyStructure, Observation, and Provenance per eye", () => {
  const bundle = buildSectionSaveBundle({
    ...baseInput,
    section: "va",
    entries: [
      { laterality: "OD", snellen: "20/20", chartType: "SNELLEN", correction: "SC" },
      { laterality: "OS", snellen: "20/25", chartType: "SNELLEN", correction: "SC" },
    ],
  });

  assertSectionBundle(bundle, "va", ["OD", "OS"]);
});

test("IOP section save composer emits BodyStructure, Observation, and Provenance per eye", () => {
  const bundle = buildSectionSaveBundle({
    ...baseInput,
    section: "iop",
    entries: [
      { laterality: "OD", value: 14, method: "GAT" },
      { laterality: "OS", value: 15, method: "GAT" },
    ],
  });

  assertSectionBundle(bundle, "iop", ["OD", "OS"]);
});

test("Refraction section save composer emits BodyStructure, Observation, and Provenance per eye", () => {
  const bundle = buildSectionSaveBundle({
    ...baseInput,
    section: "refraction",
    entries: [
      { laterality: "OD", refractionType: "MANIFEST", sphere: 0, cylinder: -0.5, axis: 90 },
      { laterality: "OS", refractionType: "MANIFEST", sphere: -0.5 },
    ],
  });

  assertSectionBundle(bundle, "refraction", ["OD", "OS"]);
});

function assertSectionBundle(
  bundle: Bundle,
  section: SectionSaveSection,
  lateralities: Array<"OD" | "OS" | "OU">,
): void {
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "transaction");
  assert.equal(bundle.entry?.length, lateralities.length * 3);

  const fullUrls = new Set((bundle.entry ?? []).flatMap((entry) => entry.fullUrl ?? []));

  for (const laterality of lateralities) {
    const suffix = laterality.toLowerCase();
    const bodyStructure = entryByFullUrl(bundle, `urn:uuid:bs-${suffix}`);
    const observation = entryByFullUrl(bundle, `urn:uuid:obs-${section}-${suffix}`);
    const provenance = entryByFullUrl(bundle, `urn:uuid:prov-${section}-${suffix}`);

    assert.equal(bodyStructure.request?.method, "POST");
    assert.match(bodyStructure.request?.url ?? "", /^BodyStructure\?/);
    assert.match(bodyStructure.request?.ifNoneExist ?? "", /patient=Patient\/p1/);
    assert.match(bodyStructure.request?.ifNoneExist ?? "", /location=\d+/);

    assert.equal(observation.request?.method, "POST");
    assert.equal(observation.request?.url, "Observation");
    assert.equal(observation.resource?.resourceType, "Observation");

    const obs = observation.resource as Observation;
    assert.equal(obs.subject?.reference, "Patient/p1");
    assert.equal(obs.encounter?.reference, "Encounter/e1");
    assert.equal(obs.effectiveDateTime, baseInput.measuredAt);
    assert.equal(obs.contained, undefined);

    const bodySiteReference = obs.bodySite?.extension?.find(
      (extension) => extension.url === BODY_SITE_REFERENCE_EXTENSION_URL,
    )?.valueReference?.reference;
    assert.equal(bodySiteReference, `urn:uuid:bs-${suffix}`);
    assert.ok(fullUrls.has(bodySiteReference), `Expected ${bodySiteReference} to resolve in Bundle.fullUrl`);

    assert.equal(provenance.request?.method, "POST");
    assert.equal(provenance.request?.url, "Provenance");
    assert.equal(provenance.resource?.resourceType, "Provenance");
    assert.equal(
      (provenance.resource as Provenance).target[0]?.reference,
      `urn:uuid:obs-${section}-${suffix}`,
    );
    assert.equal(
      (provenance.resource as Provenance).agent[0]?.who.display,
      baseInput.operatorDisplay,
    );
  }
}

function entryByFullUrl(bundle: Bundle, fullUrl: string): BundleEntry<Resource> {
  const entry = bundle.entry?.find((candidate) => candidate.fullUrl === fullUrl);
  assert.ok(entry, `Expected Bundle.entry fullUrl=${fullUrl}`);
  return entry;
}
