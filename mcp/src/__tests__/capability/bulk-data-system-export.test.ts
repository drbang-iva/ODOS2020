import assert from "node:assert/strict";
import { test } from "node:test";
import {
  synthesizeCapabilityStatement,
  type CapabilityStatementRule,
} from "../../capability/capability-statement-synthesizer.js";

test("CapabilityStatement suppresses optional System export unless locally enabled", () => {
  const rules: CapabilityStatementRule[] = [
    {
      claim_path: "rest[0].operation[?(@.name=='export-system')]",
      claim_description: "System export operation",
      backing_test: "mcp/src/__tests__/capability/bulk-data-system-export.test.ts",
      test_result_required: "passing",
      required_for_certification: false,
      certification_anchor: "§170.215(d)(1) System export optional",
    },
  ];
  const testResults = {
    generated_at: "2026-05-05T00:00:00.000Z",
    results: { "mcp/src/__tests__/capability/bulk-data-system-export.test.ts": "passing" as const },
  };
  const suppressed = synthesizeCapabilityStatement({
    baseUrl: "https://practice.example/fhir/R4",
    rules,
    testResults,
  });
  assert.equal(suppressed.capabilityStatement.rest?.[0]?.operation?.some((operation) => operation.name === "export-system"), false);

  const emitted = synthesizeCapabilityStatement({
    baseUrl: "https://practice.example/fhir/R4",
    rules,
    testResults,
    systemExportEnabled: true,
  });
  assert.equal(emitted.capabilityStatement.rest?.[0]?.operation?.some((operation) => operation.name === "export-system"), true);
});
