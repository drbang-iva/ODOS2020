import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStampBottomOffset,
  classifyBuild,
  parseDeployedVersion,
  syncObservedBottomBars,
  type BuildStampVersion,
} from "../src/build-stamp";

const BUILT_SHA = "1111111111111111111111111111111111111111";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const NOW = new Date("2026-08-10T18:00:00.000Z");

function buildVersion(builtAt: string, sha = BUILT_SHA): BuildStampVersion {
  return { sha, shortSha: sha === "unknown" ? "unknown" : sha.slice(0, 7), branch: "main", builtAt };
}

test("matching deployed SHA is CURRENT even when the build is older than 12 hours", (t) => {
  const result = classifyBuild(
    buildVersion("2026-08-08T18:00:00.000Z"),
    { sha: BUILT_SHA, shortSha: BUILT_SHA.slice(0, 7), checkedAt: "2026-08-10T17:59:00.000Z" },
    NOW,
  );

  t.diagnostic(`signal=${result.signal} state=${result.state}`);
  assert.deepEqual(result, { state: "current", signal: "deployed-sha" });
});

test("mismatching deployed SHA is STALE even when the build is minutes old", (t) => {
  const result = classifyBuild(
    buildVersion("2026-08-10T17:55:00.000Z"),
    { sha: OTHER_SHA, shortSha: OTHER_SHA.slice(0, 7), checkedAt: "2026-08-10T17:59:00.000Z" },
    NOW,
  );

  t.diagnostic(`signal=${result.signal} state=${result.state}`);
  assert.deepEqual(result, { state: "stale", signal: "deployed-sha" });
});

test("absent deployed.json falls back cleanly to build age without an error state", (t) => {
  const result = classifyBuild(buildVersion("2026-08-10T05:59:59.999Z"), undefined, NOW);

  t.diagnostic(`signal=${result.signal} state=${result.state}`);
  assert.deepEqual(result, { state: "stale", signal: "build-age" });
  assert.equal("error" in result, false);
});

test("malformed deployed.json is treated as absent and falls back to age", () => {
  const deployed = parseDeployedVersion({
    sha: BUILT_SHA,
    shortSha: "not-a-sha",
    checkedAt: "yesterday",
  });

  assert.equal(deployed, undefined);
  assert.deepEqual(classifyBuild(buildVersion("2026-08-10T17:00:00.000Z"), deployed, NOW), {
    state: "current",
    signal: "build-age",
  });
});

test("unknown built SHA warns without claiming stale or current", (t) => {
  const result = classifyBuild(buildVersion("2026-08-10T17:00:00.000Z", "unknown"), undefined, NOW);

  t.diagnostic(`signal=${result.signal} state=${result.state}`);
  assert.deepEqual(result, { state: "unknown", signal: "unknown-sha" });
});

test("build stamp clears overlapping bottom bars but ignores a left-side pinned panel", () => {
  const stamp = { left: 920, right: 1188 };
  const saveBar = { left: 0, right: 1200, top: 724, bottom: 800 };
  const leftPanel = { left: 0, right: 384, top: 0, bottom: 800 };

  assert.equal(buildStampBottomOffset(stamp, [saveBar], 800), 88);
  assert.equal(buildStampBottomOffset(stamp, [leftPanel], 800), 12);
});

test("build stamp observer releases detached bottom bars and tracks current bars", () => {
  const detached = {} as HTMLElement;
  const retained = {} as HTMLElement;
  const added = {} as HTMLElement;
  const observed = new Set([detached, retained]);
  const observeCalls: HTMLElement[] = [];
  const unobserveCalls: HTMLElement[] = [];

  syncObservedBottomBars(observed, new Set([retained, added]), {
    observe: (element) => observeCalls.push(element),
    unobserve: (element) => unobserveCalls.push(element),
  });

  assert.deepEqual([...observed], [retained, added]);
  assert.deepEqual(observeCalls, [added]);
  assert.deepEqual(unobserveCalls, [detached]);
});
