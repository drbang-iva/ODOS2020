import { createHash } from "node:crypto";
import type {
  Bundle,
  CodeableConcept,
  DiagnosticReport,
  Media,
  Provenance,
  QuestionnaireResponse,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { uploadBinary, type BinaryUploadAuth } from "../fhir/binary-upload.js";
import {
  lateralityExtension,
  odosConcept,
  reference,
} from "../fhir/ophthalmology/extensions.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import {
  AESTHETICS_CONSENT_ACKNOWLEDGEMENT_LINK_ID,
  AESTHETICS_COSMETIC_CONSENT_URL,
} from "../fhir/aestheticsConsent.js";
import type { BinaryAttemptStore } from "../legacy-import/binary-attempt-store.js";
import { LEGACY_FILE_IDENTIFIER_SYSTEM } from "../legacy-import/binary-transport.js";
import {
  defaultReferralStorageBaseUrls,
  referralBinaryId,
} from "../referral/referral-service.js";
import type { ClinicalProcedureDefinition } from "./procedure-definition-store.js";

export const MANUAL_IMAGING_CONTENT_TYPE = "application/vnd.odos.manual-imaging+json";
export const LONGITUDINAL_IMAGING_CONTENT_TYPE = "application/vnd.odos.longitudinal-imaging+json";
export const MAX_MANUAL_IMAGING_BYTES = 15 * 1024 * 1024;
export const IMAGING_REFINEMENT_CONFIDENCE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/imaging-structure-refinement-confidence";

export interface ImagingFhirClient {
  read<T extends Media>(resourceType: T["resourceType"], id: string): Promise<T>;
  create<T extends Media | DiagnosticReport | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  search<T extends Media | QuestionnaireResponse>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Media | QuestionnaireResponse>(
    url: string,
    resourceType: T["resourceType"],
  ): Promise<Bundle<T>>;
  executeTransaction(bundle: Bundle, extraHeaders?: Record<string, string>): Promise<Bundle>;
}

export interface ImagingEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: ImagingFhirClient;
    binaryAuth: BinaryUploadAuth;
  } | null>;
  binaryAttempts: BinaryAttemptStore;
  procedureDefinitions?: () => ClinicalProcedureDefinition[];
  storageBaseUrls?: readonly string[];
  now?: () => string;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/manual_imaging_upload" } as const;
const LONGITUDINAL_WRITE_HEADERS = { "X-ODOS-Source": "mcp/longitudinal_imaging" } as const;
const REFINEMENT_WRITE_HEADERS = { "X-ODOS-Source": "mcp/imaging_structure_refinement" } as const;
const MAX_IMAGING_SEARCH_PAGES = 100;
const MAX_MEDIA_IDS_PER_SEARCH = 100;
export const CATEGORY_DISPLAY = {
  "visual-field": "Visual field",
  "fundus-photo": "Fundus photo",
  "anterior-segment-photo": "Anterior segment photo",
  oct: "OCT",
  biometry: "Biometry",
  "referral-scan": "Referral scan",
  "outside-record": "Outside record",
  other: "Other imaging or document",
} as const;
export type ImagingCategory = keyof typeof CATEGORY_DISPLAY;
const IMAGING_CATEGORIES = Object.keys(CATEGORY_DISPLAY) as [
  ImagingCategory,
  ...ImagingCategory[],
];
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
  category: z.enum(IMAGING_CATEGORIES),
  interpretation: z.string().trim().max(5000).optional(),
  file: z.object({
    name: z.string().trim().min(1).max(255),
    contentType: z.string().trim().toLowerCase().refine((value) => ACCEPTED_CONTENT_TYPES.has(value), "Unsupported imaging file type."),
    data: z.string().min(4).max(
      MAX_BASE64_LENGTH,
      "Imaging files may not exceed 15 MB.",
    ).refine(isStrictBase64, "Imaging file data must be base64 encoded."),
  }).strict(),
}).strict();

const longitudinalImageSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/).optional(),
  procedureDefinitionStableKey: z.string().trim().min(1).max(200),
  structure: z.string().trim().min(1).max(120),
  seriesReference: z.string().regex(/^CarePlan\/[^/]+$/).optional(),
  procedureReference: z.string().regex(/^Procedure\/[^/]+$/).optional(),
  file: z.object({
    name: z.string().trim().min(1).max(255),
    contentType: z.string().trim().toLowerCase().refine(
      (value) => value.startsWith("image/") && ACCEPTED_CONTENT_TYPES.has(value),
      "Longitudinal imaging accepts supported image files only.",
    ),
    data: z.string().min(4).max(
      MAX_BASE64_LENGTH,
      "Imaging files may not exceed 15 MB.",
    ).refine(isStrictBase64, "Imaging file data must be base64 encoded."),
  }).strict(),
}).strict();

const longitudinalQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
}).strict();

const imagingListQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/).optional(),
  encounter: z.string().regex(/^Encounter\/[^/]+$/).optional(),
}).strict().refine(
  (value) => Number(Boolean(value.patient)) + Number(Boolean(value.encounter)) === 1,
  "Provide exactly one Patient or Encounter reference.",
);

const imagingRefinementSchema = z.object({
  structure: z.string().trim().min(1).max(120),
  laterality: z.enum(["OD", "OS", "OU", "UNKNOWN"]).optional(),
  confidence: z.enum(["provisional", "clinician-confirmed"]),
}).strict();

export interface ImagingSummary {
  id: string;
  mediaReference: string;
  encounterReference?: string;
  category: ImagingCategory;
  structure?: string;
  laterality?: "OD" | "OS" | "OU" | "UNKNOWN";
  date: string;
  title: string;
  device?: string;
  contentType: string;
  contentUrl?: string;
  contentState: "available" | "missing";
}

export interface LongitudinalImageSummary {
  mediaReference: string;
  createdAt: string;
  title: string;
  contentType: string;
  contentUrl?: string;
  contentState: "available" | "missing";
  structure: string;
  seriesReference?: string;
  procedureReference?: string;
}

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
  const upload = await uploadTrackedBinary(
    deps.binaryAttempts,
    parsed.data.patientReference,
    parsed.data.file.name,
    bytes,
    parsed.data.file.contentType,
    staff.binaryAuth,
  );
  const media = await staff.fhir.create<Media>(
    buildMedia(parsed.data, staff.staffReference, recordedAt, bytes, upload.binary.url),
    WRITE_HEADERS,
  );
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
  await deps.binaryAttempts.resolveAttached(
    upload.attemptId,
    resourceReferenceId(mediaReference),
    upload.binary.binaryId,
  );

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

export async function handleImagingListRequest(
  deps: ImagingEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read imaging." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = imagingListQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "A Patient or Encounter reference is required." },
    };
  }
  const mediaRows = await searchImagingMedia(staff.fhir, {
    ...(parsed.data.patient ? { patient: parsed.data.patient } : {}),
    ...(parsed.data.encounter ? { encounter: parsed.data.encounter } : {}),
    status: "completed",
    _sort: "-created",
    _count: "50",
  });
  const eligibleRows = mediaRows.filter(isImagingReadSurfaceMedia);
  const readableMedia = await readImagingMediaBatch(staff.fhir, eligibleRows);
  const storageBaseUrls = deps.storageBaseUrls ?? defaultReferralStorageBaseUrls();
  const images = readableMedia
    .map((media) => summarizeImagingMedia(media, storageBaseUrls))
    .sort((left, right) => right.date.localeCompare(left.date));
  return {
    status: 200,
    body: {
      images,
      scope: parsed.data.patient
        ? { patient: parsed.data.patient }
        : { encounter: parsed.data.encounter },
      count: images.length,
    },
  };
}

export async function handleImagingStructureRefinementRequest(
  deps: ImagingEndpointDeps,
  input: {
    authHeader: string | undefined;
    mediaId: string | undefined;
    body: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to refine imaging." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  if (!input.mediaId || !/^[A-Za-z0-9.-]+$/.test(input.mediaId)) {
    return { status: 400, body: { error: "A valid Media id is required." } };
  }
  const parsed = imagingRefinementSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid imaging structure refinement." },
    };
  }
  const current = await staff.fhir.read<Media>("Media", input.mediaId);
  if (!current.id || !current.subject?.reference) {
    return { status: 409, body: { error: "Media is missing its patient association." } };
  }
  if (!current.meta?.versionId) {
    return { status: 409, body: { error: "Media is missing the version required for refinement." } };
  }
  if (imagingCategory(current) !== "oct") {
    return { status: 409, body: { error: "Structure refinement is limited to OCT Media." } };
  }
  const bodySite = imagingBodySite(parsed.data.structure, parsed.data.laterality);
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance: Provenance = {
    resourceType: "Provenance",
    meta: {
      tag: [{
        system: IMAGING_REFINEMENT_CONFIDENCE_SYSTEM,
        code: parsed.data.confidence,
        display: parsed.data.confidence === "provisional"
          ? "Provisional imaging structure refinement"
          : "Clinician-confirmed imaging structure refinement",
      }],
    },
    target: [
      reference(`Media/${current.id}`),
      reference(current.subject.reference),
      ...(current.encounter?.reference ? [reference(current.encounter.reference)] : []),
    ],
    recorded: recordedAt,
    activity: odosConcept("imaging-structure-refinement", "Imaging structure refinement"),
    agent: [{ who: reference(staff.staffReference) }],
  };
  const transaction = await staff.fhir.executeTransaction({
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: { ...current, bodySite },
        request: {
          method: "PUT",
          url: `Media/${current.id}`,
          ifMatch: `W/"${current.meta.versionId}"`,
        },
      },
      {
        resource: provenance,
        request: { method: "POST", url: "Provenance" },
      },
    ],
  }, REFINEMENT_WRITE_HEADERS);
  const updated = await staff.fhir.read<Media>("Media", current.id);
  const provenanceId = transactionResourceId(transaction, 1, "Provenance");
  const storageBaseUrls = deps.storageBaseUrls ?? defaultReferralStorageBaseUrls();
  return {
    status: 200,
    body: {
      image: summarizeImagingMedia(updated, storageBaseUrls),
      confidence: parsed.data.confidence,
      ...(provenanceId ? { provenanceReference: `Provenance/${provenanceId}` } : {}),
    },
  };
}

export async function handleLongitudinalImagingCaptureRequest(
  deps: ImagingEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to capture clinical photos." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = longitudinalImageSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid clinical-photo upload." } };
  }
  const definition = deps.procedureDefinitions?.().find((candidate) =>
    candidate.stableKey === parsed.data.procedureDefinitionStableKey && candidate.active
  );
  if (!definition) {
    return { status: 404, body: { error: "Active procedure definition does not exist." } };
  }
  if (!await hasAestheticsConsent(staff.fhir, parsed.data.patientReference)) {
    return { status: 409, body: { error: "Documented cosmetic consent is required before clinical-photo capture." } };
  }
  const bytes = Buffer.from(parsed.data.file.data, "base64");
  if (bytes.length > MAX_MANUAL_IMAGING_BYTES) {
    return { status: 400, body: { error: "Imaging files may not exceed 15 MB." } };
  }
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const upload = await uploadTrackedBinary(
    deps.binaryAttempts,
    parsed.data.patientReference,
    parsed.data.file.name,
    bytes,
    parsed.data.file.contentType,
    staff.binaryAuth,
  );
  const media = await staff.fhir.create<Media>(buildLongitudinalMedia(
    parsed.data,
    staff.staffReference,
    recordedAt,
    bytes,
    upload.binary.url,
  ), LONGITUDINAL_WRITE_HEADERS);
  const mediaReference = resourceReference("Media", media.id);
  const provenance = await staff.fhir.create<Provenance>({
    resourceType: "Provenance",
    target: [reference(mediaReference), reference(parsed.data.patientReference)],
    recorded: recordedAt,
    agent: [{ who: reference(staff.staffReference) }],
  }, LONGITUDINAL_WRITE_HEADERS);
  await deps.binaryAttempts.resolveAttached(
    upload.attemptId,
    resourceReferenceId(mediaReference),
    upload.binary.binaryId,
  );
  const mediaId = resourceReferenceId(mediaReference);
  const readableMedia = await staff.fhir.read<Media>("Media", mediaId);
  const storageBaseUrls = deps.storageBaseUrls ?? defaultReferralStorageBaseUrls();
  return {
    status: 201,
    body: {
      image: summarizeLongitudinalMedia(readableMedia, storageBaseUrls),
      defaultLens: definition.photo_posture,
      ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
    },
  };
}

export async function handleLongitudinalImagingListRequest(
  deps: ImagingEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read clinical photos." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = longitudinalQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: "A valid Patient reference is required." } };
  }
  const bundle = await staff.fhir.search<Media>("Media", {
    patient: parsed.data.patient,
    _sort: "-created",
    _count: "40",
  });
  const candidates = (bundle.entry ?? []).flatMap((entry) => {
    const media = entry.resource;
    if (!media || !isLongitudinalMedia(media)) return [];
    return media.id ? [media.id] : [];
  });
  const images = (await Promise.all(
    candidates.map((id) => staff.fhir.read<Media>("Media", id)),
  )).map((media) =>
    summarizeLongitudinalMedia(
      media,
      deps.storageBaseUrls ?? defaultReferralStorageBaseUrls(),
    )
  );
  return { status: 200, body: { images, suggestedPair: suggestComparisonPair(images) } };
}

export function suggestComparisonPair(
  images: readonly LongitudinalImageSummary[],
): [string, string] | undefined {
  for (let currentIndex = 0; currentIndex < images.length; currentIndex += 1) {
    const current = images[currentIndex]!;
    if (!current.seriesReference) continue;
    const baseline = images.slice(currentIndex + 1).find((candidate) =>
      candidate.seriesReference === current.seriesReference && candidate.structure === current.structure
    );
    if (baseline) return [baseline.mediaReference, current.mediaReference];
  }
  return images.length >= 2
    ? [images[images.length - 1]!.mediaReference, images[0]!.mediaReference]
    : undefined;
}

function buildMedia(
  input: z.infer<typeof imagingRequestSchema>,
  staffReference: string,
  recordedAt: string,
  bytes: Buffer,
  contentUrl: string,
): Media {
  const document = input.file.contentType === "application/pdf";
  return {
    resourceType: "Media",
    status: "completed",
    type: odosConcept(document ? "document" : "image", document ? "Document" : "Image"),
    modality: odosConcept(input.category, CATEGORY_DISPLAY[input.category]),
    subject: reference(input.patientReference),
    encounter: reference(input.encounterReference),
    createdDateTime: recordedAt,
    issued: recordedAt,
    operator: reference(staffReference),
    content: {
      contentType: input.file.contentType,
      url: contentUrl,
      title: input.file.name,
      size: bytes.length,
      hash: createHash("sha1").update(bytes).digest("base64"),
    },
  };
}

function buildLongitudinalMedia(
  input: z.infer<typeof longitudinalImageSchema>,
  staffReference: string,
  recordedAt: string,
  bytes: Buffer,
  contentUrl: string,
): Media {
  return {
    resourceType: "Media",
    status: "completed",
    type: odosConcept("image", "Image"),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    ...(input.seriesReference ? { basedOn: [reference(input.seriesReference)] } : {}),
    ...(input.procedureReference ? { partOf: [reference(input.procedureReference)] } : {}),
    bodySite: { text: input.structure },
    createdDateTime: recordedAt,
    issued: recordedAt,
    operator: reference(staffReference),
    note: [{ text: `Procedure definition: ${input.procedureDefinitionStableKey}` }],
    content: {
      contentType: input.file.contentType,
      url: contentUrl,
      title: input.file.name,
      size: bytes.length,
      hash: createHash("sha1").update(bytes).digest("base64"),
    },
  };
}

export function summarizeImagingMedia(
  media: Media,
  storageBaseUrls: readonly string[] = defaultReferralStorageBaseUrls(),
): ImagingSummary {
  if (!media.id) throw new Error("Imaging Media is missing its id.");
  const contentUrl = attachmentContentUrl(media, storageBaseUrls);
  return {
    id: media.id,
    mediaReference: `Media/${media.id}`,
    ...(media.encounter?.reference ? { encounterReference: media.encounter.reference } : {}),
    category: imagingCategory(media),
    ...(imagingStructure(media.bodySite) ? { structure: imagingStructure(media.bodySite) } : {}),
    ...(imagingLaterality(media.bodySite) ? { laterality: imagingLaterality(media.bodySite) } : {}),
    date: media.createdDateTime ?? media.issued ?? media.meta?.lastUpdated ?? "",
    title: media.content.title ?? CATEGORY_DISPLAY[imagingCategory(media)],
    ...(media.deviceName?.trim() ? { device: media.deviceName.trim() } : {}),
    contentType: media.content.contentType ?? "application/octet-stream",
    ...(contentUrl ? { contentUrl } : {}),
    contentState: contentUrl ? "available" : "missing",
  };
}

function imagingBodySite(
  structure: string,
  laterality: "OD" | "OS" | "OU" | "UNKNOWN" | undefined,
): CodeableConcept {
  return {
    text: structure,
    ...(laterality ? { extension: [lateralityExtension(laterality)] } : {}),
  };
}

function imagingCategory(media: Media): ImagingCategory {
  const code = media.modality?.coding?.find((coding) =>
    coding.code && coding.code in CATEGORY_DISPLAY
  )?.code;
  return code && code in CATEGORY_DISPLAY ? code as ImagingCategory : "other";
}

function imagingStructure(bodySite: CodeableConcept | undefined): string | undefined {
  return bodySite?.text?.trim()
    || bodySite?.coding?.find((coding) =>
      coding.code && !["OD", "OS", "OU", "UNKNOWN"].includes(coding.code)
    )?.display?.trim()
    || bodySite?.coding?.find((coding) =>
      coding.code && !["OD", "OS", "OU", "UNKNOWN"].includes(coding.code)
    )?.code?.trim();
}

function imagingLaterality(
  bodySite: CodeableConcept | undefined,
): "OD" | "OS" | "OU" | "UNKNOWN" | undefined {
  const code = [
    ...(bodySite?.extension ?? []).flatMap((extension) =>
      extension.valueCodeableConcept?.coding?.flatMap((coding) => coding.code ?? []) ?? []
    ),
    ...(bodySite?.coding ?? []).flatMap((coding) => coding.code ?? []),
  ].find((candidate) => ["OD", "OS", "OU", "UNKNOWN"].includes(candidate));
  return code as "OD" | "OS" | "OU" | "UNKNOWN" | undefined;
}

function attachmentContentUrl(
  media: Media,
  storageBaseUrls: readonly string[],
): string | undefined {
  if (media.content.data && media.content.contentType) {
    return `data:${media.content.contentType};base64,${media.content.data}`;
  }
  const url = media.content.url?.trim();
  if (!url || url.startsWith("Binary/")) return undefined;
  try {
    new URL(url);
  } catch {
    return undefined;
  }
  if (!referralBinaryId(url, storageBaseUrls)) return undefined;
  return url;
}

async function searchImagingMedia(
  fhir: ImagingFhirClient,
  params: Record<string, string>,
): Promise<Media[]> {
  const rows: Media[] = [];
  const seenNextUrls = new Set<string>();
  let pageCount = 1;
  let bundle = await fhir.search<Media>("Media", params);
  while (true) {
    rows.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
    const nextUrl = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!nextUrl) return rows;
    if (pageCount >= MAX_IMAGING_SEARCH_PAGES) {
      throw new Error(`Imaging search exceeded ${MAX_IMAGING_SEARCH_PAGES} pages.`);
    }
    if (!fhir.searchUrl) throw new Error("Imaging FHIR client cannot follow search pagination.");
    if (seenNextUrls.has(nextUrl)) throw new Error("Imaging search returned a pagination cycle.");
    seenNextUrls.add(nextUrl);
    bundle = await fhir.searchUrl<Media>(nextUrl, "Media");
    pageCount += 1;
  }
}

async function readImagingMediaBatch(
  fhir: ImagingFhirClient,
  mediaRows: readonly Media[],
): Promise<Media[]> {
  const orderedIds = mediaRows.flatMap((media) => media.id ? [media.id] : []);
  const canonicalById = new Map<string, Media>();
  for (let offset = 0; offset < orderedIds.length; offset += MAX_MEDIA_IDS_PER_SEARCH) {
    const ids = orderedIds.slice(offset, offset + MAX_MEDIA_IDS_PER_SEARCH);
    const canonicalRows = await searchImagingMedia(fhir, {
      _id: ids.join(","),
      _count: String(MAX_MEDIA_IDS_PER_SEARCH),
    });
    for (const media of canonicalRows) {
      if (media.id && ids.includes(media.id)) canonicalById.set(media.id, media);
    }
  }
  return orderedIds.flatMap((id) => canonicalById.get(id) ?? []);
}

function isImagingReadSurfaceMedia(media: Media): boolean {
  if (isLongitudinalMedia(media)) return false;
  const codedImaging = media.modality?.coding?.some((coding) =>
    coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM
    && coding.code !== undefined
    && coding.code in CATEGORY_DISPLAY
  );
  const migratedImaging = media.identifier?.some(
    (identifier) => identifier.system === LEGACY_FILE_IDENTIFIER_SYSTEM,
  );
  return Boolean(codedImaging || migratedImaging);
}

function isLongitudinalMedia(media: Media): boolean {
  return Boolean(
    media.id &&
    media.content.contentType?.startsWith("image/") &&
    (media.content.data || media.content.url) &&
    media.bodySite?.text &&
    media.note?.some((note) => note.text?.startsWith("Procedure definition: "))
  );
}

function summarizeLongitudinalMedia(
  media: Media,
  storageBaseUrls: readonly string[],
): LongitudinalImageSummary {
  if (!media.id || !media.content.contentType || !media.bodySite?.text) {
    throw new Error("Longitudinal Media is missing required display data.");
  }
  const contentUrl = attachmentContentUrl(media, storageBaseUrls);
  return {
    mediaReference: `Media/${media.id}`,
    createdAt: media.createdDateTime ?? media.issued ?? media.meta?.lastUpdated ?? "",
    title: media.content.title ?? "Clinical photo",
    contentType: media.content.contentType,
    ...(contentUrl ? { contentUrl } : {}),
    contentState: contentUrl ? "available" : "missing",
    structure: media.bodySite.text,
    ...(media.basedOn?.[0]?.reference ? { seriesReference: media.basedOn[0].reference } : {}),
    ...(media.partOf?.[0]?.reference ? { procedureReference: media.partOf[0].reference } : {}),
  };
}

async function uploadTrackedBinary(
  attempts: BinaryAttemptStore,
  patientReference: string,
  sourceFilename: string,
  bytes: Uint8Array,
  contentType: string,
  auth: BinaryUploadAuth,
): Promise<{ attemptId: string; binary: Awaited<ReturnType<typeof uploadBinary>> }> {
  const attempt = await attempts.open({ sourceFilename, patientReference });
  const binary = await uploadBinary({
    bytes,
    contentType,
    filename: sourceFilename,
    securityContext: patientReference,
    auth,
  });
  await attempts.recordReturned(attempt.attemptId, binary.binaryId);
  return { attemptId: attempt.attemptId, binary };
}

function transactionResourceId(
  bundle: Bundle,
  entryIndex: number,
  resourceType: string,
): string | undefined {
  const entry = bundle.entry?.[entryIndex];
  if (entry?.resource?.resourceType === resourceType && entry.resource.id) return entry.resource.id;
  return entry?.response?.location?.match(new RegExp(`^${resourceType}/([^/]+)`))?.[1];
}

async function hasAestheticsConsent(
  fhir: ImagingFhirClient,
  patientReference: string,
): Promise<boolean> {
  const bundle = await fhir.search<QuestionnaireResponse>("QuestionnaireResponse", {
    patient: patientReference,
    status: "completed",
    _sort: "-authored",
    _count: "20",
  });
  return (bundle.entry ?? []).some((entry) => {
    const response = entry.resource;
    return response?.status === "completed" &&
      response.subject?.reference === patientReference &&
      response.questionnaire?.split("|")[0] === AESTHETICS_COSMETIC_CONSENT_URL &&
      response.item?.some((item) =>
        item.linkId === AESTHETICS_CONSENT_ACKNOWLEDGEMENT_LINK_ID &&
        item.answer?.some((answer) => answer.valueBoolean === true)
      );
  });
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
    code: odosConcept("manual-imaging-interpretation", "Manual imaging interpretation"),
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

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
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

function resourceReferenceId(value: string): string {
  const [, id, extra] = value.split("/");
  if (!id || extra) throw new Error(`Invalid FHIR reference: ${value}`);
  return id;
}
