import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Observation, ObservationComponent } from "@medplum/fhirtypes";
import { createMedplumClient } from "../src/fhir-client.js";
import {
  OPHTHALMOLOGY_CODE_BINDING_VERSION,
  OSOD_OPHTHALMOLOGY_CODE_SYSTEM,
  SNOMED_CT_CODE_SYSTEM,
} from "../src/fhir/ophthalmology/codeBindings.js";
import { BODY_SITE_REFERENCE_EXTENSION_URL } from "../src/fhir/ophthalmology/bodyStructure.js";
import {
  OSOD_EXTENSION_URLS,
  encounterReference,
  normalizeLaterality,
  osodConcept,
  patientReference,
} from "../src/fhir/ophthalmology/extensions.js";
import { buildIopObservation } from "../src/fhir/ophthalmology/iop.js";
import { buildRefractionObservation } from "../src/fhir/ophthalmology/refraction.js";
import {
  buildDiagnosticReport,
  buildDocumentReference,
} from "../src/fhir/ophthalmology/rawAssets.js";
import { buildProvenance } from "../src/fhir/ophthalmology/provenance.js";
import { buildVisualAcuityObservation } from "../src/fhir/ophthalmology/visualAcuity.js";

const common = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  eye: "OD" as const,
  measuredAt: "2026-04-24T12:00:00.000Z",
};

test("visual acuity 20/20 creates structured logMAR 0", () => {
  const { resource } = buildVisualAcuityObservation({
    ...common,
    snellen: "20/20",
    chartType: "SNELLEN",
    correction: "CC",
  });

  assert.equal(component(resource, "VA_SNELLEN_RAW").valueString, "20/20");
  assert.equal(component(resource, "VA_LOGMAR").valueQuantity?.value, 0);
  assertCoding(resource.code.coding, OSOD_OPHTHALMOLOGY_CODE_SYSTEM, "VISUAL_ACUITY");
  assertCoding(resource.code.coding, SNOMED_CT_CODE_SYSTEM, "397536007");
  assertExamCategory(resource);
  assert.equal(resource.valueString, undefined);
});

test("visual acuity 20/40 creates approximate logMAR 0.3", () => {
  const { resource } = buildVisualAcuityObservation({
    ...common,
    snellen: "20/40",
    chartType: "SNELLEN",
    correction: "CC",
  });

  assert.ok(Math.abs((component(resource, "VA_LOGMAR").valueQuantity?.value ?? -1) - 0.301) < 0.002);
});

test("visual acuity preserves Snellen minus notation and warns without letter score", () => {
  const { resource, warnings } = buildVisualAcuityObservation({
    ...common,
    snellen: "20/20-2",
    chartType: "SNELLEN",
    correction: "CC",
  });

  assert.equal(component(resource, "VA_SNELLEN_RAW").valueString, "20/20-2");
  assert.match(warnings.join(" "), /plus\/minus notation/);
});

test("visual acuity persists ETDRS letter score", () => {
  const { resource } = buildVisualAcuityObservation({
    ...common,
    snellen: "20/20-2",
    letterScore: 83,
    chartType: "ETDRS",
    correction: "CC",
  });

  assert.equal(component(resource, "VA_LETTER_SCORE").valueInteger, 83);
});

test("visual acuity cannot be only free text when unparseable is not explicit", () => {
  assert.throws(
    () =>
      buildVisualAcuityObservation({
        ...common,
        snellen: "CF at 3 ft",
        chartType: "OTHER",
        correction: "SC",
      }),
    /unparseable/,
  );
});

test("IOP stores numeric valueQuantity, UCUM mm[Hg], laterality, and method", () => {
  const { resource } = buildIopObservation({
    ...common,
    value: 15,
    method: osodConcept("GAT", "GAT"),
  });

  assert.equal(resource.valueQuantity?.value, 15);
  assert.equal(resource.valueQuantity?.unit, "mm[Hg]");
  assert.equal(resource.valueQuantity?.system, "http://unitsofmeasure.org");
  assert.equal(resource.valueQuantity?.code, "mm[Hg]");
  assert.equal(resource.bodySite?.coding?.[0]?.code, "OD");
  assert.equal(resource.method?.coding?.[0]?.code, "GAT");
  assertCoding(resource.code.coding, OSOD_OPHTHALMOLOGY_CODE_SYSTEM, "INTRAOCULAR_PRESSURE");
  assertCoding(resource.code.coding, SNOMED_CT_CODE_SYSTEM, "41633001");
  assertCoding(resource.method?.coding, SNOMED_CT_CODE_SYSTEM, "389152008");
  assertExamCategory(resource);
  assertBodyStructureReference(resource, "#osod-eye-od");
  assert.equal(resource.valueString, undefined);
});

test("IOP rejects negative values and warns on implausible high/low values", () => {
  assert.throws(
    () => buildIopObservation({ ...common, value: -1, method: osodConcept("GAT", "GAT") }),
    /cannot be negative/,
  );
  assert.match(
    buildIopObservation({ ...common, value: 81, method: osodConcept("GAT", "GAT") }).warnings.join(" "),
    /plausibility/,
  );
});

test("laterality validation accepts only OD, OS, OU, or UNKNOWN", () => {
  assert.equal(normalizeLaterality("od"), "OD");
  assert.throws(() => normalizeLaterality("right"), /Unsupported eye laterality/);
});

test("refraction stores signed numeric components and validates axis", () => {
  const { resource } = buildRefractionObservation({
    ...common,
    refractionType: "MANIFEST",
    sphere: -2.5,
    cylinder: -0.75,
    axis: 180,
    add: 2,
  });

  assert.equal(component(resource, "SPHERE").valueQuantity?.value, -2.5);
  assert.equal(component(resource, "CYLINDER").valueQuantity?.value, -0.75);
  assert.equal(component(resource, "AXIS").valueQuantity?.value, 180);
  assert.equal(component(resource, "ADD").valueQuantity?.value, 2);
  assertCoding(resource.code.coding, OSOD_OPHTHALMOLOGY_CODE_SYSTEM, "REFRACTION");
  assertCoding(resource.code.coding, SNOMED_CT_CODE_SYSTEM, "251794006");
  assertCoding(component(resource, "SPHERE").code.coding, OSOD_OPHTHALMOLOGY_CODE_SYSTEM, "SPHERE");
  assertCoding(component(resource, "SPHERE").code.coding, SNOMED_CT_CODE_SYSTEM, "251795007");
  assertCoding(component(resource, "CYLINDER").code.coding, OSOD_OPHTHALMOLOGY_CODE_SYSTEM, "CYLINDER");
  assertCoding(component(resource, "CYLINDER").code.coding, SNOMED_CT_CODE_SYSTEM, "251797004");
  assertCoding(component(resource, "AXIS").code.coding, OSOD_OPHTHALMOLOGY_CODE_SYSTEM, "AXIS");
  assertCoding(component(resource, "AXIS").code.coding, SNOMED_CT_CODE_SYSTEM, "251799001");
  assertExamCategory(resource);
  assert.equal(resource.valueString, undefined);
  assert.throws(
    () => buildRefractionObservation({ ...common, refractionType: "MANIFEST", axis: 181 }),
    /axis must be between 0 and 180/,
  );
});

test("refraction stores prism as structured quantity and base concept", () => {
  const { resource } = buildRefractionObservation({
    ...common,
    refractionType: "MANIFEST",
    sphere: -1,
    prism: { amount: 2, base: "up" },
  });
  const prism = component(resource, "PRISM");

  assert.equal(prism.valueString, undefined);
  assert.equal(prism.valueQuantity?.value, 2);
  assert.equal(prism.valueQuantity?.code, "[diop]");
  assert.equal(prism.valueCodeableConcept?.coding?.[0]?.code, "up");
});

test("Observation bodySite extension references contained BodyStructure", () => {
  const { resource } = buildIopObservation({
    ...common,
    value: 15,
    method: osodConcept("GAT", "GAT"),
  });

  assert.equal(resource.contained?.[0]?.resourceType, "BodyStructure");
  assert.equal(resource.contained?.[0]?.id, "osod-eye-od");
  assertBodyStructureReference(resource, "#osod-eye-od");
});

test("Observation.derivedFrom is created when sourceReference exists", () => {
  const { resource } = buildIopObservation({
    ...common,
    value: 15,
    method: osodConcept("GAT", "GAT"),
    sourceReferences: ["DocumentReference/doc1"],
  });

  assert.equal(resource.derivedFrom?.[0]?.reference, "DocumentReference/doc1");
});

test("DocumentReference indexes raw assets and does not confuse SHA-1 hash with OSOD SHA-256", () => {
  const doc = buildDocumentReference({
    patientReference: patientReference("p1"),
    encounterReference: encounterReference("e1"),
    contentType: "application/pdf",
    originalFilename: "vf.pdf",
    sha1Base64: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=",
    sha256: "9b23f02f2d3a7f3c3d1b1b35d5cfe6629f1fbd7ee7b1f0a9f0ecf06b969b7c1d",
    description: "Humphrey VF PDF",
  });

  assert.equal(doc.content[0].attachment.hash, "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=");
  assert.equal(
    doc.extension?.find((e) => e.url === OSOD_EXTENSION_URLS.sourceSha256)?.valueString,
    "9b23f02f2d3a7f3c3d1b1b35d5cfe6629f1fbd7ee7b1f0a9f0ecf06b969b7c1d",
  );
  assert.equal(doc.context?.encounter?.[0]?.reference, "Encounter/e1");
});

test("DiagnosticReport pattern links grouped eye Observations", () => {
  const report = buildDiagnosticReport({
    code: "VISUAL_ACUITY_PANEL",
    display: "Visual acuity panel",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    effectiveDateTime: common.measuredAt,
    resultReferences: ["Observation/od-va", "Observation/os-va"],
  });

  assert.equal(report.result?.length, 2);
  assert.equal(report.encounter?.reference, "Encounter/e1");
});

test("Provenance supports parser/manual attribution and source entity linkage", () => {
  const provenance = buildProvenance({
    targetReferences: ["Observation/o1"],
    entityReferences: ["DocumentReference/doc1"],
    agents: [{ whoDisplay: "OSOD MCP create_observation", typeCode: "manual" }],
  });

  assert.equal(provenance.target[0].reference, "Observation/o1");
  assert.equal(provenance.agent[0].who.display, "OSOD MCP create_observation");
  assert.equal(provenance.agent[0].type?.coding?.[0]?.system, "http://terminology.hl7.org/CodeSystem/provenance-participant-type");
  assert.equal(provenance.agent[0].type?.coding?.[0]?.code, "author");
  assert.equal(provenance.entity?.[0]?.what.reference, "DocumentReference/doc1");
});

test("ophthalmology code binding version is 0.3.0", () => {
  assert.equal(OPHTHALMOLOGY_CODE_BINDING_VERSION, "0.3.0");
});

test("code-binding YAML has local concepts and no finalized unverified external codes", () => {
  const yaml = readFileSync(
    resolve(process.cwd(), "../data/code-bindings/ophthalmology-concepts.yaml"),
    "utf8",
  );

  for (const id of [
    "VISUAL_ACUITY",
    "VA_SNELLEN_RAW",
    "VA_LOGMAR",
    "VA_LETTER_SCORE",
    "INTRAOCULAR_PRESSURE",
    "REFRACTION",
    "SPHERE",
    "CYLINDER",
    "AXIS",
    "ADD",
  ]) {
    assert.match(yaml, new RegExp(`id: ${id}\\b`));
  }

  assert.match(yaml, /codeSystem: "https:\/\/osod\.dev\/fhir\/CodeSystem\/ophthalmology"/);
  assert.doesNotMatch(yaml, /\b(system|code):\s+"(http:\/\/loinc\.org|http:\/\/snomed\.info|urn:dicom)/);
  assert.doesNotMatch(yaml, /status:\s+"(final|active|verified)"/);
});

test("FHIR client create merges the X-OSOD-Source audit header", async () => {
  const originalFetch = globalThis.fetch;
  let observedHeaders: HeadersInit | undefined;

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    observedHeaders = init?.headers;
    return new Response(JSON.stringify({ resourceType: "Patient", id: "p1" }), {
      status: 201,
      headers: { "Content-Type": "application/fhir+json" },
    });
  }) as typeof fetch;

  try {
    const client = createMedplumClient({ baseUrl: "http://localhost:8103" });
    await client.create(
      { resourceType: "Patient" } as never,
      { "X-OSOD-Source": "mcp/create_observation" },
    );
    assert.equal((observedHeaders as Record<string, string>)["X-OSOD-Source"], "mcp/create_observation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function component(observation: Observation, code: string): ObservationComponent {
  const found = observation.component?.find((c) => c.code.coding?.some((coding) => coding.code === code));
  assert.ok(found, `Expected component ${code}`);
  return found;
}

function assertCoding(
  codings: Observation["code"]["coding"],
  system: string,
  code: string,
): void {
  assert.ok(
    codings?.some((coding) => coding.system === system && coding.code === code),
    `Expected coding ${system}|${code}`,
  );
}

function assertExamCategory(observation: Observation): void {
  assert.ok(
    observation.category?.some((category) =>
      category.coding?.some(
        (coding) =>
          coding.system === "http://terminology.hl7.org/CodeSystem/observation-category" &&
          coding.code === "exam",
      ),
    ),
    "Expected Observation.category=exam",
  );
}

function assertBodyStructureReference(observation: Observation, expectedReference: string): void {
  assert.equal(
    observation.bodySite?.extension?.find(
      (extension) => extension.url === BODY_SITE_REFERENCE_EXTENSION_URL,
    )?.valueReference?.reference,
    expectedReference,
  );
}
