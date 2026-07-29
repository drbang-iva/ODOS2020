import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  DiagnosticReport,
  Media,
  Provenance,
  QuestionnaireResponse,
} from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  CATEGORY_DISPLAY,
  handleImagingCaptureRequest,
  handleImagingListRequest,
  handleImagingStructureRefinementRequest,
  IMAGING_REFINEMENT_CONFIDENCE_SYSTEM,
  MAX_MANUAL_IMAGING_BYTES,
  type ImagingEndpointDeps,
  type ImagingFhirClient,
} from "../src/clinical-graph/imaging-endpoint.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import type {
  BinaryAttempt,
  BinaryAttemptStore,
} from "../src/legacy-import/binary-attempt-store.js";
import { LEGACY_FILE_IDENTIFIER_SYSTEM } from "../src/legacy-import/binary-transport.js";

const AUTH = "Bearer good";
const DATA = Buffer.from("manual scan bytes").toString("base64");
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  category: "visual-field",
  file: {
    name: "Humphrey VF.pdf",
    contentType: "application/pdf",
    data: DATA,
  },
};

function deps(
  role: PracticeRoleId = "clinician",
  seededMedia: Media[] = [],
  pagedMedia: Media[][] = [],
  options: {
    authToken?: string;
    failCreateResourceType?: string;
    failTransaction?: boolean;
    staffReference?: string;
  } = {},
) {
  const created: Array<{ resource: Media | DiagnosticReport | Provenance; headers?: Record<string, string> }> = [];
  const searches: Array<{ resourceType: string; params: Record<string, string> }> = [];
  const binaryBodies: Uint8Array[] = [];
  const transactions: Bundle[] = [];
  const attempts = new TestBinaryAttemptStore();
  const firstPageMedia = seededMedia.map((row) => structuredClone(row));
  const followingPages = pagedMedia.map((page) => page.map((row) => structuredClone(row)));
  const media = [...firstPageMedia, ...followingPages.flat()];
  const pageReads: string[] = [];
  const fhir: ImagingFhirClient = {
    read: async <T extends Media>(_resourceType: T["resourceType"], id: string): Promise<T> => {
      const row = media.find((candidate) => candidate.id === id);
      if (!row) throw new Error(`Missing Media/${id}`);
      return structuredClone(row) as T;
    },
    create: async <T extends Media | DiagnosticReport | Provenance>(
      resource: T,
      headers?: Record<string, string>,
    ): Promise<T> => {
      if (resource.resourceType === options.failCreateResourceType) {
        throw new Error(`Synthetic ${resource.resourceType} create failure`);
      }
      created.push({ resource, headers });
      return { ...resource, id: `${resource.resourceType.toLowerCase()}-${created.length}` };
    },
    search: async <T extends Media | QuestionnaireResponse>(
      resourceType: T["resourceType"],
      params: Record<string, string> = {},
    ): Promise<Bundle<T>> => {
      searches.push({ resourceType, params: { ...params } });
      const selectedMedia = params._id
        ? media.filter((resource) => params._id!.split(",").includes(resource.id ?? ""))
        : firstPageMedia;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resourceType === "Media"
          ? selectedMedia.map((resource) => ({ resource: structuredClone(resource) as T }))
          : [],
        ...(resourceType === "Media" && !params._id && followingPages.length
          ? { link: [{ relation: "next", url: "https://medplum.test/fhir/R4/Media?page=0" }] }
          : {}),
      };
    },
    searchUrl: async <T extends Media | QuestionnaireResponse>(
      url: string,
      resourceType: T["resourceType"],
    ): Promise<Bundle<T>> => {
      pageReads.push(url);
      const pageIndex = Number(new URL(url).searchParams.get("page"));
      const page = followingPages[pageIndex] ?? [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resourceType === "Media"
          ? page.map((resource) => ({ resource: structuredClone(resource) as T }))
          : [],
        ...(pageIndex + 1 < followingPages.length
          ? { link: [{ relation: "next", url: `https://medplum.test/fhir/R4/Media?page=${pageIndex + 1}` }] }
          : {}),
      };
    },
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      transactions.push(structuredClone(bundle));
      if (options.failTransaction) throw new Error("Synthetic transaction failure");
      const updated = bundle.entry?.[0]?.resource;
      const provenance = bundle.entry?.[1]?.resource;
      assert.equal(updated?.resourceType, "Media");
      assert.equal(provenance?.resourceType, "Provenance");
      const index = media.findIndex((candidate) => candidate.id === updated.id);
      assert.notEqual(index, -1);
      media[index] = structuredClone(updated as Media);
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { resource: structuredClone(updated), response: { status: "200 OK" } },
          {
            resource: { ...structuredClone(provenance), id: "provenance-transaction-1" },
            response: { status: "201 Created", location: "Provenance/provenance-transaction-1/_history/1" },
          },
        ],
      };
    },
  };
  const authToken = options.authToken ?? AUTH;
  const value: ImagingEndpointDeps = {
    authenticate: async (authHeader) => authHeader === authToken
      ? {
          staffReference: options.staffReference ?? "Practitioner/doc1",
          actorRole: role,
          fhir,
          binaryAuth: {
            baseUrl: "http://medplum.test",
            accessToken: "good",
            fetch: async (_url, init) => {
              binaryBodies.push(new Uint8Array(init?.body as Uint8Array));
              return new Response(JSON.stringify({
                resourceType: "Binary",
                id: `binary-${binaryBodies.length}`,
                contentType: init?.headers
                  ? new Headers(init.headers).get("Content-Type") ?? undefined
                  : undefined,
              }), {
                status: 201,
                headers: { "Content-Type": "application/fhir+json" },
              });
            },
          },
        }
      : null,
    binaryAttempts: attempts,
    storageBaseUrls: ["https://storage.test/"],
    now: () => "2026-07-13T18:00:00.000Z",
  };
  return { attempts, binaryBodies, created, deps: value, media, pageReads, searches, transactions };
}

test("manual imaging upload persists Media, preliminary interpretation report, and patient-scoped Provenance", async () => {
  const { created, deps: endpointDeps } = deps();

  const result = await handleImagingCaptureRequest(endpointDeps, {
    authHeader: AUTH,
    body: { ...BODY, interpretation: "Field is reliable without glaucomatous defect." },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), ["Media", "DiagnosticReport", "Provenance"]);
  assert.equal(created.every((entry) => entry.headers?.["X-ODOS-Source"] === "mcp/manual_imaging_upload"), true);
  const media = created[0]!.resource as Media;
  assert.equal(media.status, "completed");
  assert.equal(media.subject?.reference, BODY.patientReference);
  assert.equal(media.encounter?.reference, BODY.encounterReference);
  assert.equal(media.modality?.coding?.[0]?.code, "visual-field");
  assert.equal(media.content.title, BODY.file.name);
  assert.equal(media.content.size, Buffer.from(DATA, "base64").length);
  assert.equal(media.content.hash, "pIUIFznszMiWDxXbnYbZX00K/rc=");
  assert.equal(media.content.url, "Binary/binary-1");
  assert.equal(media.content.data, undefined);

  const report = created[1]!.resource as DiagnosticReport;
  assert.equal(report.status, "preliminary");
  assert.equal(report.media?.[0]?.link.reference, "Media/media-1");
  assert.equal(report.resultsInterpreter?.[0]?.reference, "Practitioner/doc1");
  assert.equal(report.conclusion, "Field is reliable without glaucomatous defect.");

  const provenance = created[2]!.resource as Provenance;
  assert.deepEqual(provenance.target.map((target) => target.reference), [
    "Media/media-1",
    "DiagnosticReport/diagnosticreport-2",
    BODY.patientReference,
  ]);
});

test("manual imaging upload omits DiagnosticReport when no interpretation was entered", async () => {
  const { created, deps: endpointDeps } = deps();

  const result = await handleImagingCaptureRequest(endpointDeps, { authHeader: AUTH, body: BODY });

  assert.equal(result.status, 200);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), ["Media", "Provenance"]);
  assert.equal("diagnosticReportReference" in (result.body as object), false);
});

test("manual imaging raw Binary transport accepts files above 1 MB and restores the 15 MB ceiling", async () => {
  const aboveLegacyCeiling = Buffer.alloc((1 * 1024 * 1024) + 1, 7);
  const { binaryBodies, created, deps: endpointDeps } = deps();
  const accepted = await handleImagingCaptureRequest(endpointDeps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      category: "oct",
      file: {
        ...BODY.file,
        name: "macular-oct.png",
        contentType: "image/png",
        data: aboveLegacyCeiling.toString("base64"),
      },
    },
  });

  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(binaryBodies[0]?.byteLength, aboveLegacyCeiling.byteLength);
  assert.equal((created[0]?.resource as Media).content.data, undefined);
  assert.equal((created[0]?.resource as Media).content.url, "Binary/binary-1");
});

test("a Binary whose Media create fails remains open in the M0 disposal ledger", async () => {
  const harness = deps("clinician", [], [], { failCreateResourceType: "Media" });

  await assert.rejects(
    handleImagingCaptureRequest(harness.deps, { authHeader: AUTH, body: BODY }),
    /Synthetic Media create failure/,
  );

  assert.equal(harness.created.length, 0);
  assert.deepEqual(await harness.attempts.listOpen(), [{
    attemptId: "attempt-1",
    sourceFilename: "Humphrey VF.pdf",
    patientReference: "Patient/p1",
    binaryId: "binary-1",
    status: "open",
    openedAt: "2026-07-13T18:00:00.000Z",
    requestReturnedAt: "2026-07-13T18:00:00.000Z",
  }]);
});

test("manual imaging upload rejects missing authority and unsafe file boundaries", async () => {
  const unauthenticated = await handleImagingCaptureRequest(deps().deps, { authHeader: undefined, body: BODY });
  assert.equal(unauthenticated.status, 401);

  const forbidden = await handleImagingCaptureRequest(deps("front-desk").deps, { authHeader: AUTH, body: BODY });
  assert.equal(forbidden.status, 403);

  const unsupported = await handleImagingCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...BODY, file: { ...BODY.file, contentType: "image/svg+xml" } },
  });
  assert.equal(unsupported.status, 400);

  const oversized = await handleImagingCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...BODY, file: { ...BODY.file, data: Buffer.alloc(MAX_MANUAL_IMAGING_BYTES + 1).toString("base64") } },
  });
  assert.equal(oversized.status, 400);
  assert.deepEqual(oversized.body, { error: "Imaging files may not exceed 15 MB." });
});

test("imaging list reads patient or encounter scope with all modalities and display metadata", async () => {
  const seeded = [
    image("oct-os", "2026-07-12T10:00:00.000Z", "oct", {
      bodySite: {
        text: "Macula",
        extension: [{
          url: "https://odos2020.com/fhir/StructureDefinition/laterality",
          valueCodeableConcept: { coding: [{ code: "OS" }] },
        }],
      },
      deviceName: "Cirrus 6000",
      content: {
        contentType: "image/png",
        title: "Macular cube OS",
        url: "https://storage.test/oct-os/1?Expires=60&Signature=signed",
      },
    }),
    image("inline-biometry", "2026-07-11T10:00:00.000Z", "biometry", {
      bodySite: { coding: [{ code: "Cornea", display: "Cornea" }, { code: "OD" }] },
      content: { contentType: "image/png", title: "Biometry OD", data: DATA },
    }),
    image("broken", "2026-07-10T10:00:00.000Z", "other", {
      content: { contentType: "application/pdf", title: "Missing original", url: "Binary/not-rewritten" },
    }),
  ];
  const harness = deps("clinician", seeded);

  const byPatient = await handleImagingListRequest(harness.deps, {
    authHeader: AUTH,
    query: { patient: "Patient/p1" },
  });
  const byEncounter = await handleImagingListRequest(harness.deps, {
    authHeader: AUTH,
    query: { encounter: "Encounter/e1" },
  });

  assert.equal(byPatient.status, 200);
  assert.equal(byEncounter.status, 200);
  assert.deepEqual(Object.keys(CATEGORY_DISPLAY), [
    "visual-field",
    "fundus-photo",
    "anterior-segment-photo",
    "oct",
    "biometry",
    "referral-scan",
    "outside-record",
    "other",
  ]);
  const images = (byPatient.body as { images: Array<Record<string, unknown>> }).images;
  assert.deepEqual(images.map((row) => row.id), ["oct-os", "inline-biometry", "broken"]);
  assert.deepEqual(images[0], {
    id: "oct-os",
    mediaReference: "Media/oct-os",
    encounterReference: "Encounter/e1",
    category: "oct",
    structure: "Macula",
    laterality: "OS",
    date: "2026-07-12T10:00:00.000Z",
    title: "Macular cube OS",
    device: "Cirrus 6000",
    contentType: "image/png",
    contentUrl: "https://storage.test/oct-os/1?Expires=60&Signature=signed",
    contentState: "available",
  });
  assert.match(String(images[1]?.contentUrl), /^data:image\/png;base64,/);
  assert.equal(images[1]?.structure, "Cornea");
  assert.equal(images[1]?.laterality, "OD");
  assert.equal(images[2]?.contentState, "missing");
  assert.equal(images[2]?.contentUrl, undefined);
  assert.deepEqual(harness.searches.map((search) => search.params), [
    { patient: "Patient/p1", status: "completed", _sort: "-created", _count: "50" },
    { _id: "oct-os,inline-biometry,broken", _count: "100" },
    { encounter: "Encounter/e1", status: "completed", _sort: "-created", _count: "50" },
    { _id: "oct-os,inline-biometry,broken", _count: "100" },
  ]);
});

test("imaging list enforces chart.read and exactly one supported scope", async () => {
  const auditorAuth = "Bearer disposable-auditor";
  const forbidden = await handleImagingListRequest(deps("auditor", [], [], {
    authToken: auditorAuth,
    staffReference: "Practitioner/disposable-auditor",
  }).deps, {
    authHeader: auditorAuth,
    query: { patient: "Patient/p1" },
  });
  const ambiguous = await handleImagingListRequest(deps().deps, {
    authHeader: AUTH,
    query: { patient: "Patient/p1", encounter: "Encounter/e1" },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(ambiguous.status, 400);
});

test("imaging list keeps all eight coded categories and uncoded M0 legacy imaging while excluding longitudinal and meibography-shaped Media", async () => {
  const legitimate = Object.keys(CATEGORY_DISPLAY).map((category, index) =>
    image(`category-${category}`, `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`, category as keyof typeof CATEGORY_DISPLAY)
  );
  const legacy = image("legacy-uncoded", "2026-07-20T10:00:00.000Z", "other", {
    modality: undefined,
    identifier: [{ system: LEGACY_FILE_IDENTIFIER_SYSTEM, value: "legacy-uncoded.png" }],
  });
  const longitudinal = image("aesthetic-photo", "2026-07-21T10:00:00.000Z", "other", {
    modality: undefined,
    bodySite: { text: "Full face" },
    note: [{ text: "Procedure definition: botox-follow-up" }],
  });
  const meibographyShaped = image("meibography-media", "2026-07-22T10:00:00.000Z", "other", {
    modality: undefined,
    bodySite: { text: "Meibomian glands" },
  });
  const harness = deps("clinician", [...legitimate, legacy, longitudinal, meibographyShaped]);

  const result = await handleImagingListRequest(harness.deps, {
    authHeader: AUTH,
    query: { patient: "Patient/p1" },
  });

  assert.equal(result.status, 200);
  const images = (result.body as { images: Array<{ id: string; category: string }> }).images;
  assert.deepEqual(new Set(images.map((row) => row.category)), new Set(Object.keys(CATEGORY_DISPLAY)));
  assert.equal(images.some((row) => row.id === "legacy-uncoded" && row.category === "other"), true);
  assert.equal(images.some((row) => row.id === "aesthetic-photo"), false);
  assert.equal(images.some((row) => row.id === "meibography-media"), false);
});

test("imaging list follows every 50-row FHIR page and rejects unsafe attachment schemes", async () => {
  const harness = deps(
    "clinician",
    [image("page-1", "2026-07-12T10:00:00.000Z", "fundus-photo")],
    [[
      image("page-2", "2026-07-11T10:00:00.000Z", "oct"),
      image("unsafe", "2026-07-10T10:00:00.000Z", "other", {
        content: { contentType: "application/pdf", title: "Unsafe", url: "javascript:alert(1)" },
      }),
    ]],
  );

  const result = await handleImagingListRequest(harness.deps, {
    authHeader: AUTH,
    query: { patient: "Patient/p1" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(harness.pageReads, ["https://medplum.test/fhir/R4/Media?page=0"]);
  const images = (result.body as { images: Array<Record<string, unknown>> }).images;
  assert.deepEqual(images.map((row) => row.id), ["page-1", "page-2", "unsafe"]);
  assert.equal(images[2]?.contentState, "missing");
  assert.equal(images[2]?.contentUrl, undefined);
});

test("imaging list fails closed when FHIR pagination exceeds the explicit page cap", async () => {
  const followingPages = Array.from({ length: 100 }, (_, index) => [
    image(`page-${index + 2}`, "2026-07-11T10:00:00.000Z", "fundus-photo"),
  ]);
  const harness = deps(
    "clinician",
    [image("page-1", "2026-07-12T10:00:00.000Z", "fundus-photo")],
    followingPages,
  );

  await assert.rejects(
    handleImagingListRequest(harness.deps, {
      authHeader: AUTH,
      query: { patient: "Patient/p1" },
    }),
    /exceeded 100 pages/,
  );
  assert.equal(harness.pageReads.length, 99);
});

test("OCT structure refinement changes bodySite and records provisional or confirmed Provenance", async () => {
  const harness = deps("clinician", [image("oct-1", "2026-07-12T10:00:00.000Z", "oct")]);
  const result = await handleImagingStructureRefinementRequest(harness.deps, {
    authHeader: AUTH,
    mediaId: "oct-1",
    body: { structure: "RNFL", laterality: "OU", confidence: "clinician-confirmed" },
  });

  assert.equal(result.status, 200);
  const transaction = harness.transactions[0];
  assert.equal(transaction?.entry?.[0]?.request?.method, "PUT");
  assert.equal(transaction?.entry?.[0]?.request?.ifMatch, 'W/"1"');
  assert.equal((transaction?.entry?.[0]?.resource as Media).bodySite?.text, "RNFL");
  const provenance = transaction?.entry?.[1]?.resource as Provenance;
  assert.equal(provenance.meta?.tag?.[0]?.system, IMAGING_REFINEMENT_CONFIDENCE_SYSTEM);
  assert.equal(provenance.meta?.tag?.[0]?.code, "clinician-confirmed");
  assert.deepEqual(provenance.target.map((target) => target.reference), [
    "Media/oct-1",
    "Patient/p1",
    "Encounter/e1",
  ]);
  assert.equal((result.body as { provenanceReference?: string }).provenanceReference, "Provenance/provenance-transaction-1");
});

test("structure refinement refuses non-OCT Media before any transaction write", async () => {
  const harness = deps("clinician", [image("fundus-1", "2026-07-12T10:00:00.000Z", "fundus-photo")]);
  const result = await handleImagingStructureRefinementRequest(harness.deps, {
    authHeader: AUTH,
    mediaId: "fundus-1",
    body: { structure: "Posterior pole", confidence: "clinician-confirmed" },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "Structure refinement is limited to OCT Media." });
  assert.equal(harness.transactions.length, 0);
  assert.equal(harness.created.length, 0);
});

test("migrated OCT Media remains eligible for atomic clinician refinement", async () => {
  const harness = deps("clinician", [image("migrated-oct", "2021-03-04T10:00:00.000Z", "oct", {
    meta: {
      versionId: "7",
      tag: [{
        system: "https://odos2020.com/tags/migration",
        code: "eyefinity-import",
      }],
    },
  })]);

  const result = await handleImagingStructureRefinementRequest(harness.deps, {
    authHeader: AUTH,
    mediaId: "migrated-oct",
    body: { structure: "Optic nerve", laterality: "OU", confidence: "clinician-confirmed" },
  });

  assert.equal(result.status, 200);
  assert.equal(harness.transactions[0]?.entry?.[0]?.request?.ifMatch, 'W/"7"');
  assert.equal((harness.transactions[0]?.entry?.[0]?.resource as Media).bodySite?.text, "Optic nerve");
});

test("structure refinement transaction failure leaves Media unchanged and creates no Provenance", async () => {
  const original = image("oct-atomic", "2026-07-12T10:00:00.000Z", "oct", {
    bodySite: { text: "Macula" },
  });
  const harness = deps("clinician", [original], [], { failTransaction: true });

  await assert.rejects(
    handleImagingStructureRefinementRequest(harness.deps, {
      authHeader: AUTH,
      mediaId: "oct-atomic",
      body: { structure: "RNFL", laterality: "OU", confidence: "clinician-confirmed" },
    }),
    /Synthetic transaction failure/,
  );

  assert.equal(harness.transactions.length, 1);
  assert.deepEqual(harness.media[0]?.bodySite, { text: "Macula" });
  assert.equal(harness.created.some((entry) => entry.resource.resourceType === "Provenance"), false);
});

function image(
  id: string,
  createdDateTime: string,
  category: keyof typeof CATEGORY_DISPLAY,
  overrides: Partial<Media> = {},
): Media {
  return {
    resourceType: "Media",
    id,
    status: "completed",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    createdDateTime,
    meta: { versionId: "1" },
    modality: {
      coding: [{
        system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
        code: category,
        display: CATEGORY_DISPLAY[category],
      }],
    },
    content: {
      contentType: "image/png",
      title: `${id}.png`,
      url: `https://storage.test/${id}/1?Expires=60&Signature=signed`,
    },
    ...overrides,
  };
}

class TestBinaryAttemptStore implements BinaryAttemptStore {
  readonly rows: BinaryAttempt[] = [];

  async open(input: {
    sourceFilename: string;
    patientReference: string;
    mediaId?: string;
  }): Promise<BinaryAttempt> {
    const row: BinaryAttempt = {
      attemptId: `attempt-${this.rows.length + 1}`,
      sourceFilename: input.sourceFilename,
      patientReference: input.patientReference,
      ...(input.mediaId ? { mediaId: input.mediaId } : {}),
      status: "open",
      openedAt: "2026-07-13T18:00:00.000Z",
    };
    this.rows.push(row);
    return row;
  }

  async recordReturned(attemptId: string, binaryId: string): Promise<BinaryAttempt> {
    return this.replace(attemptId, { binaryId, requestReturnedAt: "2026-07-13T18:00:00.000Z" });
  }

  async resolveAttached(attemptId: string, mediaId: string, binaryId: string): Promise<BinaryAttempt> {
    return this.replace(attemptId, {
      mediaId,
      binaryId,
      status: "resolved-attached",
      resolvedAt: "2026-07-13T18:00:00.000Z",
    });
  }

  async resolveAttachedByBinaryId(): Promise<number> {
    return 0;
  }

  async resolveNotCreated(attemptId: string, detail: string): Promise<BinaryAttempt> {
    return this.replace(attemptId, { status: "resolved-not-created", resolutionDetail: detail });
  }

  async resolveDisposed(attemptId: string, detail: string): Promise<BinaryAttempt> {
    return this.replace(attemptId, { status: "resolved-disposed", resolutionDetail: detail });
  }

  async reopenByBinaryId(): Promise<void> {
    return;
  }

  async listOpen(): Promise<BinaryAttempt[]> {
    return this.rows.filter((row) => row.status === "open");
  }

  private replace(attemptId: string, updates: Partial<BinaryAttempt>): BinaryAttempt {
    const index = this.rows.findIndex((row) => row.attemptId === attemptId);
    assert.notEqual(index, -1);
    const next = { ...this.rows[index]!, ...updates };
    this.rows[index] = next;
    return next;
  }
}
