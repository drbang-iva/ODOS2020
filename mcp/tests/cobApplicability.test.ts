import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coverage } from "@medplum/fhirtypes";
import {
  COB_APPLICABILITY_EXTENSION_URL,
  coverageCobApplicability,
} from "../src/insurance/cob-applicability.js";

function coverage(valueCode?: string): Coverage {
  return {
    resourceType: "Coverage",
    status: "active",
    beneficiary: { reference: "Patient/patient-1" },
    payor: [{ reference: "Organization/payer-1" }],
    ...(valueCode ? { extension: [{ url: COB_APPLICABILITY_EXTENSION_URL, valueCode }] } : {}),
  };
}

test("COB applicability fails safe to unknown when payer configuration is absent or invalid", () => {
  assert.equal(coverageCobApplicability(coverage()), "unknown");
  assert.equal(coverageCobApplicability(coverage("not-a-classification")), "unknown");
  assert.equal(coverageCobApplicability(coverage("supported")), "supported");
  assert.equal(coverageCobApplicability(coverage("unsupported")), "unsupported");
  assert.equal(coverageCobApplicability(coverage("traditional-medicare")), "traditional-medicare");
  assert.equal(coverageCobApplicability(coverage("capitated")), "capitated");
});
