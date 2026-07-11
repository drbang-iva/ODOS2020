import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAIMMD_DEFAULT_BASE_URL,
  createClaimMdAdapter,
  claimMdConfigFromEnv,
} from "../src/claims/claimmd-adapter.js";
import type { ClearinghouseAdapter } from "../src/claims/clearinghouse-adapter.js";

function jsonTransport(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("Claim.MD adapter uploads professional JSON claims as a file with AccountKey in the form body", async () => {
  const { calls, fetchImpl } = jsonTransport({
    result: {
      claim: [{ claimid: "claimmd-1", claimmd_id: "tracking-1", status: "A" }],
    },
  });
  const adapter = createClaimMdAdapter({
    config: { baseUrl: CLAIMMD_DEFAULT_BASE_URL, accountKey: "secret-key", mode: "test" },
    fetchImpl,
  });

  const result = await adapter.submitProfessionalClaim({
    fileName: "osod-claim-900.json",
    payload: { fileid: "osod-file-1", claim: [{ pcn: "OSOD-CLAIM-900" }] },
  });

  assert.equal(result.claims[0].claimMdId, "tracking-1");
  assert.equal(calls[0].url, "https://svc.claim.md/services/upload/");
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, "application/json");
  const form = calls[0].init.body as FormData;
  assert.equal(form.get("AccountKey"), "secret-key");
  assert.equal(form.get("Filename"), "osod-claim-900.json");
  assert.equal((form.get("File") as File).name, "osod-claim-900.json");
});

test("Claim.MD interface extraction preserves the serialized adapter result", async () => {
  const fixture = { result: { claim: [{ claimid: "claimmd-1", claimmd_id: "tracking-1", status: "A" }] } };
  const { fetchImpl } = jsonTransport(fixture);
  const adapter: ClearinghouseAdapter = createClaimMdAdapter({
    config: { baseUrl: CLAIMMD_DEFAULT_BASE_URL, accountKey: "secret-key", mode: "test" },
    fetchImpl,
  });
  const result = await adapter.submitProfessionalClaim({
    fileName: "osod-claim-900.json",
    payload: { fileid: "osod-file-1", claim: [{ pcn: "OSOD-CLAIM-900" }] },
  });
  assert.equal(JSON.stringify(result), JSON.stringify({
    claims: [{ claimMdClaimId: "claimmd-1", claimMdId: "tracking-1", status: "A" }],
    raw: fixture,
  }));
});

test("Claim.MD adapter uses eligdata, response, eralist, and eradata polling endpoints", async () => {
  const { calls, fetchImpl } = jsonTransport({ result: { ok: "1" } });
  const adapter = createClaimMdAdapter({
    config: { baseUrl: "https://claimmd.local", accountKey: "key", mode: "test" },
    fetchImpl,
  });

  await adapter.checkEligibility({
    ins_name_l: "SYNTHETIC",
    ins_name_f: "JAMIE",
    payerid: "PAYERTEST",
    pat_rel: "18",
    fdos: "20260709",
    prov_npi: "1111111112",
    prov_taxid: "900000001",
  });
  await adapter.checkClaimStatus({ claimMdClaimId: "claimmd-1", responseId: "0" });
  await adapter.listEras({ eraId: "0" });
  await adapter.retrieveEraData("era-900");

  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "https://claimmd.local/services/eligdata/",
      "https://claimmd.local/services/response/",
      "https://claimmd.local/services/eralist/",
      "https://claimmd.local/services/eradata/",
    ],
  );
  assert.equal((calls[1].init.body as URLSearchParams).get("ClaimID"), "claimmd-1");
  assert.equal((calls[2].init.body as URLSearchParams).get("ERAID"), "0");
  assert.equal((calls[3].init.body as URLSearchParams).get("eraid"), "era-900");
});

test("claimMdConfigFromEnv gates live routes until an operator supplies the AccountKey", () => {
  assert.equal(claimMdConfigFromEnv({}), null);
  assert.throws(() => claimMdConfigFromEnv({ CLAIMMD_BASE_URL: "https://svc.claim.md" }), /CLAIMMD_ACCOUNT_KEY/);
  assert.deepEqual(claimMdConfigFromEnv({ CLAIMMD_ACCOUNT_KEY: "key" }), {
    accountKey: "key",
    baseUrl: CLAIMMD_DEFAULT_BASE_URL,
    mode: "test",
  });
  assert.deepEqual(claimMdConfigFromEnv({ CLAIMMD_ACCOUNT_KEY: "key", CLAIMMD_MODE: "production" }), {
    accountKey: "key",
    baseUrl: CLAIMMD_DEFAULT_BASE_URL,
    mode: "production",
  });
  assert.deepEqual(claimMdConfigFromEnv({ CLAIMMD_ACCOUNT_KEY: "key", CLAIMMD_MODE: "prod" }), {
    accountKey: "key",
    baseUrl: CLAIMMD_DEFAULT_BASE_URL,
    mode: "test",
  });
  assert.deepEqual(
    claimMdConfigFromEnv({
      CLAIMMD_ACCOUNT_KEY: "key",
      CLAIMMD_BASE_URL: "https://claimmd.local/",
      CLAIMMD_MODE: "test",
    }),
    { accountKey: "key", baseUrl: "https://claimmd.local", mode: "test" },
  );
});
