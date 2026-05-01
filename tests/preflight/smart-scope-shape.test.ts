import assert from "node:assert/strict";
import { test } from "node:test";
import { runVendorCanonicalShapePass } from "../../scripts/preflight-lint.ts";

test("v0.55a Pass 4 accepts SMART v2 granular scope strings", () => {
  const validScope = ["patient", "Observation.rs"].join("/");
  const result = runVendorCanonicalShapePass({
    files: [{ path: "smart-valid.ts", text: `const scope = ${JSON.stringify(validScope)};\n` }],
  });
  assert.equal(result.status, "pass");
});

test("v0.55a Pass 4 warns on SMART v1 legacy scope strings", () => {
  const legacyScope = ["patient", "Observation.read"].join("/");
  const result = runVendorCanonicalShapePass({
    files: [{ path: "smart-legacy.ts", text: `const scope = ${JSON.stringify(legacyScope)};\n` }],
  });
  assert.equal(result.status, "warning");
  assert.equal(result.findings[0]?.code, "smart-scope-v1-legacy");
});

test("v0.55a Pass 4 hard-blocks malformed SMART scope strings", () => {
  const invalidCases = [
    ["patient", "observation.rs"].join("/"),
    ["patient", "Observation.rx"].join("/"),
    ["patient", "Observation"].join("/"),
  ];

  for (const invalidScope of invalidCases) {
    const result = runVendorCanonicalShapePass({
      files: [{ path: "smart-invalid.ts", text: `const scope = ${JSON.stringify(invalidScope)};\n` }],
    });
    assert.equal(result.status, "hard-block", invalidScope);
    assert.equal(result.findings[0]?.code, "smart-scope-invalid");
  }
});

test("v0.55a Pass 4 ignores non-SMART strings without prefix", () => {
  const result = runVendorCanonicalShapePass({
    files: [{ path: "not-smart.ts", text: `const scope = "Observation.rs";\n` }],
  });
  assert.equal(result.status, "pass");
});
