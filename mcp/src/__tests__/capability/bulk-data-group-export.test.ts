import assert from "node:assert/strict";
import { test } from "node:test";
import {
  synthesizeCapabilityStatement,
  type CapabilityStatementRule,
} from "../../capability/capability-statement-synthesizer.js";

test("CapabilityStatement emits mandatory Group export when backing test passes", () => {
  const rules: CapabilityStatementRule[] = [
    {
      claim_path: "rest[0].operation[?(@.name=='export-group')]",
      claim_description: "Group export operation",
      backing_test: "mcp/src/__tests__/capability/bulk-data-group-export.test.ts",
      test_result_required: "passing",
      required_for_certification: true,
      certification_anchor: "§170.215(d)(1) Group export",
    },
  ];
  const result = synthesizeCapabilityStatement({
    baseUrl: "https://practice.example/fhir/R4",
    rules,
    testResults: {
      generated_at: "2026-05-05T00:00:00.000Z",
      results: { "mcp/src/__tests__/capability/bulk-data-group-export.test.ts": "passing" },
    },
  });
  assert.equal(result.capabilityStatement.rest?.[0]?.operation?.some((operation) => operation.name === "export-group"), true);
});
