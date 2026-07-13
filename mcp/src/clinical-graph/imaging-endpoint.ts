import { createHash } from "node:crypto";
import type { DiagnosticReport, Media, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { osodConcept, reference } from "../fhir/ophthalmology/extensions.js";

export const MANUAL_IMAGING_CONTENT_TYPE = "application/vnd.osod.manual-imaging+json";
export const MAX_MANUAL_IMAGING_BYTES = 15 * 1024 * 1024;

export interface ImagingFhirClient {
  create<T extends Media | DiagnosticReport | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface ImagingEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: ImagingFhirClient;
  } | null>;
  now?: () => string;
}

const WRITE_HEADERS = { "X-OSOD-Source": "mcp/manual_imaging_upload" } as const;
const CATEGORY_DISPLAY = {
  "visual-field": "Visual field",
  "fundus-photo": "Fundus photo",
  "anterior-segment-photo": "Anterior segment photo",
  "referral-scan": "Referral scan",
  "outside-record": "Outside record",
  other: "Other imaging or document",
} as const;
const ACCEPTED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);
const MAX_BASE64_LENGTH = Math.ceil(MAX_MANUAL_IMAGING_BYTES / 3) * 4;

const imagingRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  category: z.enum(["visual-field", "fundus-photo", "anterior-segment-photo", "referral-scan", "outside-record", "other"]),
  interpretation: z.string().trim().max(5000).optional(),
  file: z.object({
    name: z.string().trim().min(1).max(255),
    contentType: z.string().trim().toLowerCase().refine((value) => ACCEPTED_CONTENT_TYPES.has(value), "Unsupported imaging file type."),
    data: z.string().min(4).max(MAX_BASE64_LENGTH).refine(isStrictBase64, "Imaging file data must be base64 encoded."),
  }).strict(),
}).strict();

export async function handleImagingCaptureRequest(
  deps: ImagingEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to upload imaging." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }

  const parsed = imagingRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid imaging upload." } };
  }
  const bytes = Buffer.from(parsed.data.file.data, "base64");
  if (bytes.length > MAX_MANUAL_IMAGING_BYTES) {
    return { status: 400, body: { error: "Imaging files may not exceed 15 MB." } };
  }

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const media = await staff.fhir.create<Media>(buildMedia(parsed.data, staff.staffReference, recordedAt, bytes), WRITE_HEADERS);
  const mediaReference = resourceReference("Media", media.id);
  const interpretation = parsed.data.interpretation?.trim();
  const report = interpretation
    ? await staff.fhir.create<DiagnosticReport>(
        buildDiagnosticReport(
          parsed.data.patientReference,
          parsed.data.encounterReference,
          mediaReference,
          interpretation,
          staff.staffReference,
          recordedAt,
        ),
        WRITE_HEADERS,
      )
    : undefined;
  const reportReference = report ? resourceReference("DiagnosticReport", report.id) : undefined;
  const provenance = await staff.fhir.create<Provenance>({
    resourceType: "Provenance",
    target: [
      reference(mediaReference),
      ...(reportReference ? [reference(reportReference)] : []),
      reference(parsed.data.patientReference),
    ],
    recorded: recordedAt,
    agent: [{ who: reference(staff.staffReference) }],
  }, WRITE_HEADERS);

  return {
    status: 200,
    body: {
      mediaReference,
      ...(reportReference ? { diagnosticReportReference: reportReference } : {}),
      ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
      fileName: parsed.data.file.name,
      category: parsed.data.category,
    },
  };
}

function buildMedia(
  input: z.infer<typeof imagingRequestSchema>,
  staffReference: string,
  recordedAt: string,
  bytes: Buffer,
): Media {
  const document = input.file.contentType === "application/pdf";
  return {
    resourceType: "Media",
    status: "completed",
    type: osodConcept(document ? "document" : "image", document ? "Document" : "Image"),
    modality: osodConcept(input.category, CATEGORY_DISPLAY[input.category]),
    subject: reference(input.patientReference),
    encounter: reference(input.encounterReference),
    createdDateTime: recordedAt,
    issued: recordedAt,
    operator: reference(staffReference),
    content: {
      contentType: input.file.contentType,
      data: input.file.data,
      title: input.file.name,
      size: bytes.length,
      hash: createHash("sha1").update(bytes).digest("base64"),
    },
  };
}

function buildDiagnosticReport(
  patientReference: string,
  encounterReference: string,
  mediaReference: string,
  interpretation: string,
  staffReference: string,
  recordedAt: string,
): DiagnosticReport {
  return {
    resourceType: "DiagnosticReport",
    status: "preliminary",
    code: osodConcept("manual-imaging-interpretation", "Manual imaging interpretation"),
    subject: reference(patientReference),
    encounter: reference(encounterReference),
    effectiveDateTime: recordedAt,
    issued: recordedAt,
    resultsInterpreter: [reference(staffReference)],
    media: [{ link: reference(mediaReference) }],
    conclusion: interpretation,
  };
}

function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function staffMay(role: PracticeRoleId, action: "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function resourceReference(resourceType: "Media" | "DiagnosticReport", id: string | undefined): string {
  if (!id) throw new Error(`${resourceType} create response did not include an id.`);
  return `${resourceType}/${id}`;
}
