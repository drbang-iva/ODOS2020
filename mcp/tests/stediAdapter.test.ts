import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STEDI_DEFAULT_BASE_URL,
  STEDI_DEFAULT_CORE_BASE_URL,
  StediRequestError,
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
  await adapter.retrieve277Data("833112dc-3073-4a4c-a555-64fded7db935");
  await adapter.list277s({ startDateTime: "2026-07-10T00:00:00.000Z" });

  assert.deepEqual(calls.map((call) => call.url), [
    `${STEDI_DEFAULT_BASE_URL}/eligibility/v3`,
    `${STEDI_DEFAULT_BASE_URL}/professionalclaims/v3/submission`,
    `${STEDI_DEFAULT_BASE_URL}/claimstatus/v2`,
    `${STEDI_DEFAULT_BASE_URL}/reports/v2/7647d644-9348-4596-a3b4-6830b8b48cc8/835`,
    `${STEDI_DEFAULT_CORE_BASE_URL}/polling/transactions?startDateTime=2026-07-10T00%3A00%3A00.000Z`,
    `${STEDI_DEFAULT_BASE_URL}/reports/v2/833112dc-3073-4a4c-a555-64fded7db935/277`,
    `${STEDI_DEFAULT_CORE_BASE_URL}/polling/transactions?startDateTime=2026-07-10T00%3A00%3A00.000Z`,
  ]);
  for (const call of calls) {
    assert.equal((call.init.headers as Record<string, string>).Authorization, "test-key");
  }
  assert.equal((calls[1].init.headers as Record<string, string>)["Idempotency-Key"], "ODOSCLAIM900");
  assert.equal(calls[3].init.method, "GET");
  assert.equal(calls[5].init.method, "GET");
  assert.equal("enrollEra" in adapter, false);
});

test("Stedi reuses one polling transport, preserves ERA discovery output, and filters 277 discovery", async () => {
  const { calls, fetchImpl } = jsonTransport({
    items: [
      { transactionId: "era-1", direction: "INBOUND", x12: { metadata: { transaction: { transactionSetIdentifier: "835" } } } },
      { transactionId: "ack-1", direction: "INBOUND", x12: { metadata: { transaction: { transactionSetIdentifier: "277" } } } },
      { transactionId: "outbound-ack", direction: "OUTBOUND", x12: { metadata: { transaction: { transactionSetIdentifier: "277" } } } },
    ],
    nextPageToken: "next-1",
  });
  const adapter = createStediAdapter({
    config: { baseUrl: STEDI_DEFAULT_BASE_URL, coreBaseUrl: STEDI_DEFAULT_CORE_BASE_URL, apiKey: "test-key", submitterId: "SUBMITTER900", mode: "test" },
    fetchImpl,
  });

  assert.deepEqual((await adapter.listEras({ pageToken: "page-1" }) as any).items.map((item: any) => item.transactionId), [
    "era-1",
    "ack-1",
    "outbound-ack",
  ]);
  assert.deepEqual((await adapter.list277s({ pageToken: "page-1" }) as any).items.map((item: any) => item.transactionId), ["ack-1"]);
  assert.equal((await adapter.list277s({ pageToken: "page-1" }) as any).nextPageToken, "next-1");
  assert.equal(calls.every((call) => call.url === `${STEDI_DEFAULT_CORE_BASE_URL}/polling/transactions?pageToken=page-1`), true);
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
    errors: [
      { code: "INVALID_VALUE", description: "procedureCode is invalid", followupAction: "Correct the claim and resubmit." },
      { code: "MISSING_FIELD", description: "subscriber gender is missing" },
      { description: "payer edit rejected claim", followupAction: "Contact the payer." },
      { code: "CAPPED_ERROR", description: "this fourth error must not reach the message" },
    ],
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
      assert.ok(error instanceof StediRequestError);
      assert.match(error.message, /INVALID_VALUE: procedureCode is invalid \(Correct the claim and resubmit\.\)/);
      assert.match(error.message, /MISSING_FIELD: subscriber gender is missing/);
      assert.match(error.message, /payer edit rejected claim \(Contact the payer\.\)/);
      assert.match(error.message, /1 more Stedi error omitted/);
      assert.match(error.message, /\[correlationId: corr-claim-900\]/);
      assert.doesNotMatch(error.message, /this fourth error must not reach the message/);
      assert.doesNotMatch(error.message, /SYNTHETIC-X12-CONTENT/);
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
      assert.equal((error as Error).message, "Stedi request failed with HTTP 502.");
      return true;
    },
  );
});

test("Stedi INVALID_REQUEST_BODY errors surface field paths when errors[] is absent", async () => {
  const responseBody = {
    code: "INVALID_REQUEST_BODY",
    message: JSON.stringify({
      "claimInformation.serviceLines.items.0.renderingProvider": ["lastName or organizationName are required"],
      "billing.contactInformation": ["phoneNumber, email, or faxNumber required"],
    }),
  };
  const adapter = createStediAdapter({
    config: { baseUrl: STEDI_DEFAULT_BASE_URL, coreBaseUrl: STEDI_DEFAULT_CORE_BASE_URL, apiKey: "test-key", submitterId: "SUBMITTER900", mode: "test" },
    fetchImpl: (async () => new Response(JSON.stringify(responseBody), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    adapter.checkEligibility({ tradingPartnerServiceId: "STEDITEST" }),
    (error: unknown) => {
      assert.ok(error instanceof StediRequestError);
      assert.match(error.message, /claimInformation\.serviceLines\.items\.0\.renderingProvider: lastName or organizationName are required/);
      assert.match(error.message, /billing\.contactInformation: phoneNumber, email, or faxNumber required/);
      return true;
    },
  );
});
