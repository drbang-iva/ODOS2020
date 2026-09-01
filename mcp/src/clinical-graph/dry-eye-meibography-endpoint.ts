import type {
  Bundle,
  DocumentReference,
  Observation,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import {
  OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL,
} from "../fhir/contactLens.js";
import {
  buildMeibographyObservation,
  MEIBOGRAPHY_LIDS,
  MEIBOGRAPHY_SCORE_SYSTEMS,
} from "../fhir/meibography.js";
import { reference } from "../fhir/ophthalmology/extensions.js";
import { buildDocumentReference } from "../fhir/ophthalmology/rawAssets.js";

export interface DryEyeMeibographyFhirClient {
  create<T extends DocumentReference | Observation | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface DryEyeMeibographyEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: DryEyeMeibographyFhirClient;
  } | null>;
  now?: () => string;
}

const WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/create_meibography_observation",
} as const;
const MAX_IMAGE_BYTES = 1 * 1024 * 1024;
const MAX_IMAGE_BASE64_LENGTH = Math.ceil((1 * 1024 * 1024) / 3) * 4;

const captureSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  eye: z.enum(["OD", "OS"]),
  lid: z.enum(MEIBOGRAPHY_LIDS),
  scoringSystem: z.enum(MEIBOGRAPHY_SCORE_SYSTEMS),
  totalScore: z.number().int(),
  glandScores: z.array(z.number().int()).optional(),
  file: z.object({
    name: z.string().trim().min(1).max(255),
    contentType: z.string().trim().toLowerCase().refine(
      (value) => value.startsWith("image/"),
      "Meibography capture requires an image file.",
    ),
    data: z.string().min(4).max(MAX_IMAGE_BASE64_LENGTH).refine(
      isStrictBase64,
      "Meibography image data must be base64 encoded.",
    ),
  }).strict(),
}).strict();

const listSchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
}).strict();

const imageSchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
  document: z.string().regex(/^DocumentReference\/[^/]+$/),
}).strict();

export async function handleDryEyeMeibographyCaptureRequest(
  deps: DryEyeMeibographyEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to capture meibography." } };
  }
  if (!staffHasBusinessAction(staff, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = captureSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid meibography capture." },
    };
  }
  if (Buffer.from(parsed.data.file.data, "base64").byteLength > MAX_IMAGE_BYTES) {
    return { status: 400, body: { error: "Meibography images may not exceed 1 MB." } };
  }
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  let documentReferenceInput: DocumentReference;
  let observationInput: Observation;
  try {
    documentReferenceInput = buildDocumentReference({
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      contentType: parsed.data.file.contentType,
      data: parsed.data.file.data,
      title: parsed.data.file.name,
      categoryCode: "MEIBOGRAPHY_IMAGE",
      typeCode: "MEIBOGRAPHY_IMAGE",
      creation: recordedAt,
    });
    observationInput = buildMeibographyObservation({
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      documentReference: "DocumentReference/pending",
      eye: parsed.data.eye,
      lid: parsed.data.lid,
      scoringSystem: parsed.data.scoringSystem,
      totalScore: parsed.data.totalScore,
      glandScores: parsed.data.glandScores,
      effectiveDateTime: recordedAt,
    });
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
  try {
    const documentReference = await staff.fhir.create<DocumentReference>(
      documentReferenceInput,
      WRITE_HEADERS,
    );
    const documentReferenceId = requiredId(documentReference, "DocumentReference");
    const observation = await staff.fhir.create<Observation>(
      {
        ...observationInput,
        derivedFrom: [reference(`DocumentReference/${documentReferenceId}`)],
      },
      WRITE_HEADERS,
    );
    const observationId = requiredId(observation, "Observation");
    const provenance = await staff.fhir.create<Provenance>({
      resourceType: "Provenance",
      target: [
        reference(`DocumentReference/${documentReferenceId}`),
        reference(`Observation/${observationId}`),
        reference(parsed.data.patientReference),
      ],
      recorded: recordedAt,
      agent: [{ who: reference(staff.staffReference) }],
      activity: {
        text: "create_meibography_observation",
      },
    }, WRITE_HEADERS);
    return {
      status: 201,
      body: {
        documentReference,
        observation,
        ...(provenance.id
          ? { provenanceReference: `Provenance/${provenance.id}` }
          : {}),
      },
    };
  } catch (error) {
    console.error("odos-mcp: meibography persistence failed:", error);
    return {
      status: 502,
      body: {
        error: "Meibography persistence failed.",
      },
    };
  }
}

export async function handleDryEyeMeibographyListRequest(
  deps: DryEyeMeibographyEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read meibography." } };
  }
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = listSchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: "A valid Patient reference is required." } };
  }
  const bundle = await staff.fhir.search<Observation>("Observation", {
    subject: parsed.data.patient,
    _sort: "-date",
    _count: "100",
  });
  const observations = (bundle.entry ?? []).flatMap((entry) => {
    const observation = entry.resource;
    return observation?.meta?.profile?.includes(
      OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL,
    )
      ? [observation]
      : [];
  });
  const rows = await Promise.all(observations.map(async (observation) => {
    const documentReference = observation.derivedFrom?.[0]?.reference;
    const id = documentReference?.startsWith("DocumentReference/")
      ? documentReference.slice("DocumentReference/".length)
      : undefined;
    let document: DocumentReference | undefined;
    if (id) {
      try {
        document = await staff.fhir.read<DocumentReference>("DocumentReference", id);
      } catch {
        document = undefined;
      }
    }
    const attachment = document?.content?.[0]?.attachment;
    return {
      observationReference: observation.id
        ? `Observation/${observation.id}`
        : undefined,
      documentReference,
      recordedAt: observation.effectiveDateTime ?? "",
      eye: observation.bodySite?.coding?.find((coding) => coding.code)?.code,
      lid: observation.bodySite?.text?.split(" ").at(-2),
      score: observation.valueInteger,
      scoringSystem: observation.code.coding?.[0]?.code?.startsWith("arita")
        ? "arita"
        : "meiboscore",
      contentType: attachment?.contentType,
      title: attachment?.title,
      size: attachment?.size,
      ...(documentReference && document
        ? {
            imageUrl: meibographyImageUrl(
              parsed.data.patient,
              documentReference,
            ),
          }
        : { imageUnavailable: true }),
    };
  }));
  return { status: 200, body: { rows } };
}

export async function handleDryEyeMeibographyImageRequest(
  deps: DryEyeMeibographyEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read meibography." } };
  }
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = imageSchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: "Valid Patient and DocumentReference values are required." } };
  }
  const id = parsed.data.document.slice("DocumentReference/".length);
  try {
    const document = await staff.fhir.read<DocumentReference>("DocumentReference", id);
    if (document.subject?.reference !== parsed.data.patient) {
      return { status: 404, body: { error: "Meibography image not found." } };
    }
    const attachment = document.content?.[0]?.attachment;
    if (!attachment?.data || !attachment.contentType) {
      return { status: 404, body: { error: "Meibography image data not found." } };
    }
    return {
      status: 200,
      body: {
        contentType: attachment.contentType,
        data: attachment.data,
        title: attachment.title,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|404/i.test(message)) {
      return { status: 404, body: { error: "Meibography image not found." } };
    }
    console.error("odos-mcp: meibography image read failed:", error);
    return { status: 502, body: { error: "Meibography image read failed." } };
  }
}

function requiredId(resource: Resource, resourceType: string): string {
  if (!resource.id) throw new Error(`${resourceType} create response did not include an id.`);
  return resource.id;
}

function meibographyImageUrl(
  patientReference: string,
  documentReference: string,
): string {
  return `/clinical-graph/dry-eye/meibography/image?${
    new URLSearchParams({
      patient: patientReference,
      document: documentReference,
    })
  }`;
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
