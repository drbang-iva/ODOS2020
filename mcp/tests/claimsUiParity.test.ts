import assert from "node:assert/strict";
import { test } from "node:test";
import { medicalEligibilitySummary as mcpMedicalEligibilitySummary } from "../src/claims/claimmd-fhir.js";
import { medicalEligibilitySummary as uiMedicalEligibilitySummary } from "../../ui/src/lib/claims.js";

const response = {
  resourceType: "CoverageEligibilityResponse",
  status: "active",
  purpose: ["validation", "benefits", "auth-requirements"],
  patient: { reference: "Patient/pat-900" },
  created: "2026-07-09",
  request: { reference: "CoverageEligibilityRequest/elig-1" },
  outcome: "complete",
  insurer: { reference: "Organization/payer-1" },
  insurance: [
    {
      coverage: { reference: "Coverage/cov-1" },
      inforce: true,
      item: [
        { name: "Deductible", benefit: [{ type: { text: "remaining" }, allowedMoney: { value: 300, currency: "USD" } }] },
        { name: "Co-Payment", benefit: [{ type: { text: "copay" }, allowedMoney: { value: 25, currency: "USD" } }] },
        { name: "Co-Insurance", benefit: [{ type: { text: "coinsurance" }, allowedUnsignedInt: 20 }] },
        { name: "Prior Authorization Required", authorizationRequired: true },
      ],
    },
  ],
} as const;

test("UI medical eligibility summary mirrors the MCP projection exactly", () => {
  assert.deepEqual(uiMedicalEligibilitySummary(response), mcpMedicalEligibilitySummary(response));
});
