import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCapabilityRulesBuildGate,
  synthesizeCapabilityStatement,
  type CapabilityStatementRule,
} from "../../mcp/src/capability/capability-statement-synthesizer.js";

test("v0.55e CapabilityStatement gate hard-fails mandatory claims and suppresses optional claims", () => {
  const requiredRule: CapabilityStatementRule = {
    claim_path: "rest[0].resource[?(@.type=='Patient')].interaction[?(@.code=='read')]",
    claim_description: "Patient read",
    backing_test: "required.test.ts",
    test_result_required: "passing",
    required_for_certification: true,
    certification_anchor: "mandatory Patient read",
  };
  const optionalRule: CapabilityStatementRule = {
    claim_path: "rest[0].operation[?(@.name=='export-patient')]",
    claim_description: "Patient export",
    backing_test: "optional.test.ts",
    test_result_required: "passing",
    required_for_certification: false,
    certification_anchor: "optional Patient export",
  };

  assert.throws(
    () =>
      assertCapabilityRulesBuildGate([requiredRule], {
        generated_at: "2026-05-05T00:00:00.000Z",
        results: { "required.test.ts": "failing" },
      }),
    /Required CapabilityStatement claim failed/,
  );

  const result = synthesizeCapabilityStatement({
    baseUrl: "https://practice.example/fhir/R4",
    patientExportEnabled: true,
    rules: [requiredRule, optionalRule],
    testResults: {
      generated_at: "2026-05-05T00:00:00.000Z",
      results: {
        "required.test.ts": "passing",
        "optional.test.ts": "failing",
      },
    },
  });

  assert.equal(result.capabilityStatement.rest?.[0]?.resource?.some((resource) => resource.type === "Patient"), true);
  assert.equal(result.capabilityStatement.rest?.[0]?.operation?.some((operation) => operation.name === "export-patient"), false);
});
