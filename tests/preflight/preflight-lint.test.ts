import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DIRECT_MEDPLUM_FHIR_BYPASS_ALLOWLIST,
  runEnvVarPhiPass,
  runAppearanceStylingDebtPass,
  runLogScrubPass,
  runPreflightLint,
  runResourceNamePass,
  runVendorCanonicalShapePass,
} from "../../scripts/preflight-lint.ts";

test("appearance styling debt ratchet blocks new and increased debt while allowing the baseline", () => {
  const baseline = { "ui/src/existing.tsx": 1 };
  const withinBaseline = runAppearanceStylingDebtPass({
    appearanceDebtBaseline: baseline,
    appearanceDebtFiles: [{ path: "ui/src/existing.tsx", text: '<div className="text-white" />\n' }],
  });
  assert.equal(withinBaseline.status, "pass");

  const newFile = runAppearanceStylingDebtPass({
    appearanceDebtBaseline: baseline,
    appearanceDebtFiles: [
      { path: "ui/src/existing.tsx", text: '<div className="text-white" />\n' },
      { path: "ui/src/new.tsx", text: '<div className="text-white" />\n' },
    ],
  });
  assert.equal(newFile.status, "hard-block");
  assert.equal(newFile.findings[0]?.code, "appearance-debt-new-file");

  const overBaseline = runAppearanceStylingDebtPass({
    appearanceDebtBaseline: baseline,
    appearanceDebtFiles: [{ path: "ui/src/existing.tsx", text: '<div className="text-white bg-black" />\n' }],
  });
  assert.equal(overBaseline.status, "hard-block");
  assert.equal(overBaseline.findings[0]?.code, "appearance-debt-increase");
});

test("v0.5d preflight pass 1 log scrub is clean on clean input and warns on salted PHI-shaped logs", () => {
  const clean = runLogScrubPass({ logText: "medplum-server ready\nodos-mcp ready\n" });
  assert.equal(clean.status, "pass");
  assert.equal(clean.findings.length, 0);

  const salted = runLogScrubPass({
    source: "salted-stack.log",
    logText: "medplum-server Patient: John Smith MRN123456 requested chart\n",
  });
  assert.equal(salted.status, "warning");
  assert.equal(salted.findings.some((finding) => finding.source === "salted-stack.log"), true);
});

test("v0.5d preflight pass 2 resource-name lint warns on a Binary title with PHI-shaped text", () => {
  const clean = runResourceNamePass({
    resources: [{ resourceType: "Binary", id: "clean", title: "opaque-parser-upload-1" }],
  });
  assert.equal(clean.status, "pass");

  const salted = runResourceNamePass({
    resources: [{ resourceType: "Binary", id: "salted", title: "retina image John Smith" }],
  });
  assert.equal(salted.status, "warning");
  assert.equal(salted.findings[0]?.source, "Binary/salted");
});

test("v0.5d preflight pass 3 env-var PHI check hard-blocks and emits a preflight-block audit row", () => {
  const clean = runEnvVarPhiPass({ env: { ODOS_MODE: "local", MEDPLUM_BASE_URL: "http://localhost:8103" } });
  assert.equal(clean.status, "pass");
  assert.equal(clean.auditRows.length, 0);

  const salted = runEnvVarPhiPass({ env: { ODOS_PATIENT_FIXTURE: "Patient: John Smith" } });
  assert.equal(salted.status, "hard-block");
  assert.equal(salted.findings[0]?.severity, "hard-block");
  assert.equal(salted.auditRows[0]?.eventType, "preflight-block");
  assert.equal(salted.auditRows[0]?.actorId, "preflight-linter");
  assert.equal(salted.auditRows[0]?.actorRole, "system");
});

test("v0.5d preflight pass 4 source-tree canonical-shape lint passes live tree and fails salted fixture", () => {
  const live = runVendorCanonicalShapePass();
  assert.equal(live.status, "pass", live.findings.map((finding) => `${finding.source}:${finding.line} ${finding.code}`).join("\n"));

  const forbiddenShape = ["Observation", ".attestation"].join("");
  const salted = runVendorCanonicalShapePass({
    files: [{ path: "salted.ts", text: `const x = ${JSON.stringify(forbiddenShape)};\n` }],
  });
  assert.equal(salted.status, "hard-block");
  assert.equal(salted.findings[0]?.code, "observation-attestation-property");
});

test("preflight fences direct FHIR HTTP and both named client escape hatches", () => {
  assert.deepEqual(DIRECT_MEDPLUM_FHIR_BYPASS_ALLOWLIST, [
    "mcp/src/smart/registration/dynamic-client-registration.ts",
    "mcp/src/legacy-import/orphan-sweep.ts",
    "mcp/src/legacy-import/binary-transport.ts",
    "mcp/src/fhir/binary-upload.ts",
  ]);

  const directHttp = runVendorCanonicalShapePass({
    files: [{ path: "mcp/src/bad-request.ts", text: 'await fetch(`${base}/fhir/R4/Patient`);\n' }],
  });
  assert.equal(directHttp.status, "hard-block");
  assert.equal(directHttp.findings[0]?.code, "direct-medplum-http-request");

  const bootFactory = ["createUnauditedMedplumClient", "_bootOnly"].join("");
  const bootOnly = runVendorCanonicalShapePass({
    files: [{ path: "mcp/src/request-handler.ts", text: `${bootFactory}({ baseUrl });\n` }],
  });
  assert.equal(bootOnly.status, "hard-block");
  assert.equal(bootOnly.findings[0]?.code, `${bootFactory}-scope`);

  const operatorFactory = ["createOperatorScript", "FhirClient"].join("");
  const operator = runVendorCanonicalShapePass({
    files: [{ path: "mcp/src/request-handler.ts", text: `${operatorFactory}({ baseUrl, reason: "bad" });\n` }],
  });
  assert.equal(operator.status, "hard-block");
  assert.equal(operator.findings[0]?.code, `${operatorFactory}-scope`);
});

test("capability test base URLs do not trip the direct FHIR HTTP fence", () => {
  const capability = runVendorCanonicalShapePass({
    files: [{
      path: "mcp/src/__tests__/capability/patient-read.test.ts",
      text: 'const baseUrl = "https://practice.example/fhir/R4";\n',
    }],
  });
  assert.equal(
    capability.findings.some((finding) => finding.code === "direct-medplum-http-request"),
    false,
  );
});

test("preflight requires every live audit migration to declare a sentinel", () => {
  const salted = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/authz/liveAudit.ts",
        text: `
          const AUDIT_DDL_FILES = [
            { path: migrationPath("migration-with-sentinel.sql"), sentinel: { kind: "table", table: "present" } },
            { path: migrationPath("migration-without-sentinel.sql") },
          ] satisfies readonly AuditDdlFile[];
        `,
      },
    ],
  });
  assert.equal(salted.status, "hard-block");
  assert.deepEqual(
    salted.findings.map((finding) => finding.code),
    ["audit-migration-sentinel-required"],
  );
  assert.match(salted.findings[0]!.message, /migration-without-sentinel\.sql/);
});

test("v0.55b preflight pass 4 hard-blocks smart app registry boundary fixtures", () => {
  const clientAppShape = ["Client", "Application"].join("");
  const clientApp = runVendorCanonicalShapePass({
    files: [{ path: "mcp/src/bad.ts", text: `const x = ${JSON.stringify(clientAppShape)};\n` }],
  });
  assert.equal(clientApp.status, "hard-block");
  assert.equal(clientApp.findings[0]?.code, "client-application-boundary");

  const extension = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/bad.ts",
        text: `const url = "${["https://odos2020.com/fhir/StructureDefinition", "not-in-registry"].join("/")}";\n`,
      },
    ],
  });
  assert.equal(extension.status, "hard-block");
  assert.equal(extension.findings[0]?.code, "odos-extension-url-shape");

  const migration = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/bad.ts",
        text: [
          "await Promise",
          ".all(",
          ["MIGRATION", "PATHS"].join("_"),
          ".map(runMigration));\n",
        ].join(""),
      },
    ],
  });
  assert.equal(migration.status, "hard-block");
  assert.equal(migration.findings[0]?.code, "promise-all-migration");
});

test("v0.55c preflight pass 4 hard-blocks CDS hook and copy boundary fixtures", () => {
  const mixedHookIds = runVendorCanonicalShapePass({
    files: [
      { path: "mcp/src/cds/services/a.ts", text: 'export const a = { discovery: { id: "odos-a" } };\n' },
      {
        path: "mcp/src/cds/services/b.ts",
        text: 'export const b = { discovery: { id: "https://odos2020.com/cds-hooks/b" } };\n',
      },
    ],
  });
  assert.equal(mixedHookIds.status, "hard-block");
  assert.equal(mixedHookIds.findings[0]?.code, "hook-id-format");

  const missingDsiFields = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/cds/services/bad.ts",
        text: "export const card = { cards: [{ summary: 'x', indicator: 'info', source: { label: 'x' } }] };\n",
      },
    ],
  });
  assert.equal(missingDsiFields.status, "hard-block");
  assert.equal(missingDsiFields.findings[0]?.code, "hti-1-dsi-card-schema");

  const copy = runVendorCanonicalShapePass({
    files: [{ path: "README.md", text: "Use the approved CDS vendor for external services.\n" }],
  });
  assert.equal(copy.status, "hard-block");
  assert.equal(copy.findings[0]?.code, "external-cds-services-superlative-block");
});

test("v0.55d preflight pass 4 hard-blocks AgentOps policy and naming fixtures", () => {
  const badPolicy = runVendorCanonicalShapePass({
    files: [
      {
        path: "data/agentops-policies/defaults/bad.yaml",
        text: [
          "policies:",
          "  - rule_id: bad",
          "    rule_version: 2026-05-04",
          "    composite_key:",
          "      tool_name: bad",
          "      target_resourceType: Observation",
          "      specific_action: write",
          "      clinical_billing_patient_facing_impact: clinical",
          "    threshold_class: HIGH",
          "    agent_scope: any-agent",
          "    effective_from: 2026-05-04",
          "    effective_to: null",
          "    rationale: missing initiation mode",
          "    on_violation:",
          "      verdict: confirmation-required",
          "      escalation_target: staged-admin-review",
          "retention:",
          "  retention_years: 7",
        ].join("\n"),
      },
    ],
  });
  assert.equal(badPolicy.status, "hard-block");
  assert.equal(badPolicy.findings[0]?.code, "agentops-policy-schema");

  const alias = runVendorCanonicalShapePass({
    files: [{ path: "mcp/src/agentops/bad.ts", text: "const init_mode = 'x';\n" }],
  });
  assert.equal(alias.status, "hard-block");
  assert.equal(alias.findings[0]?.code, "agentops-initiation-mode-canonical-name");
});

test("v0.55d preflight pass 4 hard-blocks AgentOps response and AIAST fixtures", () => {
  const aiast = runVendorCanonicalShapePass({
    files: [{ path: "mcp/src/agentops/bad.ts", text: "const coding = { code: 'AIAST' };\n" }],
  });
  assert.equal(aiast.status, "hard-block");
  assert.equal(aiast.findings[0]?.code, "agentops-aiast-system-uri-required");

  const leak = runVendorCanonicalShapePass({
    files: [{ path: "mcp/src/agentops/safety-valve.ts", text: "res.setHeader('X-ODOS-IB-Exception', 'x');\n" }],
  });
  assert.equal(leak.status, "hard-block");
  assert.equal(leak.findings[0]?.code, "agentops-safety-valve-no-protectingcareaccess-leak");

  const network = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/agentops/runtime/supervisor.ts",
        text: [["ipt", "ables"].join(""), " --uid-owner 501\n"].join(""),
      },
    ],
  });
  assert.equal(network.status, "hard-block");
  assert.equal(network.findings[0]?.code, "agentops-dual-container-network-namespace-required");
});

test("preflight rejects Docker NODE_OPTIONS that would block Node before application startup", () => {
  const linterMajor = Number.parseInt(process.versions.node, 10);
  const fixtureMajor = linterMajor === 20 ? 22 : 20;
  const fixtureImage = `node:${fixtureMajor}-alpine`;
  const fixtureFlags = (image: string, major: number): ReadonlySet<string> | undefined =>
    image === fixtureImage && major === fixtureMajor ? new Set(["--fixture-runtime-flag"]) : undefined;
  const removedNetworkImports = runVendorCanonicalShapePass({
    files: [{
      path: "docker-compose.yml",
      text: `services:\n  worker:\n    image: node:${linterMajor}-alpine\n    environment:\n      NODE_OPTIONS: --experimental-network-imports=false\n`,
    }],
    nodeEnvironmentFlagsForImage: () => process.allowedNodeEnvironmentFlags,
  });
  assert.equal(removedNetworkImports.status, "hard-block");
  assert.equal(removedNetworkImports.findings[0]?.code, "compose-node-options-runtime-unsupported");

  const invalid = runVendorCanonicalShapePass({
    files: [{
      path: "deploy/docker-compose.agentops.yml",
      text: `services:\n  worker:\n    image: ${fixtureImage}\n    environment:\n      NODE_OPTIONS: --no-warnings\n`,
    }],
    nodeEnvironmentFlagsForImage: fixtureFlags,
  });
  assert.equal(invalid.status, "hard-block");
  assert.equal(invalid.findings[0]?.code, "compose-node-options-runtime-unsupported");
  assert.equal(invalid.findings[0]?.source, "deploy/docker-compose.agentops.yml");

  const valid = runVendorCanonicalShapePass({
    files: [{
      path: "compose.worker.yaml",
      text: `services:\n  worker:\n    image: ${fixtureImage}\n    environment:\n      - NODE_OPTIONS=--fixture-runtime-flag\n`,
    }],
    nodeEnvironmentFlagsForImage: fixtureFlags,
  });
  assert.equal(valid.status, "pass");

  const floatingImage = runVendorCanonicalShapePass({
    files: [{
      path: "docker-compose.future.yml",
      text: "services:\n  worker:\n    image: node:alpine\n    environment:\n      NODE_OPTIONS: --no-warnings\n",
    }],
  });
  assert.equal(floatingImage.status, "hard-block");
  assert.equal(floatingImage.findings[0]?.code, "compose-node-options-runtime-undetermined");

  const unavailableRuntime = runVendorCanonicalShapePass({
    files: [{
      path: "docker-compose.future.yml",
      text: `services:\n  worker:\n    image: node:${fixtureMajor}-alpine\n    environment:\n      NODE_OPTIONS: --fixture-runtime-flag\n`,
    }],
    nodeEnvironmentFlagsForImage: () => undefined,
  });
  assert.equal(unavailableRuntime.status, "hard-block");
  assert.equal(unavailableRuntime.findings[0]?.code, "compose-node-options-runtime-unavailable");
});

test("v0.55e preflight pass 4 hard-blocks Bulk Data job ID, endpoint, and meta-security fixtures", () => {
  const predictableJobId = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/bulk-data/job-id-generator.ts",
        text: "export function generateBulkExportJobId(patientName: string) { const id = patientName; return id; }\n",
      },
    ],
  });
  assert.equal(predictableJobId.status, "hard-block");
  assert.equal(predictableJobId.findings[0]?.code, "bulk-data-no-phi-in-job-id");

  const singlePatientExport = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/bulk-data/router.ts",
        text: 'router.get("/Patient/:id/$export", handler);\n',
      },
    ],
  });
  assert.equal(singlePatientExport.status, "hard-block");
  assert.equal(singlePatientExport.findings[0]?.code, "bulk-data-export-endpoint-shape");

  const strippedSecurity = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/bulk-data/output/bad.ts",
        text: "delete resource.meta.security;\n",
      },
    ],
  });
  assert.equal(strippedSecurity.status, "hard-block");
  assert.equal(strippedSecurity.findings[0]?.code, "meta-security-preservation-on-ndjson-output");
});

test("v0.55e preflight pass 4 enforces CapabilityStatement claim backing tests and audit-event counts", () => {
  const missingCapabilityTest = runVendorCanonicalShapePass({
    files: [
      {
        path: "data/canonical-extensions/capability-statement-rules.json",
        text: JSON.stringify({
          rules: [
            {
              claim_path: "rest[0].operation[?(@.name=='export-group')]",
              backing_test: "mcp/src/__tests__/capability/missing.test.ts",
              required_for_certification: true,
            },
          ],
        }),
      },
    ],
  });
  assert.equal(missingCapabilityTest.status, "hard-block");
  assert.equal(missingCapabilityTest.findings[0]?.code, "capability-statement-claim-must-have-test");

  const mismatchedCount = runVendorCanonicalShapePass({
    files: [
      {
        path: "docs/build-log/bad.md",
        text: ["Adds 2 new event types:", "- `one`", "- `two`", "- `three`"].join("\n"),
      },
    ],
  });
  assert.equal(mismatchedCount.status, "hard-block");
  assert.equal(mismatchedCount.findings[0]?.code, "audit-event-count-vs-list-consistency");
});

test("v0.5d preflight aggregate writes structured reports when requested", () => {
  const dir = mkdtempSync(join(tmpdir(), "odos-preflight-"));
  try {
    const report = runPreflightLint({
      logText: "clean\n",
      env: { ODOS_MODE: "local" },
      resources: [],
      files: [{ path: join(dir, "clean.ts"), text: "export const ok = true;\n" }],
      appearanceDebtFiles: [],
      appearanceDebtBaseline: {},
      writeReports: false,
      now: "2026-04-30T00:00:00.000Z",
    });
    assert.equal(report.summary.warnings, 0);
    assert.equal(report.summary.hardBlocks, 0);
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
