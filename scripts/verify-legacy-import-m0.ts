#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import type {
  Encounter,
  Media,
  Patient,
  ProjectMembership,
} from "@medplum/fhirtypes";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";
import { patientAccessEntry } from "../mcp/src/clinical-graph/provider-assignment-endpoint.js";
import { createOperatorScriptFhirClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { uploadBinary } from "../mcp/src/fhir/binary-upload.js";
import { PgBinaryAttemptStore } from "../mcp/src/legacy-import/binary-attempt-store.js";
import {
  assertBinaryHash,
  recoverLegacyMedia,
  tagMigrationBinary,
  type LegacyMediaSource,
} from "../mcp/src/legacy-import/binary-transport.js";
import {
  PgBinaryReferenceScanner,
  readLegacyAcceptancePatientCounts,
  readStoredMedia,
  sweepLegacyImportBinaries,
} from "../mcp/src/legacy-import/orphan-sweep.js";
import { resolvePracticeProjectId } from "./setup-legacy-importer.js";

const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const postgresUrl =
  process.env.ODOS_POSTGRES_URL
  ?? process.env.OSOD_POSTGRES_URL
  ?? "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const composeProject = process.env.ODOS_COMPOSE_PROJECT ?? "odos2020";
let composeCommand: { executable: string; prefix: string[] } | undefined;
assertLocalBaseUrl(baseUrl);
if (process.env.ODOS_ACCEPTANCE_ALLOW_DESTRUCTIVE !== "1") {
  throw new Error(
    "Refusing destructive legacy-import acceptance. It restarts Medplum, removes a synthetic blob, "
    + "and disposes a synthetic Binary. Use a disposable synthetic-only project and set "
    + "ODOS_ACCEPTANCE_ALLOW_DESTRUCTIVE=1.",
  );
}
const operatorToken = requireEnv("ODOS_OPERATOR_ACCESS_TOKEN");
const clinicianToken = requireEnv("ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN");
const serviceFhir = createOperatorScriptFhirClient({
  baseUrl,
  accessToken: operatorToken,
  reason: "Operator legacy import verification runs outside request handling.",
});
const projectId = await resolvePracticeProjectId(baseUrl, operatorToken, serviceFhir, postgresUrl);
const patientCounts = await readLegacyAcceptancePatientCounts(postgresUrl, projectId);
if (patientCounts.nonSynthetic > 0) {
  throw new Error(
    `Refusing destructive legacy-import acceptance: project ${projectId} contains `
    + `${patientCounts.nonSynthetic} non-synthetic Patient resource(s) out of ${patientCounts.total}.`,
  );
}
const clinicianContext = await readSessionContext(baseUrl, clinicianToken);
if (clinicianContext.projectId !== projectId || clinicianContext.superAdmin) {
  throw new Error("ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN must be a non-superadmin in the target project.");
}
const clinicianProfileReference = clinicianContext.profileReference;
if (!clinicianProfileReference || !/^Practitioner(Role)?\/[^/]+$/.test(clinicianProfileReference)) {
  throw new Error("ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN must resolve to a staff profile.");
}
const importerToken = await exchangeClientCredentials({
  baseUrl,
  clientId: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
  clientSecret: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
});
const importerAuth = { baseUrl, accessToken: importerToken };
const importerFhir = createOperatorScriptFhirClient({
  ...importerAuth,
  reason: "Operator legacy importer verification runs outside request handling.",
});
const attempts = new PgBinaryAttemptStore({ postgresUrl });
const scanner = new PgBinaryReferenceScanner({ postgresUrl });
try {
  const patient = await serviceFhir.create<Patient>({
    resourceType: "Patient",
    meta: { project: projectId, tag: [{ system: "https://odos2020.com/tags/test", code: "legacy-import-m0" }] },
    active: true,
    name: [{ family: `MigrationM0${Date.now()}`, given: ["Synthetic"] }],
    gender: "unknown",
    generalPractitioner: [{ reference: clinicianProfileReference }],
  });
  if (!patient.id) throw new Error("Acceptance Patient has no id.");
  const clinicianMemberships = (await searchAll<ProjectMembership>(
    serviceFhir,
    "ProjectMembership",
    { profile: clinicianProfileReference },
  )).filter((membership) => membership.profile.reference === clinicianProfileReference);
  if (clinicianMemberships.length !== 1) {
    throw new Error(
      `Expected one clinician ProjectMembership for ${clinicianProfileReference}; found ${clinicianMemberships.length}.`,
    );
  }
  const clinicianMembership = clinicianMemberships[0]!;
  const clinicianPolicyReference = clinicianMembership.access
    ?.find((access) => access.policy.reference)?.policy.reference
    ?? clinicianMembership.accessPolicy?.reference;
  if (!clinicianMembership.id || !clinicianMembership.meta?.versionId || !clinicianPolicyReference) {
    throw new Error("Clinician ProjectMembership must carry id, meta.versionId, and a policy reference.");
  }
  const clinicianPatientAccess = patientAccessEntry(
    clinicianPolicyReference,
    clinicianProfileReference,
    `Patient/${patient.id}`,
  );
  await serviceFhir.patch<ProjectMembership>(
    "ProjectMembership",
    clinicianMembership.id,
    clinicianMembership.access?.length
      ? [{ op: "add", path: "/access/-", value: clinicianPatientAccess }]
      : [{ op: "add", path: "/access", value: [clinicianPatientAccess] }],
    { "If-Match": `W/"${clinicianMembership.meta.versionId}"` },
  );
  const encounter = await serviceFhir.create<Encounter>({
    resourceType: "Encounter",
    meta: { project: projectId, tag: [{ system: "https://odos2020.com/tags/test", code: "legacy-import-m0" }] },
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${patient.id}` },
    period: { start: new Date().toISOString(), end: new Date().toISOString() },
  });
  if (!encounter.id) throw new Error("Acceptance Encounter has no id.");

  const deniedDelete = await fetch(`${baseUrl.replace(/\/$/, "")}/fhir/R4/Patient/${patient.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${importerToken}`, Accept: "application/fhir+json" },
  });
  if (deniedDelete.status !== 403) {
    throw new Error(`Importer Patient delete must be 403; received ${deniedDelete.status}.`);
  }

  const original = new Uint8Array(1024 * 1024 + 65_537);
  randomBytes(original.byteLength).copy(original);
  const directAttempt = await attempts.open({
    sourceFilename: `acceptance-direct-${Date.now()}.jpg`,
    patientReference: `Patient/${patient.id}`,
  });
  const raw = await uploadBinary({
    bytes: original,
    contentType: "image/jpeg",
    filename: directAttempt.sourceFilename,
    securityContext: `Patient/${patient.id}`,
    auth: importerAuth,
  });
  await attempts.recordReturned(directAttempt.attemptId, raw.binaryId);
  const tagged = await tagMigrationBinary(raw.resource, importerAuth);
  await assertBinaryHash(raw.binaryId, original, importerAuth);
  const media = await importerFhir.create<Media>({
    resourceType: "Media",
    status: "completed",
    identifier: [{ value: directAttempt.sourceFilename }],
    subject: { reference: `Patient/${patient.id}` },
    encounter: { reference: `Encounter/${encounter.id}` },
    content: {
      contentType: "image/jpeg",
      title: directAttempt.sourceFilename,
      url: raw.url,
    },
  });
  if (!media.id) throw new Error("Acceptance Media has no id.");
  await attempts.resolveAttached(directAttempt.attemptId, media.id, raw.binaryId);
  const stored = await readStoredMedia(postgresUrl, media.id);
  if (stored.content.url !== raw.url || stored.content.data !== undefined) {
    throw new Error("Stored Media must contain canonical Binary/{id} url and no inline data.");
  }
  if (!tagged.meta?.tag?.some((tag) =>
    tag.system === "https://odos2020.com/tags/migration" && tag.code === "eyefinity-import")) {
    throw new Error("Raw-uploaded Binary is missing the migration tag.");
  }
  console.log(
    `DIRECT upload_status=201 binary=${raw.binaryId} bytes=${original.byteLength} `
    + `stored_url=${stored.content.url} stored_data=absent importer_patient_delete=403`,
  );

  restartMedplum(composeProject);
  await waitForMedplum(baseUrl);
  await serviceFhir.read<Media>("Media", media.id);
  const clinicianFhir = createOperatorScriptFhirClient({
    baseUrl,
    accessToken: clinicianToken,
    reason: "Operator legacy clinician-access verification runs outside request handling.",
  });
  const clinicianMedia = await clinicianFhir.read<Media>("Media", media.id);
  console.log(`BISECT operator_media_read=200 clinician_media_read=200 media=${media.id}`);
  const rewrittenUrl = clinicianMedia.content.url;
  if (!rewrittenUrl || rewrittenUrl.startsWith("Binary/")) {
    throw new Error("Ordinary clinician Media read did not rewrite content.url to a presigned URL.");
  }
  const clinicianBlob = await fetch(rewrittenUrl);
  if (!clinicianBlob.ok) {
    throw new Error(`Ordinary clinician attachment read failed: ${clinicianBlob.status}.`);
  }
  const clinicianBytes = new Uint8Array(await clinicianBlob.arrayBuffer());
  assertSameBytes(original, clinicianBytes, "ordinary clinician");
  console.log(
    `CLINICIAN read_status=200 attachment_status=${clinicianBlob.status} `
    + `bytes=${clinicianBytes.byteLength} sha256=${hash(clinicianBytes)} restart=passed`,
  );

  const crashFile = `acceptance-crash-${Date.now()}.jpg`;
  const crash = await runCrashWorker({
    fileNameNew: crashFile,
    patientReference: `Patient/${patient.id}`,
    encounterReference: `Encounter/${encounter.id}`,
  });
  removeSyntheticBlob(composeProject, crash.binaryId);
  const recoverySource: LegacyMediaSource = {
    fileNameNew: crashFile,
    patientReference: `Patient/${patient.id}`,
    encounterReference: `Encounter/${encounter.id}`,
    contentType: "image/jpeg",
    bytes: crashBytes(crashFile),
  };
  const recovery = await recoverLegacyMedia({
    source: recoverySource,
    auth: importerAuth,
    fhir: importerFhir,
    attempts,
  });
  if (recovery.action !== "recovered-preparation") {
    throw new Error(`Crash recovery expected recovered-preparation; received ${recovery.action}.`);
  }
  console.log(
    `CRASH recovery killed_phase=${crash.phase} media=${crash.mediaId} `
    + `action=${recovery.action} replacement_binary=${recovery.binaryId} hash=passed`,
  );

  const dryRun = await sweepLegacyImportBinaries({
    attempts,
    scanner,
    auth: importerAuth,
  });
  const stranded = dryRun.find((entry) => entry.binaryId === crash.binaryId);
  if (stranded?.outcome !== "candidate" || !stranded.binaryMetadataExists) {
    throw new Error("Sweep did not enumerate the metadata-only stranded Binary candidate.");
  }
  console.log(
    `CRASH sweep binary=${crash.binaryId} metadata_row=present blob=absent `
    + `references=${stranded.references.length} outcome=${stranded.outcome}`,
  );
  const disposed = await sweepLegacyImportBinaries({
    attempts,
    scanner,
    auth: importerAuth,
    execute: true,
    binaryIds: [crash.binaryId],
  });
  const disposedCrash = disposed.find((entry) => entry.binaryId === crash.binaryId);
  if (disposedCrash?.outcome !== "disposed") {
    throw new Error("Sweep did not dispose the metadata-only stranded Binary.");
  }
  console.log(`CRASH disposal binary=${crash.binaryId} outcome=${disposedCrash.outcome}`);
  console.log("LEGACY_IMPORT_M0_ACCEPTANCE PASS");
} finally {
  await attempts.close();
  await scanner.close();
}

async function runCrashWorker(input: {
  fileNameNew: string;
  patientReference: string;
  encounterReference: string;
}): Promise<{
  phase: string;
  mediaId: string;
  attemptId: string;
  binaryId: string;
  binaryVersionId: string;
}> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/fixtures/legacy-import-crash-worker.ts",
      input.fileNameNew,
      input.patientReference,
      input.encounterReference,
    ],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const line = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finishError = (error: Error, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (kill) child.kill("SIGKILL");
      reject(error);
    };
    const finishLine = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(
      () => finishError(new Error(`Crash worker timed out: ${stderr}`), true),
      60_000,
    );
    child.once("error", (error) => finishError(error, true));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        finishLine(stdout.slice(0, newline));
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        finishError(
          new Error(`Crash worker exited ${code ?? "without a code"} before reporting state: ${stderr}`),
          false,
        );
      }
    });
  });
  child.kill("SIGKILL");
  await exit;
  const parsed = JSON.parse(line) as {
    phase?: string;
    mediaId?: string;
    attemptId?: string;
    binaryId?: string;
    binaryVersionId?: string;
  };
  if (!parsed.phase || !parsed.mediaId || !parsed.attemptId || !parsed.binaryId || !parsed.binaryVersionId) {
    throw new Error("Crash worker returned incomplete state.");
  }
  return parsed as {
    phase: string;
    mediaId: string;
    attemptId: string;
    binaryId: string;
    binaryVersionId: string;
  };
}

function restartMedplum(project: string): void {
  execCompose(["-p", project, "restart", "medplum-server"]);
}

function removeSyntheticBlob(project: string, binaryId: string): void {
  assertUuid(binaryId);
  execCompose([
    "-p",
    project,
    "exec",
    "-T",
    "medplum-server",
    "node",
    "-e",
    `require("node:fs").rmSync("/data/binary/${binaryId}",{recursive:true,force:true})`,
  ]);
}

function execCompose(args: string[]): void {
  if (!composeCommand) {
    try {
      execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
      composeCommand = { executable: "docker", prefix: ["compose"] };
    } catch {
      execFileSync("docker-compose", ["version"], { stdio: "ignore" });
      composeCommand = { executable: "docker-compose", prefix: [] };
    }
  }
  execFileSync(composeCommand.executable, [...composeCommand.prefix, ...args], {
    stdio: "ignore",
  });
}

async function waitForMedplum(base: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/healthcheck`);
      if (response.ok) return;
    } catch {
      // Restart window.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for Medplum restart.");
}

async function readSessionContext(
  base: string,
  accessToken: string,
): Promise<{ projectId?: string; profileReference?: string; superAdmin: boolean }> {
  const response = await fetch(`${base.replace(/\/$/, "")}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Acceptance token /auth/me failed: ${response.status}.`);
  }
  const body = (await response.json()) as {
    project?: { id?: string; superAdmin?: boolean };
    profile?: { resourceType?: string; id?: string };
  };
  return {
    projectId: body.project?.id,
    profileReference: body.profile?.resourceType && body.profile.id
      ? `${body.profile.resourceType}/${body.profile.id}`
      : undefined,
    superAdmin: body.project?.superAdmin === true,
  };
}

function crashBytes(seed: string): Uint8Array {
  return new Uint8Array(1024 * 1024 + 4_097).fill(seed.charCodeAt(0) || 0x4d);
}

function assertSameBytes(expected: Uint8Array, actual: Uint8Array, label: string): void {
  if (expected.byteLength !== actual.byteLength || hash(expected) !== hash(actual)) {
    throw new Error(`${label} byte size or SHA-256 mismatch.`);
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Expected UUID; received ${value}.`);
  }
}

function assertLocalBaseUrl(value: string): void {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("Legacy-import M0 acceptance is restricted to local Medplum.");
  }
}
