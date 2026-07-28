import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiagnosticReport, Media, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleImagingCaptureRequest,
  MAX_MANUAL_IMAGING_BYTES,
  type ImagingEndpointDeps,
} from "../src/clinical-graph/imaging-endpoint.js";

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

function deps(role: PracticeRoleId = "clinician") {
  const created: Array<{ resource: Media | DiagnosticReport | Provenance; headers?: Record<string, string> }> = [];
  const value: ImagingEndpointDeps = {
    authenticate: async (authHeader) => authHeader === AUTH
      ? {
          staffReference: "Practitioner/doc1",
          actorRole: role,
          fhir: {
            create: async <T extends Media | DiagnosticReport | Provenance>(
              resource: T,
              headers?: Record<string, string>,
            ): Promise<T> => {
              created.push({ resource, headers });
              return { ...resource, id: `${resource.resourceType.toLowerCase()}-${created.length}` };
            },
          },
        }
      : null,
    now: () => "2026-07-13T18:00:00.000Z",
  };
  return { created, deps: value };
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
  assert.deepEqual(oversized.body, { error: "Imaging files may not exceed 1 MB." });
});
