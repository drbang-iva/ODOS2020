import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearinghouseRoutingFromEnv,
  selectClearinghouseAdapter,
  type ClearinghouseAdapter,
} from "../src/claims/clearinghouse-adapter.js";

function adapter(id: "claimmd" | "stedi"): ClearinghouseAdapter {
  return {
    id,
    submitProfessionalClaim: async () => ({}),
    checkEligibility: async () => ({}),
    checkClaimStatus: async () => ({}),
    listEras: async () => ({}),
    retrieveEraData: async () => ({}),
  };
}

test("clearinghouse selection defaults traffic to Claim.MD and keeps ERA routing independent", () => {
  const claimmd = adapter("claimmd");
  const stedi = adapter("stedi");
  const adapters = { claimmd, stedi };

  assert.equal(selectClearinghouseAdapter(adapters, undefined, "transaction"), claimmd);
  assert.equal(selectClearinghouseAdapter(adapters, "stedi", "transaction"), stedi);
  assert.equal(selectClearinghouseAdapter(adapters, undefined, "era", { era: "stedi" }), stedi);
  assert.equal(selectClearinghouseAdapter(adapters, undefined, "transaction", { era: "stedi" }), claimmd);
});

test("system routing config defaults both lanes to Claim.MD and keeps ERA explicit", () => {
  assert.deepEqual(clearinghouseRoutingFromEnv({}), { transaction: "claimmd", era: "claimmd" });
  assert.deepEqual(clearinghouseRoutingFromEnv({
    OSOD_CLEARINGHOUSE_DEFAULT: "stedi",
    OSOD_ERA_CLEARINGHOUSE: "claimmd",
  }), { transaction: "stedi", era: "claimmd" });
  assert.throws(() => clearinghouseRoutingFromEnv({ OSOD_ERA_CLEARINGHOUSE: "auto" }), /claimmd or stedi/);
});

test("clearinghouse selection fails closed when the selected adapter is not configured", () => {
  assert.throws(
    () => selectClearinghouseAdapter({ claimmd: adapter("claimmd") }, "stedi", "transaction"),
    /Stedi clearinghouse adapter is not configured/,
  );
});
