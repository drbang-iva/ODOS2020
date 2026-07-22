import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STEDI_DEFAULT_BASE_URL,
  STEDI_DEFAULT_CORE_BASE_URL,
  createStediAdapter,
  stediConfigFromEnv,
} from "../src/claims/stedi-adapter.js";

function jsonTransport(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("Stedi adapter uses the documented JSON endpoints and API-key headers", async () => {
  const { calls, fetchImpl } = jsonTransport({ claimReference: { correlationId: "stedi-claim-1" } });
  const adapter = createStediAdapter({
    config: { baseUrl: STEDI_DEFAULT_BASE_URL, coreBaseUrl: STEDI_DEFAULT_CORE_BASE_URL, apiKey: "test-key", submitterId: "SUBMITTER900", mode: "test" },
    fetchImpl,
  });

  await adapter.checkEligibility({ tradingPartnerServiceId: "STEDITEST" });
  await adapter.submitProfessionalClaim({
    idempotencyKey: "ODOSCLAIM900",
    payload: { usageIndicator: "T", tradingPartnerServiceId: "STEDITEST" },
  });
  await adapter.checkClaimStatus({ tradingPartnerServiceId: "STEDITEST" });
  await adapter.retrieveEraData("7647d644-9348-4596-a3b4-6830b8b48cc8");
  await adapter.listEras({ startDateTime: "2026-07-10T00:00:00.000Z" });

  assert.deepEqual(calls.map((call) => call.url), [
    `${STEDI_DEFAULT_BASE_URL}/eligibility/v3`,
    `${STEDI_DEFAULT_BASE_URL}/professionalclaims/v3/submission`,
    `${STEDI_DEFAULT_BASE_URL}/claimstatus/v2`,
    `${STEDI_DEFAULT_BASE_URL}/reports/v2/7647d644-9348-4596-a3b4-6830b8b48cc8/835`,
    `${STEDI_DEFAULT_CORE_BASE_URL}/polling/transactions?startDateTime=2026-07-10T00%3A00%3A00.000Z`,
  ]);
  for (const call of calls) {
    assert.equal((call.init.headers as Record<string, string>).Authorization, "test-key");
  }
  assert.equal((calls[1].init.headers as Record<string, string>)["Idempotency-Key"], "ODOSCLAIM900");
  assert.equal(calls[3].init.method, "GET");
  assert.equal("enrollEra" in adapter, false);
});

test("Stedi configuration is opt-in and production requires an exact mode value", () => {
  assert.equal(stediConfigFromEnv({}), null);
  assert.throws(() => stediConfigFromEnv({ STEDI_MODE: "test" }), /STEDI_API_KEY/);
  assert.throws(() => stediConfigFromEnv({ STEDI_API_KEY: "key" }), /STEDI_SUBMITTER_ID/);
  assert.deepEqual(stediConfigFromEnv({ STEDI_API_KEY: "key", STEDI_SUBMITTER_ID: "SUBMITTER900" }), {
    apiKey: "key",
    submitterId: "SUBMITTER900",
    baseUrl: STEDI_DEFAULT_BASE_URL,
    coreBaseUrl: STEDI_DEFAULT_CORE_BASE_URL,
    mode: "test",
  });
  assert.equal(stediConfigFromEnv({ STEDI_API_KEY: "key", STEDI_SUBMITTER_ID: "SUBMITTER900", STEDI_MODE: "production" })?.mode, "production");
  assert.equal(stediConfigFromEnv({ STEDI_API_KEY: "key", STEDI_SUBMITTER_ID: "SUBMITTER900", STEDI_MODE: "prod" })?.mode, "test");
});

test("Stedi errors expose response details without echoing the PHI-bearing response body", async () => {
  const responseBody = {
    errors: [{ code: "INVALID_VALUE", description: "procedureCode is invalid", followupAction: "Correct the claim and resubmit." }],
    claimReference: { correlationId: "corr-claim-900", patientControlNumber: "ODOSCLAIM900" },
    x12: "SYNTHETIC-X12-CONTENT",
  };
  const { fetchImpl } = jsonTransport(responseBody, 422);
  const adapter = createStediAdapter({
    config: { baseUrl: STEDI_DEFAULT_BASE_URL, coreBaseUrl: STEDI_DEFAULT_CORE_BASE_URL, apiKey: "test-key", submitterId: "SUBMITTER900", mode: "test" },
    fetchImpl,
  });
  await assert.rejects(
    adapter.checkEligibility({ tradingPartnerServiceId: "STEDITEST" }),
    (error: unknown) => {
      const stediError = error as {
        status?: number;
        responseBody?: unknown;
        errors?: unknown;
        correlationId?: string;
      };
      assert.equal(stediError.status, 422);
      assert.deepEqual(stediError.responseBody, responseBody);
      assert.deepEqual(stediError.errors, responseBody.errors);
      assert.equal(stediError.correlationId, "corr-claim-900");
      assert.doesNotMatch(String(error), /SYNTHETIC-X12-CONTENT/);
      return true;
    },
  );
});

test("Stedi errors preserve the HTTP failure when the response body is not JSON", async () => {
  const fetchImpl = (async () => new Response("upstream unavailable", { status: 502 })) as typeof fetch;
  const adapter = createStediAdapter({
    config: { baseUrl: STEDI_DEFAULT_BASE_URL, coreBaseUrl: STEDI_DEFAULT_CORE_BASE_URL, apiKey: "test-key", submitterId: "SUBMITTER900", mode: "test" },
    fetchImpl,
  });

  await assert.rejects(
    adapter.checkEligibility({ tradingPartnerServiceId: "STEDITEST" }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 502);
      assert.equal((error as { responseBody?: unknown }).responseBody, undefined);
      return true;
    },
  );
});
