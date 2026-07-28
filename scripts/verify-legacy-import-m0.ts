#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import type {
  Encounter,
  Media,
  Patient,
  ProjectMembership,
  User,
} from "@medplum/fhirtypes";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";
import { createMedplumClient } from "../mcp/src/fhir-client.js";
import { uploadBinary } from "../mcp/src/fhir/binary-upload.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { PgBinaryAttemptStore } from "../mcp/src/legacy-import/binary-attempt-store.js";
import {
  assertBinaryHash,
  recoverLegacyMedia,
  tagMigrationBinary,
  type LegacyMediaSource,
} from "../mcp/src/legacy-import/binary-transport.js";
import {
  PgBinaryReferenceScanner,
  findPracticeClinicianPolicy,
  readStoredMedia,
  sweepLegacyImportBinaries,
} from "../mcp/src/legacy-import/orphan-sweep.js";
import { loginForLocalRepair } from "./repair-practice-roles.js";
import { resolvePracticeProjectId } from "./setup-legacy-importer.js";

const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const postgresUrl =
  process.env.ODOS_POSTGRES_URL
  ?? process.env.OSOD_POSTGRES_URL
  ?? "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const composeProject = process.env.ODOS_COMPOSE_PROJECT ?? "odos2020";
assertLocalBaseUrl(baseUrl);

const humanEmail =
  process.env.ODOS_ADMIN_EMAIL
  ?? process.env.OSOD_ADMIN_EMAIL
  ?? requireEnv("MEDPLUM_ADMIN_EMAIL");
const humanPassword =
  process.env.ODOS_ADMIN_PASSWORD
  ?? process.env.OSOD_ADMIN_PASSWORD
  ?? requireEnv("MEDPLUM_ADMIN_PASSWORD");
const serviceEmail = requireEnv("MEDPLUM_ADMIN_EMAIL");
const servicePassword = requireEnv("MEDPLUM_ADMIN_PASSWORD");
const humanToken = await loginWithRetry({ baseUrl, email: humanEmail, password: humanPassword });
const serviceToken = humanEmail === serviceEmail && humanPassword === servicePassword
  ? humanToken
  : await loginWithRetry({ baseUrl, email: serviceEmail, password: servicePassword });
const serviceFhir = createMedplumClient({ baseUrl, accessToken: serviceToken });
const projectId = await resolvePracticeProjectId(baseUrl, humanToken, serviceFhir, postgresUrl);
const clinicianPolicy = await findPracticeClinicianPolicy(postgresUrl);
if (clinicianPolicy.projectId !== projectId) {
  throw new Error("Stored clinician policy project does not match the resolved practice project.");
}
const importerToken = await exchangeClientCredentials({
  baseUrl,
  clientId: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
  clientSecret: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
});
const importerAuth = { baseUrl, accessToken: importerToken };
const importerFhir = createMedplumClient(importerAuth);
const attempts = new PgBinaryAttemptStore({ postgresUrl });
const scanner = new PgBinaryReferenceScanner({ postgresUrl });
try {
  const patient = await serviceFhir.create<Patient>({
    resourceType: "Patient",
    meta: { project: projectId, tag: [{ system: "https://odos2020.com/tags/test", code: "legacy-import-m0" }] },
    active: true,
    name: [{ family: `MigrationM0${Date.now()}`, given: ["Synthetic"] }],
    gender: "unknown",
  });
  if (!patient.id) throw new Error("Acceptance Patient has no id.");
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
  const clinician = await ensureSyntheticClinician({
    baseUrl,
    projectId,
    humanToken,
    serviceToken,
    serviceFhir,
    clinicianPolicyId: clinicianPolicy.policyId,
    patient,
  });
  const clinicianToken = await loginWithRetry({
    baseUrl,
    email: clinician.email,
    password: clinician.password,
  });
  const clinicianFhir = createMedplumClient({ baseUrl, accessToken: clinicianToken });
  const clinicianMedia = await clinicianFhir.read<Media>("Media", media.id);
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

async function ensureSyntheticClinician(input: {
  baseUrl: string;
  projectId: string;
  humanToken: string;
  serviceToken: string;
  serviceFhir: ReturnType<typeof createMedplumClient>;
  clinicianPolicyId: string;
  patient: Patient;
}): Promise<{ email: string; password: string }> {
  const email = "migration-m0-clinician@odos.local";
  const password = `M0-${randomBytes(24).toString("base64url")}!`;
  let users = (await searchAll<User>(input.serviceFhir, "User", { email }))
    .filter((user) => user.email?.toLowerCase() === email);
  if (users.length === 0) {
    const response = await fetch(
      `${input.baseUrl.replace(/\/$/, "")}/admin/projects/${input.projectId}/invite`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.humanToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resourceType: "Practitioner",
          email,
          firstName: "Synthetic",
          lastName: "M0 Clinician",
          sendEmail: false,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Synthetic clinician invite failed: ${response.status} ${await response.text()}`);
    }
    users = (await searchAll<User>(input.serviceFhir, "User", { email }))
      .filter((user) => user.email?.toLowerCase() === email);
  }
  if (users.length !== 1 || !users[0]?.id) {
    throw new Error(`Expected one synthetic clinician User; found ${users.length}.`);
  }
  const memberships = (await searchAll<ProjectMembership>(input.serviceFhir, "ProjectMembership", {
    user: `User/${users[0].id}`,
  })).filter((membership) => membership.project.reference === `Project/${input.projectId}`);
  if (memberships.length !== 1 || !memberships[0]?.id || !memberships[0].meta?.versionId) {
    throw new Error(`Expected one versioned synthetic clinician membership; found ${memberships.length}.`);
  }
  const membership = memberships[0];
  const providerReference = membership.profile.reference;
  if (!/^Practitioner\/[^/]+$/.test(providerReference)) {
    throw new Error("Synthetic clinician membership has no Practitioner profile.");
  }
  await input.serviceFhir.update<ProjectMembership>(
    "ProjectMembership",
    membership.id,
    {
      ...membership,
      admin: false,
      accessPolicy: undefined,
      access: [{
        policy: { reference: `AccessPolicy/${input.clinicianPolicyId}` },
        parameter: [
          { name: "provider_profile", valueReference: { reference: providerReference } },
          { name: "patient_compartment", valueString: `Patient/${input.patient.id}` },
        ],
      }],
    },
    { "If-Match": `W/"${membership.meta.versionId}"` },
  );
  const passwordResponse = await fetch(`${input.baseUrl.replace(/\/$/, "")}/admin/super/setpassword`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.serviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!passwordResponse.ok) {
    throw new Error(`Synthetic clinician password setup failed: ${passwordResponse.status}.`);
  }
  if (!input.patient.id || !input.patient.meta?.versionId) {
    throw new Error("Synthetic acceptance Patient requires id/meta.versionId for provider assignment.");
  }
  await input.serviceFhir.update<Patient>(
    "Patient",
    input.patient.id,
    {
      ...input.patient,
      generalPractitioner: [{ reference: providerReference }],
    },
    { "If-Match": `W/"${input.patient.meta.versionId}"` },
  );
  return { email, password };
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
  const line = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Crash worker timed out: ${stderr}`)), 60_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(stdout.slice(0, newline));
      }
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Crash worker exited ${code}: ${stderr}`));
      }
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
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
  execFileSync("docker-compose", ["-p", project, "restart", "medplum-server"], {
    stdio: "ignore",
  });
}

function removeSyntheticBlob(project: string, binaryId: string): void {
  assertUuid(binaryId);
  execFileSync(
    "docker-compose",
    [
      "-p",
      project,
      "exec",
      "-T",
      "medplum-server",
      "node",
      "-e",
      `require("node:fs").rmSync("/data/binary/${binaryId}",{recursive:true,force:true})`,
    ],
    { stdio: "ignore" },
  );
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

async function loginWithRetry(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await loginForLocalRepair(input);
    } catch (error) {
      if (!String(error).includes("429") || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  throw new Error("Unreachable login retry state.");
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
