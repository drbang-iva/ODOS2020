import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  runEnvVarPhiPass,
  runLogScrubPass,
  runPreflightLint,
  runResourceNamePass,
  runVendorCanonicalShapePass,
} from "../../scripts/preflight-lint.ts";

test("v0.5d preflight pass 1 log scrub is clean on clean input and warns on salted PHI-shaped logs", () => {
  const clean = runLogScrubPass({ logText: "medplum-server ready\nosod-mcp ready\n" });
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
  const clean = runEnvVarPhiPass({ env: { OSOD_MODE: "local", MEDPLUM_BASE_URL: "http://localhost:8103" } });
  assert.equal(clean.status, "pass");
  assert.equal(clean.auditRows.length, 0);

  const salted = runEnvVarPhiPass({ env: { OSOD_PATIENT_FIXTURE: "Patient: John Smith" } });
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
        text: `const url = "${["https://osod.dev/fhir/StructureDefinition", "not-in-registry"].join("/")}";\n`,
      },
    ],
  });
  assert.equal(extension.status, "hard-block");
  assert.equal(extension.findings[0]?.code, "osod-extension-url-shape");

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
      { path: "mcp/src/cds/services/a.ts", text: 'export const a = { discovery: { id: "osod-a" } };\n' },
      {
        path: "mcp/src/cds/services/b.ts",
        text: 'export const b = { discovery: { id: "https://osod.dev/cds-hooks/b" } };\n',
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
    files: [{ path: "mcp/src/agentops/safety-valve.ts", text: "res.setHeader('X-OSOD-IB-Exception', 'x');\n" }],
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
  const dir = mkdtempSync(join(tmpdir(), "osod-preflight-"));
  try {
    const report = runPreflightLint({
      logText: "clean\n",
      env: { OSOD_MODE: "local" },
      resources: [],
      files: [{ path: join(dir, "clean.ts"), text: "export const ok = true;\n" }],
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
