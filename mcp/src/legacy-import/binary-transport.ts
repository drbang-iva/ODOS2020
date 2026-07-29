import { createHash } from "node:crypto";
import type { Binary, Media } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import {
  uploadBinary,
  type BinaryUploadAuth,
  type UploadedBinary,
} from "../fhir/binary-upload.js";
import {
  MIGRATION_TAG_CODE,
  MIGRATION_TAG_SYSTEM,
} from "./access-policy.js";
import type {
  BinaryAttempt,
  BinaryAttemptStore,
} from "./binary-attempt-store.js";
import { binaryIdFromReferenceUrl } from "./binary-reference.js";

export const LEGACY_FILE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/legacy-file-name-new";

export interface LegacyMediaSource {
  readonly fileNameNew: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly patientReference: string;
  readonly encounterReference: string;
}

export interface MigrationBinaryUpload {
  readonly attempt: BinaryAttempt;
  readonly binary: UploadedBinary;
}

export interface RecoverLegacyMediaResult {
  readonly action:
    | "created"
    | "recovered-preparation"
    | "skipped-verified"
    | "replaced-corrupt";
  readonly media: Media;
  readonly binaryId: string;
}

export async function uploadMigrationBinary(input: {
  readonly source: LegacyMediaSource;
  readonly mediaId?: string;
  readonly auth: BinaryUploadAuth;
  readonly fhir: Pick<MedplumClient, "update">;
  readonly attempts: BinaryAttemptStore;
}): Promise<MigrationBinaryUpload> {
  assertImportedImageSource(input.source);
  const attempt = await input.attempts.open({
    sourceFilename: input.source.fileNameNew,
    patientReference: input.source.patientReference,
    mediaId: input.mediaId,
  });
  let uploaded: UploadedBinary;
  try {
    uploaded = await uploadBinary({
      bytes: input.source.bytes,
      contentType: input.source.contentType,
      filename: input.source.fileNameNew,
      securityContext: input.source.patientReference,
      auth: input.auth,
    });
  } catch (error) {
    if (provesNoBinaryWasCreated(error)) {
      await input.attempts.resolveNotCreated(
        attempt.attemptId,
        `Medplum rejected the POST before Binary creation (${errorStatus(error)}).`,
      );
    }
    throw error;
  }
  const returnedAttempt = await input.attempts.recordReturned(
    attempt.attemptId,
    uploaded.binaryId,
  );
  const tagged = await tagMigrationBinary(uploaded.resource, input.auth);
  const binary = { ...uploaded, resource: tagged };
  await assertBinaryHash(binary.binaryId, input.source.bytes, input.auth);
  return { attempt: returnedAttempt, binary };
}

export async function recoverLegacyMedia(input: {
  readonly source: LegacyMediaSource;
  readonly auth: BinaryUploadAuth;
  readonly fhir: Pick<MedplumClient, "search" | "create" | "update">;
  readonly attempts: BinaryAttemptStore;
}): Promise<RecoverLegacyMediaResult> {
  assertImportedImageSource(input.source);
  const existing = await findMediaByLegacyIdentifier(input.fhir, input.source.fileNameNew);
  let media: Media;
  let action: RecoverLegacyMediaResult["action"];

  if (!existing) {
    media = await input.fhir.create<Media>(buildPreparationMedia(input.source));
    if (!media.id) throw new Error("Preparation Media create returned no id.");
    action = "created";
  } else if (existing.status === "preparation" && !existing.content.url) {
    media = existing;
    action = "recovered-preparation";
  } else if (existing.status === "completed" && existing.content.url) {
    const verification = await verifyAttachment(existing.content.url, input.source.bytes, input.auth);
    const currentBinaryId = binaryIdFromReferenceUrl(existing.content.url);
    if (verification.matches && currentBinaryId) {
      if (!existing.id) throw new Error("Verified completed Media has no id.");
      await input.attempts.resolveAttachedByBinaryId(currentBinaryId, existing.id);
      return {
        action: "skipped-verified",
        media: existing,
        binaryId: currentBinaryId,
      };
    }
    if (currentBinaryId) {
      await input.attempts.reopenByBinaryId(
        currentBinaryId,
        "Previously attached Binary became unreadable or hash-mismatched and was repointed.",
      );
    }
    media = existing;
    action = "replaced-corrupt";
  } else {
    throw new Error(
      `Media/${existing.id ?? "(unknown)"} has unsupported recovery state ${existing.status} with `
      + `${existing.content.url ? "a" : "no"} content.url.`,
    );
  }

  if (!media.id || !media.meta?.versionId) {
    throw new Error("Recovery Media requires id and meta.versionId for a conditional update.");
  }
  const upload = await uploadMigrationBinary({
    source: input.source,
    mediaId: media.id,
    auth: input.auth,
    fhir: input.fhir,
    attempts: input.attempts,
  });
  const completed = await input.fhir.update<Media>(
    "Media",
    media.id,
    {
      ...media,
      status: "completed",
      content: {
        ...media.content,
        contentType: input.source.contentType,
        title: input.source.fileNameNew,
        url: upload.binary.url,
        data: undefined,
      },
    },
    { "If-Match": `W/"${media.meta.versionId}"` },
  );
  await input.attempts.resolveAttached(
    upload.attempt.attemptId,
    media.id,
    upload.binary.binaryId,
  );
  return {
    action,
    media: completed,
    binaryId: upload.binary.binaryId,
  };
}

export function buildPreparationMedia(source: LegacyMediaSource): Media {
  assertImportedImageSource(source);
  return {
    resourceType: "Media",
    status: "preparation",
    identifier: [{
      system: LEGACY_FILE_IDENTIFIER_SYSTEM,
      value: source.fileNameNew,
    }],
    subject: { reference: source.patientReference },
    encounter: { reference: source.encounterReference },
    content: {
      contentType: source.contentType,
      title: source.fileNameNew,
    },
  };
}

export async function tagMigrationBinary(
  binary: Binary,
  auth: BinaryUploadAuth,
): Promise<Binary> {
  if (!binary.id || !binary.meta?.versionId || !binary.contentType) {
    throw new Error("Migration Binary tagging requires id, meta.versionId, and contentType.");
  }
  const tags = [
    ...(binary.meta.tag ?? []).filter(
      (tag) => tag.system !== MIGRATION_TAG_SYSTEM || tag.code !== MIGRATION_TAG_CODE,
    ),
    { system: MIGRATION_TAG_SYSTEM, code: MIGRATION_TAG_CODE },
  ];
  const resource: Binary = {
    resourceType: "Binary",
    id: binary.id,
    meta: { ...binary.meta, tag: tags },
    contentType: binary.contentType,
    ...(binary.implicitRules ? { implicitRules: binary.implicitRules } : {}),
    ...(binary.language ? { language: binary.language } : {}),
    ...(binary.securityContext ? { securityContext: binary.securityContext } : {}),
  };
  // Binary migration tags use direct transport because fhir-client guards Binary PUTs as parser writes.
  const response = await (auth.fetch ?? fetch)(
    `${auth.baseUrl.replace(/\/$/, "")}/fhir/R4/Binary/${binary.id}`,
    {
      method: "PUT",
      headers: {
        Accept: "application/fhir+json",
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/fhir+json",
        "If-Match": `W/"${binary.meta.versionId}"`,
      },
      body: JSON.stringify(resource),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Migration Binary tag update failed: ${response.status} ${response.statusText}: `
      + `${(await response.text()).slice(0, 2_000)}`,
    );
  }
  return (await response.json()) as Binary;
}

export async function assertBinaryHash(
  binaryId: string,
  expected: Uint8Array,
  auth: BinaryUploadAuth,
): Promise<void> {
  const response = await (auth.fetch ?? fetch)(
    `${auth.baseUrl.replace(/\/$/, "")}/fhir/R4/Binary/${binaryId}`,
    {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${auth.accessToken}`,
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Binary/${binaryId} verification read failed: ${response.status}.`);
  }
  const actual = new Uint8Array(await response.arrayBuffer());
  if (actual.byteLength !== expected.byteLength || hash(actual) !== hash(expected)) {
    throw new Error(`Binary/${binaryId} failed byte-size or SHA-256 verification.`);
  }
}

async function findMediaByLegacyIdentifier(
  fhir: Pick<MedplumClient, "search">,
  fileNameNew: string,
): Promise<Media | undefined> {
  const bundle = await fhir.search<Media>("Media", {
    identifier: `${LEGACY_FILE_IDENTIFIER_SYSTEM}|${fileNameNew}`,
  });
  const matches = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is Media => resource?.resourceType === "Media");
  if (matches.length > 1) {
    throw new Error(`Expected at most one Media for legacy identifier ${fileNameNew}; found ${matches.length}.`);
  }
  return matches[0];
}

async function verifyAttachment(
  url: string,
  expected: Uint8Array,
  auth: BinaryUploadAuth,
): Promise<{ matches: boolean }> {
  const canonicalId = binaryIdFromReferenceUrl(url);
  const baseUrl = new URL(auth.baseUrl);
  if (!canonicalId) return { matches: false };
  let absoluteUrl: URL;
  try {
    absoluteUrl = url.startsWith("Binary/")
      ? new URL(`/fhir/R4/${url}`, baseUrl)
      : new URL(url, baseUrl);
  } catch {
    return { matches: false };
  }
  if (absoluteUrl.origin !== baseUrl.origin) {
    return { matches: false };
  }
  const response = await (auth.fetch ?? fetch)(absoluteUrl.toString(), {
    headers: {
      Accept: "application/octet-stream",
      Authorization: `Bearer ${auth.accessToken}`,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 404 || response.status === 410) {
    return { matches: false };
  }
  if (!response.ok) {
    throw new Error(
      `Attachment verification failed transiently: ${response.status} ${response.statusText}.`,
    );
  }
  const actual = new Uint8Array(await response.arrayBuffer());
  return {
    matches: actual.byteLength === expected.byteLength && hash(actual) === hash(expected),
  };
}

function assertImportedImageSource(source: LegacyMediaSource): void {
  if (!source.fileNameNew.trim()) throw new Error("Legacy image source requires fileNameNew.");
  if (!source.bytes.byteLength) throw new Error("Legacy image source is empty.");
  if (!source.contentType.trim()) throw new Error("Legacy image source requires contentType.");
  if (!/^Patient\/[^/]+$/.test(source.patientReference)) {
    throw new Error("Imported images require a Patient/{id} security anchor.");
  }
  if (!/^Encounter\/[^/]+$/.test(source.encounterReference)) {
    throw new Error("Imported images require an Encounter/{id} reference.");
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function provesNoBinaryWasCreated(error: unknown): boolean {
  const status = errorStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}
