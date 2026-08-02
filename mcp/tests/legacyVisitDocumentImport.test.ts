import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  Binary,
  Bundle,
  DocumentReference,
  Encounter,
  Identifier,
  Patient,
  Resource,
} from "@medplum/fhirtypes";
import {
  createMedplumClient,
  type FhirSearchParams,
} from "../src/fhir-client.js";
import {
  EHR_PATIENT_IDENTIFIER_SYSTEM,
  EPM_PATIENT_IDENTIFIER_SYSTEM,
} from "../src/legacy-import/patient-import.js";
import {
  importLegacyVisitDocumentsForPid,
  LEGACY_VISIT_DOCUMENT_IDENTIFIER_SYSTEM,
  type LegacyVisitDocumentSource,
} from "../src/legacy-import/visit-document-import.js";
import {
  MIGRATION_TAG_CODE,
  MIGRATION_TAG_SYSTEM,
} from "../src/legacy-import/access-policy.js";
import {
  discoverLegacyVisitDocumentSources,
  formatLegacyVisitDocumentReport,
} from "../../scripts/import-legacy-visit-documents.js";
import {
  TEST_FHIR_AUDIT_CONTEXT,
  TEST_FHIR_AUDIT_RECORDER,
} from "./fhirAuditTestStub.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 synthetic visit document");
const SOURCE_PATH = fileURLToPath(
  new URL("../src/legacy-import/visit-document-import.ts", import.meta.url),
);

const KNOWN_GOOD_CROSSWALKS = [
  ["968", "14532559"],
  ["970", "15537266"],
  ["971", "11796132"],
  ["973", "11752320"],
  ["974", "12599768"],
  ["975", "15537259"],
  ["976", "12599769"],
  ["15117", "18861516"],
  ["27175", "41835963"],
  ["27328", "41917096"],
] as const;

test("per-visit PDFs follow preliminary, raw Binary upload/tag/hash, then final sequence", async () => {
  const events: string[] = [];
  const fhir = new MemoryVisitDocumentFhir([
    patient("patient-1", "970", "15537266"),
    encounter("encounter-1", "patient-1", "2021-01-31"),
  ], events);
  const transport = new BinaryTransport(events);
  let reads = 0;
  const source = visitSource("15537266", "18581230", "Encounter", async () => {
    reads += 1;
    return PDF_BYTES;
  });

  const first = await importLegacyVisitDocumentsForPid({
    fhir,
    projectId: "project-1",
    pid: "15537266",
    sources: [source],
    auth: transport.auth,
  });

  assert.equal(first.action, "imported");
  assert.equal(first.patientReference, "Patient/patient-1");
  assert.equal(first.documents[0]?.identifier, "15537266|18581230|Encounter");
  assert.equal(first.documents[0]?.action, "created");
  assert.equal(first.documents[0]?.encounterReference, "Encounter/encounter-1");
  assert.equal(reads, 1);
  assert.deepEqual(events.filter((event) =>
    event.startsWith("create:") || event.startsWith("update:") || event.startsWith("binary:")
  ), [
    "create:DocumentReference",
    "binary:POST",
    "binary:PUT",
    "binary:GET",
    "update:DocumentReference",
  ]);

  const created = fhir.created[0] as DocumentReference;
  assert.equal(created.docStatus, "preliminary");
  assert.equal(created.date, "2021-01-31T12:00:00Z");
  assert.equal(created.content[0]?.attachment.url, undefined);
  assert.deepEqual(created.context?.encounter, [{ reference: "Encounter/encounter-1" }]);
  assert.deepEqual(created.meta?.tag, [{
    system: MIGRATION_TAG_SYSTEM,
    code: MIGRATION_TAG_CODE,
  }]);
  assert.deepEqual(created.identifier, [{
    system: LEGACY_VISIT_DOCUMENT_IDENTIFIER_SYSTEM,
    value: "15537266|18581230|Encounter",
  }]);

  const final = fhir.ofType<DocumentReference>("DocumentReference")[0]!;
  assert.equal(final.docStatus, "final");
  assert.equal(final.content[0]?.attachment.url, "Binary/binary-1");
  assert.equal(final.content[0]?.attachment.size, PDF_BYTES.byteLength);
  assert.equal(fhir.updateHeaders[0]?.["If-Match"], 'W/"1"');
  assert.equal(transport.uploadSecurityContexts[0], `DocumentReference/${final.id}`);
  assert.deepEqual(transport.taggedBinaries[0]?.meta?.tag, [{
    system: MIGRATION_TAG_SYSTEM,
    code: MIGRATION_TAG_CODE,
  }]);

  const beforeRerunEvents = events.length;
  const second = await importLegacyVisitDocumentsForPid({
    fhir,
    projectId: "project-1",
    pid: "15537266",
    sources: [source],
    auth: transport.auth,
  });
  assert.equal(second.documents[0]?.action, "already-imported");
  assert.equal(fhir.ofType<DocumentReference>("DocumentReference").length, 1);
  assert.equal(transport.binaryCount, 1);
  assert.equal(reads, 1);
  assert.equal(events.slice(beforeRerunEvents).some((event) => event.startsWith("binary:")), false);
});

test("hash mismatch leaves the anchor preliminary and never writes a Binary URL", async () => {
  const events: string[] = [];
  const fhir = new MemoryVisitDocumentFhir([
    patient("patient-1", "968", "14532559"),
  ], events);
  const transport = new BinaryTransport(events, true);

  await assert.rejects(
    importLegacyVisitDocumentsForPid({
      fhir,
      projectId: "project-1",
      pid: "14532559",
      sources: [visitSource("14532559", "100", "Visit")],
      auth: transport.auth,
    }),
    /failed byte-size or SHA-256 verification/,
  );

  const document = fhir.ofType<DocumentReference>("DocumentReference")[0]!;
  assert.equal(document.docStatus, "preliminary");
  assert.equal(document.content[0]?.attachment.url, undefined);
  assert.equal(events.includes("update:DocumentReference"), false);
});

test("known crosswalk fixtures resolve only through the EHR identifier and retain both identifiers", async () => {
  const resources = KNOWN_GOOD_CROSSWALKS.map(([epmId, pid], index) =>
    patient(`patient-${index + 1}`, epmId, pid)
  );
  const events: string[] = [];
  const fhir = new MemoryVisitDocumentFhir(resources, events);
  const transport = new BinaryTransport(events);

  for (const [, pid] of KNOWN_GOOD_CROSSWALKS) {
    const result = await importLegacyVisitDocumentsForPid({
      fhir,
      projectId: "project-1",
      pid,
      sources: [visitSource(pid, `8${pid}`, "Visit")],
      auth: transport.auth,
    });
    assert.equal(result.patientMatchCount, 1);
    assert.equal(result.documents.length, 1);
  }

  assert.equal(fhir.patientSearches.length, KNOWN_GOOD_CROSSWALKS.length);
  for (const [index, search] of fhir.patientSearches.entries()) {
    assert.deepEqual(search, {
      _count: "100",
      identifier: `${EHR_PATIENT_IDENTIFIER_SYSTEM}|${KNOWN_GOOD_CROSSWALKS[index]![1]}`,
    });
  }
  assert.ok(resources.every((resource) => resource.identifier?.some(
    (identifier) => identifier.system === EPM_PATIENT_IDENTIFIER_SYSTEM,
  )));
  assert.ok(resources.every((resource) => resource.identifier?.some(
    (identifier) => identifier.system === EHR_PATIENT_IDENTIFIER_SYSTEM,
  )));
});

test("unmapped and ambiguous PIDs skip before Encounter search, file read, or resource creation", async () => {
  const scenarios = [
    {
      pid: "900000972",
      resources: [] as Patient[],
      expectedMatches: 0,
    },
    {
      pid: "43838679",
      resources: [
        patient("candidate-1", "974", "43838679"),
        patient("candidate-2", "synthetic-other", "43838679"),
      ],
      expectedMatches: 2,
    },
  ];

  for (const scenario of scenarios) {
    const events: string[] = [];
    const fhir = new MemoryVisitDocumentFhir(scenario.resources, events);
    const transport = new BinaryTransport(events);
    let reads = 0;
    const result = await importLegacyVisitDocumentsForPid({
      fhir,
      projectId: "project-1",
      pid: scenario.pid,
      sources: [visitSource(scenario.pid, "100", "Encounter", async () => {
        reads += 1;
        return PDF_BYTES;
      })],
      auth: transport.auth,
    });
    assert.equal(result.action, "skipped-patient");
    assert.equal(result.patientMatchCount, scenario.expectedMatches);
    assert.deepEqual(result.documents, []);
    assert.equal(reads, 0);
    assert.equal(fhir.created.length, 0);
    assert.equal(fhir.searches.some((search) => search.resourceType === "Encounter"), false);
    assert.equal(transport.binaryCount, 0);
    assert.match(formatLegacyVisitDocumentReport([result]), /skipped patient_matches=/);
  }
});

test("all six known-junk source fixtures skip through a zero-result identifier search", async () => {
  const junkFixtures = ["972", "25872", "25874", "26185", "26304", "27176"]
    .map((sourceKey) => ({ sourceKey, pid: `9${sourceKey.padStart(8, "0")}` }));

  for (const fixture of junkFixtures) {
    const fhir = new MemoryVisitDocumentFhir([], []);
    const result = await importLegacyVisitDocumentsForPid({
      fhir,
      projectId: "project-1",
      pid: fixture.pid,
      sources: [visitSource(fixture.pid, "100", "Visit")],
      auth: new BinaryTransport([]).auth,
    });
    assert.equal(result.action, "skipped-patient", `sourceKey ${fixture.sourceKey}`);
    assert.equal(result.patientMatchCount, 0, `sourceKey ${fixture.sourceKey}`);
    assert.equal(fhir.created.length, 0, `sourceKey ${fixture.sourceKey}`);
  }

  const implementation = readFileSync(SOURCE_PATH, "utf8");
  for (const { sourceKey } of junkFixtures) {
    assert.equal(implementation.includes(`"${sourceKey}"`), false);
  }
});

test("patient matching has no name or DOB path", () => {
  const implementation = readFileSync(SOURCE_PATH, "utf8");
  assert.doesNotMatch(implementation, /\bbirthDate\b|\bbirthdate\b/);
  assert.doesNotMatch(implementation, /searchAll<Patient>[\s\S]{0,180}\bname\s*:/);
  assert.match(
    implementation,
    /identifier: `\$\{EHR_PATIENT_IDENTIFIER_SYSTEM\}\|\$\{input\.pid\}`/,
  );
});

test("archive discovery selects only Encounter Final and Visit Final PDFs", async () => {
  const root = mkdtempSync(join(tmpdir(), "odos-visit-documents-"));
  try {
    const encounterPath = join(root, "g1", "14532559", "notes", "18581230");
    mkdirSync(encounterPath, { recursive: true });
    writeFileSync(join(encounterPath, "EMA_20210131T090000_Synthetic_Encounter_Final.pdf"), PDF_BYTES);
    writeFileSync(join(encounterPath, "EMA_20210131T090000_Synthetic_Visit_Final.pdf"), PDF_BYTES);
    writeFileSync(join(encounterPath, "EMA_20210131T090000_Synthetic_CMS1500_Final.pdf"), PDF_BYTES);
    writeFileSync(join(encounterPath, "EMA_20210131T090000_Synthetic_ClinicalSummary_CCD_Final.xml"), "<xml/>");
    mkdirSync(join(root, "not-a-batch"), { recursive: true });

    const groups = await discoverLegacyVisitDocumentSources(root);
    const sources = groups.get("14532559") ?? [];
    assert.deepEqual(sources.map((source) => source.documentType), ["Encounter", "Visit"]);
    assert.deepEqual(sources.map((source) => source.encounterId), ["18581230", "18581230"]);
    assert.deepEqual(await sources[0]!.readBytes(), PDF_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("genuine fhir-client rejects Binary update so migration tagging cannot regress to client.update", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  const fhir = createMedplumClient({
    baseUrl: "http://localhost:8103",
    accessToken: "synthetic-token",
    audit: TEST_FHIR_AUDIT_RECORDER,
    auditContext: TEST_FHIR_AUDIT_CONTEXT,
  });
  const binary: Binary = {
    resourceType: "Binary",
    id: "binary-1",
    contentType: "application/pdf",
    securityContext: { reference: "DocumentReference/document-1" },
  };
  Object.assign(globalThis, {
    fetch: async () => {
      fetched = true;
      return new Response();
    },
  });

  try {
    await assert.rejects(
      fhir.update<Binary>("Binary", "binary-1", binary),
      /Mandate 8 boundary/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function visitSource(
  pid: string,
  encounterId: string,
  documentType: "Encounter" | "Visit",
  readBytes: () => Promise<Uint8Array> = async () => PDF_BYTES,
): LegacyVisitDocumentSource {
  return {
    pid,
    encounterId,
    documentType,
    fileName: `EMA_20210131T090000_Synthetic_${documentType}_Final.pdf`,
    readBytes,
  };
}

function patient(id: string, epmId: string, pid: string): Patient {
  return {
    resourceType: "Patient",
    id,
    identifier: [
      { system: EPM_PATIENT_IDENTIFIER_SYSTEM, value: epmId },
      { system: EHR_PATIENT_IDENTIFIER_SYSTEM, value: pid },
    ],
  };
}

function encounter(id: string, patientId: string, date: string): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${patientId}` },
    period: { start: date, end: date },
  };
}

class MemoryVisitDocumentFhir {
  readonly resources: Resource[];
  readonly created: Resource[] = [];
  readonly searches: Array<{ resourceType: string; params?: Record<string, string> }> = [];
  readonly patientSearches: Array<Record<string, string>> = [];
  readonly updateHeaders: Array<Record<string, string> | undefined> = [];

  constructor(resources: Resource[], private readonly events: string[]) {
    this.resources = [...resources];
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: FhirSearchParams,
  ): Promise<Bundle<T>> {
    const query = Object.fromEntries(new URLSearchParams(params as Record<string, string>));
    this.searches.push({ resourceType, params: query });
    if (resourceType === "Patient") {
      assert.deepEqual(Object.keys(query), ["_count", "identifier"]);
      this.patientSearches.push(query);
    }
    let matches = this.resources.filter((resource) => resource.resourceType === resourceType);
    if (query.identifier) {
      const separator = query.identifier.indexOf("|");
      const system = query.identifier.slice(0, separator);
      const value = query.identifier.slice(separator + 1);
      matches = matches.filter((resource) =>
        ((resource as { identifier?: Identifier[] }).identifier ?? []).some(
          (identifier) => identifier.system === system && identifier.value === value,
        )
      );
    }
    if (resourceType === "Encounter" && query.patient) {
      matches = matches.filter((resource) =>
        (resource as Encounter).subject?.reference === query.patient
      );
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: matches.map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Resource>(
    resource: T,
    _headers?: Record<string, string>,
  ): Promise<T> {
    this.events.push(`create:${resource.resourceType}`);
    const created = {
      ...resource,
      id: `${resource.resourceType.toLowerCase()}-${this.created.length + 1}`,
      meta: { ...resource.meta, versionId: "1" },
    } as T;
    this.resources.push(created);
    this.created.push(structuredClone(created));
    return created;
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    this.events.push(`update:${resourceType}`);
    this.updateHeaders.push(headers);
    const index = this.resources.findIndex((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    assert.notEqual(index, -1);
    const updated = {
      ...resource,
      id,
      meta: { ...resource.meta, versionId: "2" },
    } as T;
    this.resources[index] = updated;
    return updated;
  }

  ofType<T extends Resource>(resourceType: T["resourceType"]): T[] {
    return this.resources.filter(
      (resource): resource is T => resource.resourceType === resourceType,
    );
  }
}

class BinaryTransport {
  readonly uploadSecurityContexts: string[] = [];
  readonly taggedBinaries: Binary[] = [];
  private readonly binaries = new Map<string, Uint8Array>();

  constructor(
    private readonly events: string[],
    private readonly corruptRead = false,
  ) {}

  readonly auth = {
    baseUrl: "http://localhost:8103",
    accessToken: "synthetic-token",
    fetch: async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const requestUrl = String(url);
      if (init?.method === "POST" && requestUrl.endsWith("/fhir/R4/Binary")) {
        this.events.push("binary:POST");
        const id = `binary-${this.binaries.size + 1}`;
        const bytes = new Uint8Array(init.body as Uint8Array);
        this.binaries.set(id, bytes);
        const securityContext = new Headers(init.headers).get("x-security-context")!;
        this.uploadSecurityContexts.push(securityContext);
        return fhirResponse({
          resourceType: "Binary",
          id,
          meta: { versionId: "1" },
          contentType: new Headers(init.headers).get("content-type")!,
          securityContext: { reference: securityContext },
        } satisfies Binary, 201);
      }
      if (init?.method === "PUT" && requestUrl.includes("/fhir/R4/Binary/")) {
        this.events.push("binary:PUT");
        const binary = JSON.parse(String(init.body)) as Binary;
        this.taggedBinaries.push(binary);
        return fhirResponse({ ...binary, meta: { ...binary.meta, versionId: "2" } });
      }
      if ((!init?.method || init.method === "GET") && requestUrl.includes("/fhir/R4/Binary/")) {
        this.events.push("binary:GET");
        const id = requestUrl.split("/").at(-1)!;
        const bytes = this.binaries.get(id)!;
        return new Response(this.corruptRead ? new Uint8Array([0]) : bytes, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      throw new Error(`Unexpected Binary transport request ${init?.method ?? "GET"} ${requestUrl}`);
    },
  };

  get binaryCount(): number {
    return this.binaries.size;
  }
}

function fhirResponse(resource: Resource, status = 200): Response {
  return new Response(JSON.stringify(resource), {
    status,
    headers: { "Content-Type": "application/fhir+json" },
  });
}
