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
