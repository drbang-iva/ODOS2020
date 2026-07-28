import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AccessPolicy, Binary, Bundle, Media } from "@medplum/fhirtypes";
import {
  uploadBinary,
  type BinaryUploadAuth,
} from "../src/fhir/binary-upload.js";
import {
  buildMigrationImporterAccessPolicy,
  MIGRATION_TAG_CODE,
  MIGRATION_TAG_SYSTEM,
} from "../src/legacy-import/access-policy.js";
import type {
  BinaryAttempt,
  BinaryAttemptStore,
} from "../src/legacy-import/binary-attempt-store.js";
import {
  recoverLegacyMedia,
  tagMigrationBinary,
  uploadMigrationBinary,
  type LegacyMediaSource,
} from "../src/legacy-import/binary-transport.js";
import {
  sweepLegacyImportBinaries,
  type BinaryReferenceScanner,
} from "../src/legacy-import/orphan-sweep.js";

const sourceBytes = new Uint8Array(1024 * 1024 + 17).fill(0x5a);
const source: LegacyMediaSource = {
  fileNameNew: "legacy-image-001.jpg",
  bytes: sourceBytes,
  contentType: "image/jpeg",
  patientReference: "Patient/11111111-1111-4111-8111-111111111111",
  encounterReference: "Encounter/22222222-2222-4222-8222-222222222222",
};
const binaryId = "33333333-3333-4333-8333-333333333333";

test("raw Binary upload sends >1 MB bytes and the parser security-context headers", async () => {
  let observed: RequestInit | undefined;
  const result = await uploadBinary({
    bytes: sourceBytes,
    contentType: source.contentType,
    filename: source.fileNameNew,
    securityContext: source.patientReference,
    auth: {
      baseUrl: "http://localhost:8103",
      accessToken: "token",
      fetch: async (_url, init) => {
        observed = init;
        return fhirResponse({
          resourceType: "Binary",
          id: binaryId,
          meta: { versionId: "1" },
          contentType: source.contentType,
          securityContext: { reference: source.patientReference },
        }, 201);
      },
    },
  });
  assert.equal(result.url, `Binary/${binaryId}`);
  assert.equal((observed?.body as Uint8Array).byteLength, sourceBytes.byteLength);
  assert.equal(headers(observed).get("content-type"), "image/jpeg");
  assert.equal(headers(observed).get("x-security-context"), source.patientReference);
  assert.equal(headers(observed).get("x-odos-binary-parser"), "security-context-v1");
});

test("raw Binary upload rejects a missing security context before fetch", async () => {
  let called = false;
  await assert.rejects(
    uploadBinary({
      bytes: sourceBytes,
      contentType: source.contentType,
      filename: source.fileNameNew,
      securityContext: "",
      auth: {
        baseUrl: "http://localhost:8103",
        accessToken: "token",
        fetch: async () => {
          called = true;
          return new Response();
        },
      },
    }),
    /Binary\.securityContext is required/,
  );
  assert.equal(called, false);
});

test("migration Binary tag uses full JSON PUT, If-Match, and leaves data absent", async () => {
  let observed: RequestInit | undefined;
  const updated = await tagMigrationBinary({
    resourceType: "Binary",
    id: binaryId,
    meta: { versionId: "1" },
    contentType: source.contentType,
    securityContext: { reference: source.patientReference },
  }, {
    baseUrl: "http://localhost:8103",
    accessToken: "token",
    fetch: async (_url, init) => {
      observed = init;
      const body = JSON.parse(String(init?.body)) as Binary;
      return fhirResponse({ ...body, meta: { ...body.meta, versionId: "2" } });
    },
  });
  const body = JSON.parse(String(observed?.body)) as Binary;
  assert.equal(observed?.method, "PUT");
  assert.equal(headers(observed).get("if-match"), 'W/"1"');
  assert.equal(body.data, undefined);
  assert.deepEqual(body.meta?.tag, [{ system: MIGRATION_TAG_SYSTEM, code: MIGRATION_TAG_CODE }]);
  assert.equal(updated.meta?.versionId, "2");
});

test("migration importer AccessPolicy grants the exact resource interactions", () => {
  const policy = buildMigrationImporterAccessPolicy("project-1");
  const rules = policy.resource ?? [];
  for (const resourceType of [
    "Patient",
    "Appointment",
    "Encounter",
    "Media",
    "Observation",
    "VisionPrescription",
    "Coverage",
    "Practitioner",
    "Provenance",
  ]) {
    assert.deepEqual(rule(policy, resourceType).interaction, ["search", "read", "create", "update"]);
  }
  assert.deepEqual(rule(policy, "Organization").interaction, ["search", "read", "create"]);
  assert.deepEqual(rule(policy, "Location").interaction, ["search", "read"]);
  const binaryRules = rules.filter((entry) => entry.resourceType === "Binary");
  assert.deepEqual(binaryRules[0]?.interaction, ["read", "create", "delete"]);
  assert.deepEqual(binaryRules[1]?.interaction, ["update"]);
  assert.ok(binaryRules[1]?.readonlyFields?.includes("securityContext"));
  assert.equal(JSON.stringify(binaryRules).includes("search"), false);
  for (const entry of rules.filter((candidate) => candidate.resourceType !== "Binary")) {
    assert.equal(entry.interaction?.includes("delete"), false);
  }
});

test("all four Media recovery states converge or skip as designed", async (t) => {
  const cases: Array<{
    name: string;
    existing?: Media;
    existingBytes?: Uint8Array;
    expectedAction: string;
    expectedPosts: number;
  }> = [
    {
      name: "no Media",
      expectedAction: "created",
      expectedPosts: 1,
    },
    {
      name: "preparation without url",
      existing: media("preparation"),
      expectedAction: "recovered-preparation",
      expectedPosts: 1,
    },
    {
      name: "completed with matching blob",
      existing: media("completed", `Binary/${binaryId}`),
      existingBytes: sourceBytes,
      expectedAction: "skipped-verified",
      expectedPosts: 0,
    },
    {
      name: "completed with corrupt blob",
      existing: media("completed", `Binary/${binaryId}`),
      existingBytes: new Uint8Array([1, 2, 3]),
      expectedAction: "replaced-corrupt",
      expectedPosts: 1,
    },
  ];

  for (const recoveryCase of cases) {
    await t.test(recoveryCase.name, async () => {
      const attempts = new MemoryAttemptStore();
      let posts = 0;
      const nextBinaryId = recoveryCase.expectedPosts
        ? "44444444-4444-4444-8444-444444444444"
        : binaryId;
      const auth: BinaryUploadAuth = {
        baseUrl: "http://localhost:8103",
        accessToken: "token",
        fetch: async (url, init) => {
          const href = String(url);
          if (init?.method === "POST") {
            posts += 1;
            return fhirResponse(binary(nextBinaryId, "1"), 201);
          }
          if (init?.method === "PUT") {
            return fhirResponse(binary(nextBinaryId, "2"));
          }
          const bytes = href.endsWith(`/${binaryId}`)
            ? recoveryCase.existingBytes ?? sourceBytes
            : sourceBytes;
          return new Response(bytes, { status: 200, headers: { "Content-Type": "image/jpeg" } });
        },
      };
      const fhir = new MemoryMediaFhir(recoveryCase.existing);
      const result = await recoverLegacyMedia({ source, auth, fhir, attempts });
      assert.equal(result.action, recoveryCase.expectedAction);
      assert.equal(posts, recoveryCase.expectedPosts);
      if (posts) {
        assert.equal(attempts.rows[0]?.status, "resolved-attached");
        assert.equal(fhir.lastUpdateHeaders?.["If-Match"], 'W/"1"');
      }
    });
  }
});

test("post-response/pre-Media crash leaves an open attempt carrying the Binary id", async () => {
  const attempts = new MemoryAttemptStore();
  const uploaded = await uploadMigrationBinary({
    source,
    attempts,
    auth: {
      baseUrl: "http://localhost:8103",
      accessToken: "token",
      fetch: async (_url, init) => {
        if (init?.method === "POST") return fhirResponse(binary(binaryId, "1"), 201);
        if (init?.method === "PUT") return fhirResponse(binary(binaryId, "2"));
        return new Response(sourceBytes);
      },
    },
  });
  assert.equal(uploaded.attempt.status, "open");
  assert.equal(attempts.rows[0]?.binaryId, binaryId);
  assert.equal(attempts.rows[0]?.status, "open");
});

test("completed Media recovery closes an open post-Media-update attempt", async () => {
  const attempts = new MemoryAttemptStore();
  const opened = await attempts.open({
    sourceFilename: source.fileNameNew,
    patientReference: source.patientReference,
    mediaId: media("completed", `Binary/${binaryId}`).id,
  });
  await attempts.recordReturned(opened.attemptId, binaryId);
  const fhir = new MemoryMediaFhir(media("completed", `Binary/${binaryId}`));
  const result = await recoverLegacyMedia({
    source,
    fhir,
    attempts,
    auth: {
      baseUrl: "http://localhost:8103",
      accessToken: "token",
      fetch: async () => new Response(sourceBytes),
    },
  });
  assert.equal(result.action, "skipped-verified");
  assert.equal(attempts.rows[0]?.status, "resolved-attached");
});

test("orphan sweep reports and never deletes a Binary referenced only by DocumentReference", async () => {
  const attempts = new MemoryAttemptStore();
  const opened = await attempts.open({
    sourceFilename: source.fileNameNew,
    patientReference: source.patientReference,
  });
  await attempts.recordReturned(opened.attemptId, binaryId);
  let deleted = false;
  const scanner: BinaryReferenceScanner = {
    findAttachmentReferences: async () => [{
      table: "DocumentReference",
      resourceId: "doc-1",
      url: `Binary/${binaryId}`,
    }],
    binaryMetadataExists: async () => true,
  };
  const results = await sweepLegacyImportBinaries({
    attempts,
    scanner,
    execute: true,
    auth: {
      baseUrl: "http://localhost:8103",
      accessToken: "token",
      fetch: async () => {
        deleted = true;
        return new Response(null, { status: 204 });
      },
    },
  });
  assert.equal(results[0]?.outcome, "reported-referenced");
  assert.equal(results[0]?.references[0]?.table, "DocumentReference");
  assert.equal(deleted, false);
});

test("tracked config, compose init, and inline-limit strings remain truthful", () => {
  const root = new URL("../../", import.meta.url);
  const config = JSON.parse(readFileSync(new URL("medplum.config.json", root), "utf8")) as Record<string, string>;
  const drill = JSON.parse(readFileSync(new URL("medplum.dr-drill.config.json", root), "utf8")) as Record<string, string>;
  assert.equal(config.signingKey, "INERT_ENV_OVERLAY_REQUIRED");
  assert.equal(drill.signingKey, "INERT_ENV_OVERLAY_REQUIRED");
  const mainCompose = readFileSync(new URL("docker-compose.yml", root), "utf8");
  const drillCompose = readFileSync(new URL("docker-compose.dr-drill.yml", root), "utf8");
  for (const compose of [mainCompose, drillCompose]) {
    assert.match(compose, /medplum-binary-init:/);
    assert.match(compose, /"1000:1000"/);
    assert.match(compose, /service_completed_successfully/);
    assert.match(compose, /file:\/config\/medplum\.config\.json,env/);
  }
  for (const path of [
    "mcp/src/clinical-graph/imaging-endpoint.ts",
    "ui/src/components/charting/ImagingSection.tsx",
    "ui/src/components/LongitudinalImagingCard.tsx",
  ]) {
    const content = readFileSync(new URL(path, root), "utf8");
    assert.doesNotMatch(content, /15 MB|15 \* 1024 \* 1024/);
    assert.match(content, /1 MB|1 \* 1024 \* 1024/);
  }
});

class MemoryMediaFhir {
  lastUpdateHeaders?: Record<string, string>;

  constructor(private existing?: Media) {}

  async search<T>(): Promise<Bundle<T & { resourceType: string }>> {
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: this.existing ? [{ resource: this.existing as T & { resourceType: string } }] : [],
    };
  }

  async create<T>(): Promise<T> {
    this.existing = media("preparation");
    return this.existing as T;
  }

  async update<T>(
    _rt: string,
    _id: string,
    resource: T,
    headersValue?: Record<string, string>,
  ): Promise<T> {
    this.lastUpdateHeaders = headersValue;
    this.existing = resource as Media;
    return resource;
  }
}

class MemoryAttemptStore implements BinaryAttemptStore {
  rows: BinaryAttempt[] = [];

  async open(input: {
    sourceFilename: string;
    patientReference: string;
    mediaId?: string;
  }): Promise<BinaryAttempt> {
    const row: BinaryAttempt = {
      attemptId: `attempt-${this.rows.length + 1}`,
      sourceFilename: input.sourceFilename,
      patientReference: input.patientReference,
      ...(input.mediaId ? { mediaId: input.mediaId } : {}),
      status: "open",
      openedAt: new Date(0).toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async recordReturned(attemptId: string, nextBinaryId: string): Promise<BinaryAttempt> {
    return this.replace(attemptId, { binaryId: nextBinaryId, requestReturnedAt: new Date(1).toISOString() });
  }

  async resolveAttached(attemptId: string, mediaId: string, nextBinaryId: string): Promise<BinaryAttempt> {
    return this.replace(attemptId, {
      mediaId,
      binaryId: nextBinaryId,
      status: "resolved-attached",
      resolvedAt: new Date(2).toISOString(),
    });
  }

  async resolveAttachedByBinaryId(nextBinaryId: string, mediaId: string): Promise<number> {
    const rows = this.rows.filter((row) => row.binaryId === nextBinaryId && row.status === "open");
    for (const row of rows) {
      this.replace(row.attemptId, {
        mediaId,
        status: "resolved-attached",
        resolvedAt: new Date(2).toISOString(),
      });
    }
    return rows.length;
  }

  async resolveNotCreated(attemptId: string, detail: string): Promise<BinaryAttempt> {
    return this.replace(attemptId, {
      status: "resolved-not-created",
      resolvedAt: new Date(2).toISOString(),
      resolutionDetail: detail,
    });
  }

  async resolveDisposed(attemptId: string, detail: string): Promise<BinaryAttempt> {
    return this.replace(attemptId, {
      status: "resolved-disposed",
      resolvedAt: new Date(2).toISOString(),
      resolutionDetail: detail,
    });
  }

  async reopenByBinaryId(nextBinaryId: string, detail: string): Promise<void> {
    const row = this.rows.find((candidate) => candidate.binaryId === nextBinaryId);
    if (row) {
      this.replace(row.attemptId, {
        status: "open",
        resolvedAt: undefined,
        resolutionDetail: detail,
      });
    }
  }

  async listOpen(): Promise<BinaryAttempt[]> {
    return this.rows.filter((row) => row.status === "open");
  }

  private replace(attemptId: string, patch: Partial<BinaryAttempt>): BinaryAttempt {
    const index = this.rows.findIndex((row) => row.attemptId === attemptId);
    assert.notEqual(index, -1);
    const next = { ...this.rows[index]!, ...patch };
    this.rows[index] = next;
    return next;
  }
}

function media(status: Media["status"], url?: string): Media {
  return {
    resourceType: "Media",
    id: "55555555-5555-4555-8555-555555555555",
    meta: { versionId: "1" },
    status,
    identifier: [{ value: source.fileNameNew }],
    subject: { reference: source.patientReference },
    encounter: { reference: source.encounterReference },
    content: { contentType: source.contentType, title: source.fileNameNew, ...(url ? { url } : {}) },
  };
}

function binary(id: string, versionId: string): Binary {
  return {
    resourceType: "Binary",
    id,
    meta: { versionId },
    contentType: source.contentType,
    securityContext: { reference: source.patientReference },
  };
}

function rule(policy: AccessPolicy, resourceType: string) {
  const result = policy.resource?.find((entry) => entry.resourceType === resourceType);
  assert.ok(result);
  return result;
}

function fhirResponse(resource: object, status = 200): Response {
  return new Response(JSON.stringify(resource), {
    status,
    headers: { "Content-Type": "application/fhir+json" },
  });
}

function headers(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}
