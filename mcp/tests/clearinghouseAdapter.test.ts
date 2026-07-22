import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    ODOS_CLEARINGHOUSE_DEFAULT: "stedi",
    ODOS_ERA_CLEARINGHOUSE: "claimmd",
  }), { transaction: "stedi", era: "claimmd" });
  assert.throws(() => clearinghouseRoutingFromEnv({ ODOS_ERA_CLEARINGHOUSE: "auto" }), /claimmd or stedi/);
});

test("clearinghouse selection fails closed when the selected adapter is not configured", () => {
  assert.throws(
    () => selectClearinghouseAdapter({ claimmd: adapter("claimmd") }, "stedi", "transaction"),
    /Stedi clearinghouse adapter is not configured/,
  );
});

test("Stedi environment routing reaches every claims route dependency closure", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const defaults = clearinghouseRoutingFromEnv({ ODOS_CLEARINGHOUSE_DEFAULT: "stedi" });
  assert.equal(defaults.transaction, "stedi");

  const dependencyAnchors = [
    "registerReportingRoutes(app, {",
    "handleClaimSearchRequest(",
    "handleManualEobListRequest(",
    "handleCreateManualEobRequest(",
    "handlePostManualEobClaimRequest(",
    "handleCloseManualEobRequest(",
    "handleEraWorklistRequest(",
    "handleClaimEraWorklistTaskRequest(",
    "handleResolveEraWorklistTaskRequest(",
  ];
  for (const anchor of dependencyAnchors) {
    const start = source.indexOf(anchor);
    assert.notEqual(start, -1, `${anchor} must remain registered`);
    const recordAudit = source.indexOf("recordAudit:", start);
    assert.notEqual(recordAudit, -1, `${anchor} must retain its audit dependency`);
    assert.match(
      source.slice(start, recordAudit),
      /routingDefaults: clearinghouseRouting/,
      `${anchor} must receive the configured clearinghouse routing defaults`,
    );
  }
});

test("claims handlers use the selected adapter id as the resolved clearinghouse identity", () => {
  const source = readFileSync(new URL("../src/claims/claimmd-handlers.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /const adapter = selectClearinghouseAdapter\([\s\S]*?return \{ id: adapter\.id, adapter:/,
  );
  assert.doesNotMatch(source, /const id = requested \?\? deps\.routingDefaults\?\.\[operation\] \?\? "claimmd"/);
});
