#!/usr/bin/env tsx
import { setTimeout as wait } from "node:timers/promises";
import type { Media } from "@medplum/fhirtypes";
import { exchangeClientCredentials } from "../../data/medplum-adapters/migration-importer-adapter.js";
import { createOperatorScriptFhirClient } from "../../mcp/src/fhir-client.js";
import { PgBinaryAttemptStore } from "../../mcp/src/legacy-import/binary-attempt-store.js";
import {
  buildPreparationMedia,
  uploadMigrationBinary,
  type LegacyMediaSource,
} from "../../mcp/src/legacy-import/binary-transport.js";

const [fileNameNew, patientReference, encounterReference] = process.argv.slice(2);
if (!fileNameNew || !patientReference || !encounterReference) {
  throw new Error("Crash worker requires filename, Patient reference, and Encounter reference.");
}
const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
assertLocalBaseUrl(baseUrl);
const postgresUrl =
  process.env.ODOS_POSTGRES_URL
  ?? process.env.OSOD_POSTGRES_URL
  ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const accessToken = await exchangeClientCredentials({
  baseUrl,
  clientId: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
  clientSecret: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
});
const auth = { baseUrl, accessToken };
const fhir = createOperatorScriptFhirClient({
  ...auth,
  reason: "Legacy import crash fixture runs outside request handling.",
});
const attempts = new PgBinaryAttemptStore({ postgresUrl });
const source: LegacyMediaSource = {
  fileNameNew,
  patientReference,
  encounterReference,
  contentType: "image/jpeg",
  bytes: crashBytes(fileNameNew),
};
let media: Media;
let upload: Awaited<ReturnType<typeof uploadMigrationBinary>>;
try {
  media = await fhir.create<Media>(buildPreparationMedia(source));
  if (!media.id) throw new Error("Crash worker preparation Media has no id.");
  upload = await uploadMigrationBinary({
    source,
    mediaId: media.id,
    auth,
    fhir,
    attempts,
  });
} catch (error) {
  await attempts.close();
  throw error;
}
process.stdout.write(JSON.stringify({
  phase: "post-response-pre-media-update",
  mediaId: media.id,
  attemptId: upload.attempt.attemptId,
  binaryId: upload.binary.binaryId,
  binaryVersionId: upload.binary.resource.meta?.versionId,
}) + "\n");
await wait(3_600_000);

function crashBytes(seed: string): Uint8Array {
  return new Uint8Array(1024 * 1024 + 4_097).fill(seed.charCodeAt(0) || 0x4d);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertLocalBaseUrl(value: string): void {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "::1", "medplum-server"].includes(url.hostname)) {
    throw new Error("Legacy-import crash worker is restricted to a local self-hosted Medplum.");
  }
}
