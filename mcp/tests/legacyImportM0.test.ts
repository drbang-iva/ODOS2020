import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AccessPolicy, Binary, Bundle, Media } from "@medplum/fhirtypes";
import {
  uploadBinary,
  type BinaryUploadAuth,
} from "../src/fhir/binary-upload.js";
import { createMedplumClient } from "../src/fhir-client.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";
import {
  buildMigrationImporterAccessPolicy,
  MIGRATION_IMPORTER_POLICY_TAG_CODE,
  MIGRATION_IMPORTER_POLICY_TAG_SYSTEM,
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
  describeStoredClinicianPolicyConflict,
  PgBinaryReferenceScanner,
  sweepLegacyImportBinaries,
  type BinaryReferenceDatabase,
  type BinaryReferenceScanner,
  type StoredPracticeClinicianPolicy,
} from "../src/legacy-import/orphan-sweep.js";
import {
  assertLocalBaseUrl,
  persistCredentials,
  reconciledAccessPolicy,
  resolvePracticeProjectId,
  samePolicyDefinition,
  type PracticeProjectResolutionDatabase,
} from "../../scripts/setup-legacy-importer.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
} from "../src/authz/roles.js";

const sourceBytes = new Uint8Array(1024 * 1024 + 17).fill(0x5a);
const source: LegacyMediaSource = {
  fileNameNew: "legacy-image-001.jpg",
  bytes: sourceBytes,
  contentType: "image/jpeg",
  patientReference: "Patient/11111111-1111-4111-8111-111111111111",
  encounterReference: "Encounter/22222222-2222-4222-8222-222222222222",
};
const binaryId = "33333333-3333-4333-8333-333333333333";

test("legacy importer local-base guard rejects private-network hosts", () => {
  for (const baseUrl of [
    "http://localhost:8103",
    "http://127.0.0.1:8103",
    "http://[::1]:8103",
    "http://medplum-server:8103",
  ]) {
    assert.doesNotThrow(() => assertLocalBaseUrl(baseUrl));
  }
  assert.throws(
    () => assertLocalBaseUrl("http://192.168.1.25:8103"),
    /restricted to a local self-hosted Medplum/,
  );
});

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
  assert.ok(observed?.signal instanceof AbortSignal);
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

test("migration Binary tag bypasses the genuine fhir-client Mandate 8 update guard", async () => {
  let observed: RequestInit | undefined;
  const fhir = createMedplumClient({
    baseUrl: "http://localhost:8103",
    accessToken: "token",
    audit: TEST_FHIR_AUDIT_RECORDER,
    auditContext: TEST_FHIR_AUDIT_CONTEXT,
  });
  const transport = Object.assign(fhir, {
    baseUrl: "http://localhost:8103",
    accessToken: "token",
    fetch: async (_url: URL | RequestInfo, init?: RequestInit) => {
      observed = init;
      const body = JSON.parse(String(init?.body)) as Binary;
      return fhirResponse({ ...body, meta: { ...body.meta, versionId: "2" } });
    },
  });

  const updated = await tagMigrationBinary({
    resourceType: "Binary",
    id: binaryId,
    meta: { versionId: "1" },
    contentType: source.contentType,
    securityContext: { reference: source.patientReference },
  }, transport);

  const body = JSON.parse(String(observed?.body)) as Binary;
  assert.equal(observed?.method, "PUT");
  assert.equal(headers(observed).get("if-match"), 'W/"1"');
  assert.equal(headers(observed).has("x-odos-binary-parser"), false);
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
  for (const resourceType of [
    "Condition",
    "AllergyIntolerance",
    "MedicationStatement",
    "Procedure",
  ]) {
    assert.deepEqual(rule(policy, resourceType).interaction, ["search", "read", "create"]);
  }
  assert.deepEqual(rule(policy, "Organization").interaction, ["search", "read", "create"]);
  assert.deepEqual(rule(policy, "Location").interaction, ["search", "read"]);
  const binaryRules = rules.filter((entry) => entry.resourceType === "Binary");
  const binaryDataRule = binaryRules.find((entry) => entry.interaction?.includes("create"));
  const binaryUpdateRule = binaryRules.find((entry) => entry.interaction?.includes("update"));
  assert.deepEqual(binaryDataRule?.interaction, ["read", "create", "delete"]);
  assert.deepEqual(binaryUpdateRule?.interaction, ["update"]);
  assert.ok(binaryUpdateRule?.readonlyFields?.includes("securityContext"));
  assert.equal(JSON.stringify(binaryRules).includes("search"), false);
  assert.deepEqual(
    policy.meta?.tag?.filter((tag) => tag.system === MIGRATION_IMPORTER_POLICY_TAG_SYSTEM),
    [{ system: MIGRATION_IMPORTER_POLICY_TAG_SYSTEM, code: MIGRATION_IMPORTER_POLICY_TAG_CODE }],
  );
  for (const entry of rules.filter((candidate) => candidate.resourceType !== "Binary")) {
    assert.equal(entry.interaction?.includes("delete"), false);
  }
});

test("migration importer policy reconciliation repairs its canonical tag and preserves unrelated tags", () => {
  const desired = buildMigrationImporterAccessPolicy("project-1");
  const drifted: AccessPolicy = {
    ...desired,
    meta: {
      ...desired.meta,
      tag: [
        { system: MIGRATION_IMPORTER_POLICY_TAG_SYSTEM, code: "wrong" },
        { system: "https://example.test/other", code: "preserved" },
      ],
    },
  };
  assert.equal(samePolicyDefinition(drifted, desired), false);
  const reconciled = reconciledAccessPolicy(drifted, desired);
  assert.equal(samePolicyDefinition(reconciled, desired), true);
  assert.ok(reconciled.meta?.tag?.some(
    (tag) => tag.system === "https://example.test/other" && tag.code === "preserved",
  ));
});

test("explicit practice project verification rejects a noncanonical clinician policy without discovery", async () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("clinician"));
  policy.resource![0]!.interaction = ["read"];
  let discoveryCalls = 0;
  const database: PracticeProjectResolutionDatabase = {
    findPracticeProjectId: async () => {
      discoveryCalls += 1;
      return "discovered-project";
    },
    verifyPracticeProjectClinicianPolicy: async () => storedPracticePolicy(policy),
  };
  const fhir = {
    search: async () => {
      throw new Error("Explicit project verification must not search or discover.");
    },
  } as unknown as ReturnType<typeof createMedplumClient>;

  await assert.rejects(
    resolvePracticeProjectId(
      "http://localhost:8103",
      "operator-token",
      fhir,
      "postgresql://local",
      "named-project",
      database,
    ),
    /does not carry a canonical ODOS Clinician policy/,
  );
  assert.equal(discoveryCalls, 0);
});

test("explicit practice project requires a PostgreSQL URL before verification", async () => {
  let verificationCalls = 0;
  const database: PracticeProjectResolutionDatabase = {
    findPracticeProjectId: async () => {
      throw new Error("Discovery must not run for an explicit project.");
    },
    verifyPracticeProjectClinicianPolicy: async () => {
      verificationCalls += 1;
      return storedPracticePolicy(
        buildMedplumAccessPolicy(getRoleDeclaration("clinician")),
      );
    },
  };
  const fhir = {
    search: async () => {
      throw new Error("FHIR search must not run for an explicit project.");
    },
  } as unknown as ReturnType<typeof createMedplumClient>;

  await assert.rejects(
    resolvePracticeProjectId(
      "http://localhost:8103",
      "operator-token",
      fhir,
      undefined,
      "named-project",
      database,
    ),
    /Explicit practiceProjectId verification requires ODOS_POSTGRES_URL/,
  );
  assert.equal(verificationCalls, 0);
});

test("single-practice callers without an explicit project keep database discovery", async () => {
  let discoveryCalls = 0;
  let verificationCalls = 0;
  const database: PracticeProjectResolutionDatabase = {
    findPracticeProjectId: async () => {
      discoveryCalls += 1;
      return "single-practice-project";
    },
    verifyPracticeProjectClinicianPolicy: async () => {
      verificationCalls += 1;
      return storedPracticePolicy(
        buildMedplumAccessPolicy(getRoleDeclaration("clinician")),
      );
    },
  };
  const fhir = {
    search: async () => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [],
    }),
  } as unknown as ReturnType<typeof createMedplumClient>;

  assert.equal(
    await resolvePracticeProjectId(
      "http://localhost:8103",
      "operator-token",
      fhir,
      "postgresql://local",
      undefined,
      database,
    ),
    "single-practice-project",
  );
  assert.equal(discoveryCalls, 1);
  assert.equal(verificationCalls, 0);
});

test("setup CLI entry point initializes its live database dependency and honors the explicit project env", () => {
  const root = new URL("../../", import.meta.url);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/setup-legacy-importer.ts"],
    {
      cwd: new URL(root).pathname,
      env: {
        ...process.env,
        MEDPLUM_BASE_URL: "http://127.0.0.1:8103",
        ODOS_OPERATOR_ACCESS_TOKEN: "synthetic-operator-token",
        ODOS_POSTGRES_URL: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
        ODOS_PRACTICE_PROJECT_ID: "explicit-cli-project",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ECONNREFUSED/);
  assert.doesNotMatch(
    result.stderr,
    /Cannot access 'LIVE_PRACTICE_PROJECT_DATABASE' before initialization/,
  );
  assert.doesNotMatch(result.stderr, /fetch failed/);
});

test("setup npm entry loads the env file and passes its explicit project to the real CLI", () => {
  const root = new URL("../../", import.meta.url);
  const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = packageJson.scripts["setup-legacy-importer"];
  assert.equal(
    command,
    "tsx --env-file-if-exists=.odos/migration-importer.env scripts/setup-legacy-importer.ts",
  );
  const directory = mkdtempSync(join(tmpdir(), "odos-importer-npm-"));
  try {
    mkdirSync(join(directory, ".odos"));
    mkdirSync(join(directory, "scripts"));
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "setup-legacy-importer-cli-test",
        private: true,
        type: "module",
        scripts: { "setup-legacy-importer": command },
      }),
    );
    writeFileSync(
      join(directory, "scripts", "setup-legacy-importer.ts"),
      readFileSync(new URL("scripts/setup-legacy-importer.ts", root), "utf8"),
    );
    symlinkSync(
      new URL("scripts/grant-migrated-patient-access.ts", root),
      join(directory, "scripts", "grant-migrated-patient-access.ts"),
    );
    symlinkSync(new URL("data", root), join(directory, "data"), "dir");
    symlinkSync(new URL("mcp", root), join(directory, "mcp"), "dir");
    symlinkSync(new URL("node_modules", root), join(directory, "node_modules"), "dir");
    const environmentPath = join(directory, ".odos", "migration-importer.env");
    writeFileSync(
      environmentPath,
      [
        "MEDPLUM_BASE_URL=http://127.0.0.1:8103",
        "ODOS_OPERATOR_ACCESS_TOKEN=synthetic-operator-token",
        "ODOS_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:1/postgres",
        "ODOS_PRACTICE_PROJECT_ID=explicit-npm-project",
        "",
      ].join("\n"),
    );
    chmodSync(environmentPath, 0o600);
    const {
      MEDPLUM_BASE_URL: _baseUrl,
      ODOS_OPERATOR_ACCESS_TOKEN: _operatorToken,
      ODOS_POSTGRES_URL: _postgresUrl,
      OSOD_POSTGRES_URL: _legacyPostgresUrl,
      ODOS_PRACTICE_PROJECT_ID: _practiceProjectId,
      ...cleanEnvironment
    } = process.env;

    const result = spawnSync("npm", ["run", "setup-legacy-importer"], {
      cwd: directory,
      env: cleanEnvironment,
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ECONNREFUSED/);
    assert.doesNotMatch(result.stderr, /ODOS_OPERATOR_ACCESS_TOKEN is required/);
    assert.doesNotMatch(
      result.stderr,
      /Cannot access 'LIVE_PRACTICE_PROJECT_DATABASE' before initialization/,
    );
    assert.doesNotMatch(result.stderr, /fetch failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistCredentials preserves operator-managed entries and enforces mode 0600", () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-importer-credentials-"));
  const credentialsPath = join(directory, "migration-importer.env");
  const statePath = join(directory, "migration-importer-state.json");
  try {
    writeFileSync(
      credentialsPath,
      [
        "# operator-managed migration settings",
        "MEDPLUM_BASE_URL=http://localhost:8103",
        "ODOS_POSTGRES_URL=postgresql://local-practice",
        "ODOS_PRACTICE_PROJECT_ID=practice-project",
        "ODOS_OPERATOR_ACCESS_TOKEN=short-lived-token",
        "ODOS_MIGRATION_IMPORTER_CLIENT_ID=old-client",
        "ODOS_MIGRATION_IMPORTER_CLIENT_SECRET=old-secret",
        "UNRELATED_KEY=preserved",
        "",
      ].join("\n"),
    );
    chmodSync(credentialsPath, 0o644);

    persistCredentials(
      { clientId: "new-client", clientSecret: "new-secret" },
      statePath,
      credentialsPath,
      "importer-policy",
      "practice-project",
    );

    const persisted = readFileSync(credentialsPath, "utf8");
    assert.match(persisted, /^# operator-managed migration settings$/m);
    assert.match(persisted, /^MEDPLUM_BASE_URL=http:\/\/localhost:8103$/m);
    assert.match(persisted, /^ODOS_POSTGRES_URL=postgresql:\/\/local-practice$/m);
    assert.match(persisted, /^ODOS_PRACTICE_PROJECT_ID=practice-project$/m);
    assert.match(persisted, /^ODOS_OPERATOR_ACCESS_TOKEN=short-lived-token$/m);
    assert.match(persisted, /^UNRELATED_KEY=preserved$/m);
    assert.doesNotMatch(persisted, /old-client|old-secret/);
    assert.equal(
      persisted.match(/^ODOS_MIGRATION_IMPORTER_CLIENT_ID=/gm)?.length,
      1,
    );
    assert.equal(
      persisted.match(/^ODOS_MIGRATION_IMPORTER_CLIENT_SECRET=/gm)?.length,
      1,
    );
    assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("duplicate clinician-policy diagnostic identifies identical definitions and zero-reference copies", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("clinician"));
  const first = {
    ...policy,
    id: "policy-referenced",
    meta: { ...policy.meta, versionId: "1", lastUpdated: "2026-07-31T12:00:00Z" },
  };
  const second = {
    ...policy,
    id: "policy-unreferenced",
    meta: { ...policy.meta, versionId: "2", lastUpdated: "2026-07-31T12:05:00Z" },
  };

  const description = describeStoredClinicianPolicyConflict([
    {
      policyId: "policy-referenced",
      policy: JSON.stringify(first),
      membershipReferenceCount: 2,
    },
    {
      policyId: "policy-unreferenced",
      policy: JSON.stringify(second),
      membershipReferenceCount: 0,
    },
  ]);

  assert.match(description, /Policy definitions identical: yes/);
  assert.match(
    description,
    /ProjectMembership references by policy: policy-referenced=2, policy-unreferenced=0/,
  );
  assert.match(
    description,
    /Policies with zero ProjectMembership references: policy-unreferenced/,
  );
});

test("duplicate clinician-policy diagnostic reports definition drift without choosing a copy", () => {
  const canonical = buildMedplumAccessPolicy(getRoleDeclaration("clinician"));
  const drifted = structuredClone(canonical);
  drifted.resource![0]!.interaction = ["read"];

  const description = describeStoredClinicianPolicyConflict([
    {
      policyId: "policy-a",
      policy: JSON.stringify(canonical),
      membershipReferenceCount: 1,
    },
    {
      policyId: "policy-b",
      policy: JSON.stringify(drifted),
      membershipReferenceCount: 1,
    },
  ]);

  assert.match(description, /Policy definitions identical: no/);
  assert.match(description, /Policies with zero ProjectMembership references: none/);
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

function storedPracticePolicy(policy: AccessPolicy): StoredPracticeClinicianPolicy {
  return {
    projectId: "named-project",
    projectName: "Named Practice",
    policyId: "clinician-policy",
    policy,
  };
}

test("post-response/pre-Media crash leaves an open attempt carrying the Binary id", async () => {
  const attempts = new MemoryAttemptStore();
  const uploaded = await uploadMigrationBinary({
    source,
    attempts,
    fhir: new MemoryMediaFhir(),
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

test("completed Media recovery converges for intact versioned Binary references", async (t) => {
  for (const [name, url, expectedFetchUrl] of [
    [
      "relative",
      `Binary/${binaryId}/_history/7`,
      `http://localhost:8103/fhir/R4/Binary/${binaryId}/_history/7`,
    ],
    [
      "absolute",
      `http://localhost:8103/fhir/R4/Binary/${binaryId}/_history/7`,
      `http://localhost:8103/fhir/R4/Binary/${binaryId}/_history/7`,
    ],
    [
      "root-relative",
      `/fhir/R4/Binary/${binaryId}/_history/7`,
      `http://localhost:8103/fhir/R4/Binary/${binaryId}/_history/7`,
    ],
  ] as const) {
    await t.test(name, async () => {
      const attempts = await openAttempt(binaryId);
      let posts = 0;
      const fetchedUrls: string[] = [];
      const result = await recoverLegacyMedia({
        source,
        fhir: new MemoryMediaFhir(media("completed", url)),
        attempts,
        auth: {
          baseUrl: "http://localhost:8103",
          accessToken: "token",
          fetch: async (requestUrl, init) => {
            if (init?.method === "POST") posts += 1;
            else fetchedUrls.push(String(requestUrl));
            return new Response(sourceBytes);
          },
        },
      });
      assert.equal(result.action, "skipped-verified");
      assert.equal(result.binaryId, binaryId);
      assert.equal(posts, 0);
      assert.deepEqual(fetchedUrls, [expectedFetchUrl]);
      assert.equal(attempts.rows[0]?.status, "resolved-attached");
    });
  }
});

test("orphan sweep detects every Binary URL form through the database scanner and fails closed", async (t) => {
  const cases = [
    ["relative", `Binary/${binaryId}`],
    ["absolute", `https://any-host.example/fhir/R4/Binary/${binaryId}`],
    ["versioned", `Binary/${binaryId}/_history/7`],
    ["absolute versioned", `https://other.example/fhir/R4/Binary/${binaryId}/_history/7`],
    ["unparseable", `Binary/${binaryId}/not-a-valid-fhir-reference`],
  ] as const;
  for (const [name, url] of cases) {
    await t.test(name, async () => {
      const attempts = await openAttempt(binaryId);
      const database = new FakeBinaryReferenceDatabase([{
        id: `doc-${name}`,
        content: JSON.stringify({
          resourceType: "DocumentReference",
          content: [{ attachment: { url } }],
        }),
      }]);
      const scanner = new PgBinaryReferenceScanner({ pool: database });
      let deleted = false;
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
      assert.equal(results[0]?.references[0]?.url, url);
      assert.equal(database.tableDiscoveryQueries, 1);
      assert.equal(database.contentQueries, 1);
      assert.equal(deleted, false);
    });
  }
});

test("orphan sweep rechecks immediately before deletion and fails closed on a new reference", async () => {
  const attempts = await openAttempt(binaryId);
  let scans = 0;
  let deleted = false;
  const scanner: BinaryReferenceScanner = {
    findAttachmentReferences: async (binaryIds) => {
      scans += 1;
      return new Map(binaryIds.map((id) => [
        id,
        scans === 1
          ? []
          : [{ table: "Media", resourceId: "media-raced", url: `Binary/${id}` }],
      ]));
    },
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
  assert.equal(scans, 2);
  assert.equal(results[0]?.outcome, "reported-referenced");
  assert.equal(results[0]?.references[0]?.resourceId, "media-raced");
  assert.equal(deleted, false);
});

test("orphan sweep batches multiple open Binary ids into one table discovery and one table query", async () => {
  const secondBinaryId = "66666666-6666-4666-8666-666666666666";
  const attempts = await openAttempt(binaryId);
  const second = await attempts.open({
    sourceFilename: "legacy-image-002.jpg",
    patientReference: source.patientReference,
  });
  await attempts.recordReturned(second.attemptId, secondBinaryId);
  const database = new FakeBinaryReferenceDatabase([{
    id: "doc-batch",
    content: JSON.stringify({
      resourceType: "DocumentReference",
      content: [
        { attachment: { url: `Binary/${binaryId}` } },
        { attachment: { url: `https://host.example/fhir/R4/Binary/${secondBinaryId}` } },
      ],
    }),
  }]);
  const scanner = new PgBinaryReferenceScanner({ pool: database });
  const results = await sweepLegacyImportBinaries({
    attempts,
    scanner,
    auth: { baseUrl: "http://localhost:8103", accessToken: "token" },
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.outcome === "reported-referenced"));
  assert.equal(database.tableDiscoveryQueries, 1);
  assert.equal(database.contentQueries, 1);
});

test("orphan sweep treats a re-verification error as referenced and never deletes", async () => {
  const attempts = await openAttempt(binaryId);
  let scans = 0;
  let deleted = false;
  const scanner: BinaryReferenceScanner = {
    findAttachmentReferences: async (binaryIds) => {
      scans += 1;
      if (scans === 2) throw new Error("database unavailable");
      return new Map(binaryIds.map((id) => [id, []]));
    },
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
  assert.match(results[0]?.reverificationError ?? "", /database unavailable/);
  assert.equal(deleted, false);
});

test("transient attachment verification failure never triggers corrupt replacement", async () => {
  const attempts = new MemoryAttemptStore();
  let posts = 0;
  await assert.rejects(
    recoverLegacyMedia({
      source,
      attempts,
      fhir: new MemoryMediaFhir(media("completed", `Binary/${binaryId}`)),
      auth: {
        baseUrl: "http://localhost:8103",
        accessToken: "token",
        fetch: async (_url, init) => {
          if (init?.method === "POST") posts += 1;
          return new Response(null, { status: 503, statusText: "Unavailable" });
        },
      },
    }),
    /verification failed transiently: 503/,
  );
  assert.equal(posts, 0);
  assert.equal(attempts.rows.length, 0);
});

test("recovery never fetches an untrusted attachment origin", async () => {
  const attempts = new MemoryAttemptStore();
  const requestedUrls: string[] = [];
  const replacementId = "77777777-7777-4777-8777-777777777777";
  const fhir = new MemoryMediaFhir(media(
    "completed",
    `http://169.254.169.254/latest/meta-data/${binaryId}`,
  ));
  const result = await recoverLegacyMedia({
    source,
    attempts,
    fhir,
    auth: {
      baseUrl: "http://localhost:8103",
      accessToken: "token",
      fetch: async (url, init) => {
        requestedUrls.push(String(url));
        if (init?.method === "POST") return fhirResponse(binary(replacementId, "1"), 201);
        if (init?.method === "PUT") return fhirResponse(binary(replacementId, "2"));
        return new Response(sourceBytes, { status: 200 });
      },
    },
  });
  assert.equal(result.action, "replaced-corrupt");
  assert.equal(requestedUrls.some((url) => url.startsWith("http://169.254.169.254")), false);
  assert.equal(requestedUrls.filter((url) => url.endsWith("/fhir/R4/Binary")).length, 1);
  assert.equal(attempts.rows[0]?.status, "resolved-attached");
});

test("destructive scripts refuse before authentication without explicit opt-in", () => {
  const root = new URL("../../", import.meta.url);
  for (const script of [
    "scripts/sweep-legacy-import-binaries.ts",
    "scripts/verify-legacy-import-m0.ts",
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", script, ...(script.includes("sweep") ? ["--execute"] : [])],
      {
        cwd: new URL(root).pathname,
        env: {
          ...process.env,
          ODOS_SWEEP_ALLOW_DESTRUCTIVE: "",
          ODOS_ACCEPTANCE_ALLOW_DESTRUCTIVE: "",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing (Binary disposal|destructive legacy-import acceptance)/);
    assert.doesNotMatch(result.stderr, /ODOS_MIGRATION_IMPORTER_CLIENT_ID is required/);
  }
});

test("tracked config, compose init, and inline-limit strings remain truthful", () => {
  const root = new URL("../../", import.meta.url);
  const config = JSON.parse(readFileSync(new URL("medplum.config.json", root), "utf8")) as Record<string, string>;
  const drill = JSON.parse(readFileSync(new URL("medplum.dr-drill.config.json", root), "utf8")) as Record<string, string>;
  assert.equal(config.signingKey, "INERT_ENV_OVERLAY_REQUIRED");
  assert.equal(drill.signingKey, "INERT_ENV_OVERLAY_REQUIRED");
  const mainCompose = readFileSync(new URL("docker-compose.yml", root), "utf8");
  const drillCompose = readFileSync(new URL("docker-compose.dr-drill.yml", root), "utf8");
  const envExample = readFileSync(new URL(".env.example", root), "utf8");
  const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
  assert.match(
    envExample,
    /^# MEDPLUM_STORAGE_BASE_URL=http:\/\/localhost:8103\/storage\/$/m,
  );
  assert.match(
    mainCompose,
    /MEDPLUM_STORAGE_BASE_URL: \$\{MEDPLUM_STORAGE_BASE_URL:-http:\/\/localhost:8103\/storage\/\}/,
  );
  for (const compose of [mainCompose, drillCompose]) {
    assert.match(compose, /medplum-binary-init:/);
    assert.match(compose, /"1000:1000"/);
    assert.match(compose, /service_completed_successfully/);
    assert.match(compose, /file:\/config\/medplum\.config\.json,env/);
  }
  assert.ok(
    ci.indexOf("npm run generate-medplum-signing-keys")
      < ci.indexOf("start Medplum contract backend"),
  );
  for (const path of [
    "mcp/src/clinical-graph/imaging-endpoint.ts",
    "ui/src/components/charting/ImagingSection.tsx",
    "ui/src/components/LongitudinalImagingCard.tsx",
  ]) {
    const content = readFileSync(new URL(path, root), "utf8");
    assert.match(content, /(?:^|[^\d])15 MB(?:$|[^\d])|(?:^|[^\d])15 \* 1024 \* 1024(?:$|[^\d])/m);
  }
  const meibography = readFileSync(
    new URL("mcp/src/clinical-graph/dry-eye-meibography-endpoint.ts", root),
    "utf8",
  );
  assert.doesNotMatch(meibography, /(?:^|[^\d])15 MB(?:$|[^\d])|(?:^|[^\d])15 \* 1024 \* 1024(?:$|[^\d])/m);
  assert.match(meibography, /(?:^|[^\d])1 MB(?:$|[^\d])|(?:^|[^\d])1 \* 1024 \* 1024(?:$|[^\d])/m);
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

class FakeBinaryReferenceDatabase implements BinaryReferenceDatabase {
  tableDiscoveryQueries = 0;
  contentQueries = 0;

  constructor(
    private readonly documentRows: Array<{ id: string; content: string }>,
  ) {}

  async query<T>(text: string): Promise<{ rows: T[]; rowCount: number }> {
    if (text.includes("information_schema.columns")) {
      this.tableDiscoveryQueries += 1;
      return {
        rows: [{ table_name: "DocumentReference" }] as T[],
        rowCount: 1,
      };
    }
    if (text.includes('FROM "DocumentReference"')) {
      this.contentQueries += 1;
      return {
        rows: this.documentRows as T[],
        rowCount: this.documentRows.length,
      };
    }
    if (text.includes('FROM "Binary"')) {
      return { rows: [{ exists: 1 }] as T[], rowCount: 1 };
    }
    throw new Error(`Unexpected fake database query: ${text}`);
  }

  async end(): Promise<void> {}
}

async function openAttempt(nextBinaryId: string): Promise<MemoryAttemptStore> {
  const attempts = new MemoryAttemptStore();
  const opened = await attempts.open({
    sourceFilename: source.fileNameNew,
    patientReference: source.patientReference,
  });
  await attempts.recordReturned(opened.attemptId, nextBinaryId);
  return attempts;
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
