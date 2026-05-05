import assert from "node:assert/strict";
import { test } from "node:test";
import {
  synthesizeCapabilityStatement,
  type CapabilityStatementRule,
} from "../../capability/capability-statement-synthesizer.js";

test("CapabilityStatement emits mandatory Observation read when backing test passes", () => {
  const rules: CapabilityStatementRule[] = [
    {
      claim_path: "rest[0].resource[?(@.type=='Observation')].interaction[?(@.code=='read')]",
      claim_description: "Observation read REST interaction",
      backing_test: "mcp/src/__tests__/capability/observation-read.test.ts",
      test_result_required: "passing",
      required_for_certification: true,
      certification_anchor: "§170.315(g)(10) Observation read",
    },
  ];
  const result = synthesizeCapabilityStatement({
    baseUrl: "https://practice.example/fhir/R4",
    rules,
    testResults: {
      generated_at: "2026-05-05T00:00:00.000Z",
      results: { "mcp/src/__tests__/capability/observation-read.test.ts": "passing" },
    },
  });
  assert.equal(result.capabilityStatement.rest?.[0]?.resource?.some((resource) => resource.type === "Observation"), true);
});
