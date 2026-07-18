import { createHash } from "node:crypto";
import type {
  Bundle,
  CarePlan,
  Encounter,
  Media,
  Provenance,
  QuestionnaireResponse,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { odosConcept, reference } from "../fhir/ophthalmology/extensions.js";
import { findClinicalPhotographyConsent } from "./aesthetics-consent-endpoint.js";
import type { ClinicalProcedureDefinition } from "./procedure-definition-store.js";

export const LONGITUDINAL_IMAGING_CONTENT_TYPE =
  "application/vnd.odos.longitudinal-imaging+json";
export const MAX_LONGITUDINAL_IMAGE_BYTES = 15 * 1024 * 1024;

const LONGITUDINAL_PHOTO_CODE = "longitudinal-clinical-photo";
const WRITE_HEADERS = { "X-ODOS-Source": "mcp/longitudinal_imaging" } as const;
const ACCEPTED_CONTENT_TYPES = new Set(["image/heic", "image/jpeg", "image/png"]);
const MAX_BASE64_LENGTH = Math.ceil(MAX_LONGITUDINAL_IMAGE_BYTES / 3) * 4;

export interface LongitudinalImagingFhirClient {
  create<T extends Media | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  read<T extends CarePlan | Encounter>(
    resourceType: T["resourceType"],
    id: string,
  ): Promise<T>;
  search<T extends CarePlan | Media | QuestionnaireResponse>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface LongitudinalImagingEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: LongitudinalImagingFhirClient;
  } | null>;
  procedureDefinitions?: () => ClinicalProcedureDefinition[];
  now?: () => string;
}

export interface LongitudinalPhotoSummary {
  mediaReference: string;
  recordedAt: string;
  title: string;
  contentType: string;
  dataUrl: string;
  structure: string;
  encounterReference?: string;
  seriesReference?: string;
}

export interface SuggestedPhotoPair {
  first: string;
  second: string;
  source: "series" | "recent";
  seriesReference?: string;
}

const captureSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  structure: z.string().trim().min(1).max(120),
  procedureDefinitionStableKey: z.string().trim().min(1).max(200).optional(),
  seriesReference: z.string().regex(/^CarePlan\/[^/]+$/).optional(),
  source: z.enum(["camera", "device-import"]),
  deviceName: z.string().trim().min(1).max(120).optional(),
  file: z.object({
    name: z.string().trim().min(1).max(255),
    contentType: z.string().trim().toLowerCase().refine(
      (value) => ACCEPTED_CONTENT_TYPES.has(value),
      "Longitudinal imaging accepts JPEG, PNG, or HEIC files only.",
    ),
    data: z.string().min(4).max(MAX_BASE64_LENGTH).refine(
      isStrictBase64,
      "Image data must be base64 encoded.",
    ),
  }).strict(),
}).strict();

const listSchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
  structure: z.string().trim().min(1).max(120).optional(),
  procedureDefinitionStableKey: z.string().trim().min(1).max(200).optional(),
}).strict();

export async function handleLongitudinalImagingCaptureRequest(
  deps: LongitudinalImagingEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to capture clinical photos." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = captureSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid clinical-photo upload." } };
  }
  const consent = await findClinicalPhotographyConsent(staff.fhir, parsed.data.patientReference);
  if (!consent) {
    return { status: 412, body: { error: "Documented clinical photography consent is required before capture or import." } };
  }
  const definition = findDefinition(deps, parsed.data.procedureDefinitionStableKey);
  if (parsed.data.procedureDefinitionStableKey && !definition) {
    return { status: 404, body: { error: "Active procedure definition does not exist." } };
  }
  const encounterError = await validateEncounterPatient(
    staff.fhir,
    parsed.data.encounterReference,
    parsed.data.patientReference,
  );
  if (encounterError) return { status: 422, body: { error: encounterError } };
  const series = parsed.data.seriesReference
    ? await resolveSeriesReference(staff.fhir, parsed.data.seriesReference, parsed.data.patientReference)
    : { reference: await findMatchingSeriesReference(staff.fhir, parsed.data.patientReference, definition) };
  if (series.error) return { status: 422, body: { error: series.error } };
  const bytes = Buffer.from(parsed.data.file.data, "base64");
  if (bytes.length > MAX_LONGITUDINAL_IMAGE_BYTES) {
    return { status: 400, body: { error: "Clinical image files may not exceed 15 MB." } };
  }
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const media = await staff.fhir.create<Media>(buildLongitudinalMedia({
    ...parsed.data,
    seriesReference: series.reference,
    staffReference: staff.staffReference,
    recordedAt,
    bytes,
  }), WRITE_HEADERS);
  const mediaReference = resourceReference(media);
  const provenance = await staff.fhir.create<Provenance>({
    resourceType: "Provenance",
    target: [reference(mediaReference), reference(parsed.data.patientReference)],
    recorded: recordedAt,
    agent: [{ who: reference(staff.staffReference) }],
  }, WRITE_HEADERS);
  return {
    status: 201,
    body: {
      photo: summarizeLongitudinalMedia(media),
      defaultLens: lensForDefinition(definition),
      seriesLinked: Boolean(series.reference),
      ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
    },
  };
}

export async function handleLongitudinalImagingListRequest(
  deps: LongitudinalImagingEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read clinical photos." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = listSchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "A valid Patient reference is required." } };
  }
  const definition = findDefinition(deps, parsed.data.procedureDefinitionStableKey);
  if (parsed.data.procedureDefinitionStableKey && !definition) {
    return { status: 404, body: { error: "Active procedure definition does not exist." } };
  }
  const bundle = await staff.fhir.search<Media>("Media", {
    patient: parsed.data.patient,
    _sort: "created",
    _count: "200",
  });
  const photos = (bundle.entry ?? []).flatMap((entry) => {
    const media = entry.resource;
    if (!media || !isLongitudinalMedia(media)) return [];
    const summary = summarizeLongitudinalMedia(media);
    if (parsed.data.structure && normalizeStructure(summary.structure) !== normalizeStructure(parsed.data.structure)) {
      return [];
    }
    return [summary];
  }).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  return {
    status: 200,
    body: {
      photos,
      suggestedPair: suggestComparisonPair(photos),
      defaultLens: lensForDefinition(definition),
    },
  };
}

export function suggestComparisonPair(
  photos: readonly LongitudinalPhotoSummary[],
): SuggestedPhotoPair | undefined {
  const seriesGroups = new Map<string, LongitudinalPhotoSummary[]>();
  for (const photo of photos) {
    if (!photo.seriesReference) continue;
    const key = `${photo.seriesReference}\u0000${normalizeStructure(photo.structure)}`;
    seriesGroups.set(key, [...(seriesGroups.get(key) ?? []), photo]);
  }
  const series = [...seriesGroups.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => right[right.length - 1]!.recordedAt.localeCompare(left[left.length - 1]!.recordedAt))[0];
  if (series) {
    return {
      first: series[0]!.mediaReference,
      second: series[series.length - 1]!.mediaReference,
      source: "series",
      seriesReference: series[0]!.seriesReference,
    };
  }
  const latest = photos[photos.length - 1];
  if (!latest) return undefined;
  const sameStructure = photos.filter((photo) =>
    normalizeStructure(photo.structure) === normalizeStructure(latest.structure)
  );
  if (sameStructure.length < 2) return undefined;
  return {
    first: sameStructure[sameStructure.length - 2]!.mediaReference,
    second: sameStructure[sameStructure.length - 1]!.mediaReference,
    source: "recent",
  };
}

function buildLongitudinalMedia(
  input: z.infer<typeof captureSchema> & {
    staffReference: string;
    recordedAt: string;
    bytes: Buffer;
  },
): Media {
  return {
    resourceType: "Media",
    status: "completed",
    type: odosConcept("image", "Image"),
    modality: odosConcept(LONGITUDINAL_PHOTO_CODE, "Longitudinal clinical photo"),
    subject: reference(input.patientReference),
    encounter: reference(input.encounterReference),
    ...(input.seriesReference ? { basedOn: [reference(input.seriesReference)] } : {}),
    bodySite: { text: input.structure },
    createdDateTime: input.recordedAt,
    issued: input.recordedAt,
    operator: reference(input.staffReference),
    deviceName: input.deviceName ?? (input.source === "camera" ? "In-chart camera" : "Imported image file"),
    content: {
      contentType: input.file.contentType,
      data: input.file.data,
      title: input.file.name,
      size: input.bytes.length,
      hash: createHash("sha1").update(input.bytes).digest("base64"),
    },
  };
}

function isLongitudinalMedia(media: Media): boolean {
  return Boolean(
    media.id &&
    media.modality?.coding?.some((coding) => coding.code === LONGITUDINAL_PHOTO_CODE) &&
    media.bodySite?.text &&
    media.content.data &&
    media.content.contentType &&
    ACCEPTED_CONTENT_TYPES.has(media.content.contentType)
  );
}

function summarizeLongitudinalMedia(media: Media): LongitudinalPhotoSummary {
  if (!media.id || !media.bodySite?.text || !media.content.data || !media.content.contentType) {
    throw new Error("Longitudinal Media is missing required display data.");
  }
  return {
    mediaReference: `Media/${media.id}`,
    recordedAt: media.createdDateTime ?? media.issued ?? media.meta?.lastUpdated ?? "",
    title: media.content.title ?? "Clinical photo",
    contentType: media.content.contentType,
    dataUrl: `data:${media.content.contentType};base64,${media.content.data}`,
    structure: media.bodySite.text,
    ...(media.encounter?.reference ? { encounterReference: media.encounter.reference } : {}),
    ...(media.basedOn?.[0]?.reference ? { seriesReference: media.basedOn[0].reference } : {}),
  };
}

function findDefinition(
  deps: LongitudinalImagingEndpointDeps,
  stableKey: string | undefined,
): ClinicalProcedureDefinition | undefined {
  if (!stableKey) return undefined;
  return deps.procedureDefinitions?.().find((candidate) =>
    candidate.active && candidate.stableKey === stableKey
  );
}

function lensForDefinition(definition: ClinicalProcedureDefinition | undefined): "timeline" | "compare" {
  return definition?.photo_posture === "showcase" ? "compare" : "timeline";
}

async function validateEncounterPatient(
  fhir: LongitudinalImagingFhirClient,
  encounterReference: string,
  patientReference: string,
): Promise<string | undefined> {
  try {
    const encounter = await fhir.read<Encounter>("Encounter", encounterReference.slice("Encounter/".length));
    return encounter.subject?.reference === patientReference
      ? undefined
      : `${encounterReference} does not belong to ${patientReference}.`;
  } catch {
    return `Unable to validate ${encounterReference} because the Encounter could not be read.`;
  }
}

async function resolveSeriesReference(
  fhir: LongitudinalImagingFhirClient,
  seriesReference: string,
  patientReference: string,
): Promise<{ reference?: string; error?: string }> {
  let carePlan: CarePlan;
  try {
    carePlan = await fhir.read<CarePlan>("CarePlan", seriesReference.slice("CarePlan/".length));
  } catch {
    return {};
  }
  return carePlan.subject?.reference === patientReference
    ? { reference: seriesReference }
    : { error: `${seriesReference} does not belong to ${patientReference}.` };
}

async function findMatchingSeriesReference(
  fhir: LongitudinalImagingFhirClient,
  patientReference: string,
  definition: ClinicalProcedureDefinition | undefined,
): Promise<string | undefined> {
  const bundle = await fhir.search<CarePlan>("CarePlan", {
    subject: patientReference,
    status: "active",
    _count: "200",
  });
  const procedureCode = definition ? procedureDefinitionCode(definition) : undefined;
  const candidates = (bundle.entry ?? []).flatMap((entry) => {
    const carePlan = entry.resource;
    if (
      !carePlan?.id ||
      carePlan.status !== "active" ||
      carePlan.subject?.reference !== patientReference ||
      !carePlan.instantiatesCanonical?.some((canonical) => canonical.includes("/PlanDefinition/series-protocol-"))
    ) return [];
    if (procedureCode && !carePlan.activity?.some((activity) =>
      activity.detail?.code?.coding?.some((coding) => coding.code === procedureCode)
    )) return [];
    return [`CarePlan/${carePlan.id}`];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function procedureDefinitionCode(definition: ClinicalProcedureDefinition): string | undefined {
  const code = definition.fhirProcedureCode;
  if ("system" in code && "code" in code) return code.code;
  return code.coding?.find((coding) => coding.code)?.code;
}

function normalizeStructure(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function resourceReference(media: Media): string {
  if (!media.id) throw new Error("Media create response did not include an id.");
  return `Media/${media.id}`;
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
