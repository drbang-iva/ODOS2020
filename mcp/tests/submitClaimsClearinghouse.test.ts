import assert from "node:assert/strict";
import { test } from "node:test";
import { submitProfessionalClaim, type ProfessionalClaimInput } from "../../ui/src/lib/submit-claims.js";

const claim = { patientAccountNumber: "OSOD-CLAIM-900" } as ProfessionalClaimInput;

test("UI submit helper preserves the Claim.MD-default request body when no selector is supplied", async () => {
  let body = "";
  await submitProfessionalClaim(claim, {
    fetchImpl: (async (_url: URL | RequestInfo, init?: RequestInit) => {
      body = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(body, JSON.stringify({ claim }));
});

test("UI submit helper can explicitly select Stedi without changing the claim payload", async () => {
  let body = "";
  await submitProfessionalClaim(claim, {
    clearinghouse: "stedi",
    fetchImpl: (async (_url: URL | RequestInfo, init?: RequestInit) => {
      body = String(init?.body);
      return new Response('{"clearinghouse":"stedi"}', { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(body, JSON.stringify({ claim, clearinghouse: "stedi" }));
});
