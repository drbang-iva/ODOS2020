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
import type { JsonPatchOperation } from "../src/fhir-client.js";

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
) {
  const created: Array<{ resource: Media | DiagnosticReport | Provenance; headers?: Record<string, string> }> = [];
  const searches: Array<{ resourceType: string; params: Record<string, string> }> = [];
  const patches: JsonPatchOperation[][] = [];
  const binaryBodies: Uint8Array[] = [];
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
      created.push({ resource, headers });
      return { ...resource, id: `${resource.resourceType.toLowerCase()}-${created.length}` };
    },
    patch: async <T extends Media>(
      _resourceType: T["resourceType"],
      id: string,
      operations: JsonPatchOperation[],
    ): Promise<T> => {
      patches.push(operations);
      const row = media.find((candidate) => candidate.id === id);
      if (!row) throw new Error(`Missing Media/${id}`);
      const bodySite = operations.find((operation) => operation.path === "/bodySite")?.value;
      if (bodySite) row.bodySite = bodySite as Media["bodySite"];
      return structuredClone(row) as T;
    },
    search: async <T extends Media | QuestionnaireResponse>(
      resourceType: T["resourceType"],
      params: Record<string, string> = {},
    ): Promise<Bundle<T>> => {
      searches.push({ resourceType, params: { ...params } });
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resourceType === "Media"
          ? firstPageMedia.map((resource) => ({ resource: structuredClone(resource) as T }))
          : [],
        ...(resourceType === "Media" && followingPages.length
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
  };
  const value: ImagingEndpointDeps = {
    authenticate: async (authHeader) => authHeader === AUTH
      ? {
          staffReference: "Practitioner/doc1",
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
    now: () => "2026-07-13T18:00:00.000Z",
  };
  return { binaryBodies, created, deps: value, media, pageReads, patches, searches };
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
    { encounter: "Encounter/e1", status: "completed", _sort: "-created", _count: "50" },
  ]);
});

test("imaging list enforces chart.read and exactly one supported scope", async () => {
  const forbidden = await handleImagingListRequest(deps("auditor").deps, {
    authHeader: AUTH,
    query: { patient: "Patient/p1" },
  });
  const ambiguous = await handleImagingListRequest(deps().deps, {
    authHeader: AUTH,
    query: { patient: "Patient/p1", encounter: "Encounter/e1" },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(ambiguous.status, 400);
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

test("OCT structure refinement changes bodySite and records provisional or confirmed Provenance", async () => {
  const harness = deps("clinician", [image("oct-1", "2026-07-12T10:00:00.000Z", "oct")]);
  const result = await handleImagingStructureRefinementRequest(harness.deps, {
    authHeader: AUTH,
    mediaId: "oct-1",
    body: { structure: "RNFL", laterality: "OU", confidence: "clinician-confirmed" },
  });

  assert.equal(result.status, 200);
  assert.equal(harness.patches[0]?.[0]?.path, "/bodySite");
  const provenance = harness.created.find((entry) => entry.resource.resourceType === "Provenance")
    ?.resource as Provenance;
  assert.equal(provenance.meta?.tag?.[0]?.system, IMAGING_REFINEMENT_CONFIDENCE_SYSTEM);
  assert.equal(provenance.meta?.tag?.[0]?.code, "clinician-confirmed");
  assert.deepEqual(provenance.target.map((target) => target.reference), [
    "Media/oct-1",
    "Patient/p1",
    "Encounter/e1",
  ]);
});

test("structure refinement refuses non-OCT Media before any patch or Provenance write", async () => {
  const harness = deps("clinician", [image("fundus-1", "2026-07-12T10:00:00.000Z", "fundus-photo")]);
  const result = await handleImagingStructureRefinementRequest(harness.deps, {
    authHeader: AUTH,
    mediaId: "fundus-1",
    body: { structure: "Posterior pole", confidence: "clinician-confirmed" },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "Structure refinement is limited to OCT Media." });
  assert.equal(harness.patches.length, 0);
  assert.equal(harness.created.length, 0);
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
    modality: { coding: [{ code: category, display: CATEGORY_DISPLAY[category] }] },
    content: {
      contentType: "image/png",
      title: `${id}.png`,
      url: `https://storage.test/${id}/1?Expires=60&Signature=signed`,
    },
    ...overrides,
  };
}
