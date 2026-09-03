#!/usr/bin/env node
// Tier 0 dead-control census — self-test.
//
// Locks in the three defects an independent evaluation (Codex, PR #513) and Greptile both
// reproduced in the first version of this skill, so they can't silently regress:
//
//   1. A valid single-quoted route ("case '/foo':") disappeared from discovery without warning.
//   2. A manifest entry with a non-"reviewed" status, or a duplicate route entry, was still
//      counted as coverage — producing e.g. "Coverage: 50/49 routes reviewed."
//   3. A malformed manifest.json, or a reformatted "switch (path)" header, crashed with an
//      uncaught exception instead of degrading — contradicting this tool's own "always exits 0,
//      advisory only" promise.
//
// Runs against in-memory fixtures and subprocesses using copies of the real scripts in disposable
// directories. Never modifies the real App.tsx or manifest.json. Exits 1 on any failed test.
//
// Usage: node self-test.mjs

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseRouteSwitchSource } from "./discover-routes.mjs";
import { normalizeManifestEntries, computeCensusReport } from "./check-manifest.mjs";
import { parseIndexRegistrations, extractRouteFamilies, findReExportTarget } from "./discover-backend-routes.mjs";
import { parseProxyKeys, computeProxyCoverageReport } from "./check-proxy-coverage.mjs";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  }
}

function noopResolver(identifier, warnings) {
  warnings.push(`unresolved identifier in test fixture: ${identifier}`);
  return null;
}

// --- Defect 1: single-quoted routes must not silently vanish ---

test("double- and single-quoted case values both resolve, no warnings", () => {
  const source = `
    function RouteSwitch({ path }) {
      switch (path) {
        case "/double-quoted":
          return null;
        case '/single-quoted':
          return null;
        default:
          return null;
      }
    }
  `;
  const { routes, warnings } = parseRouteSwitchSource(source, noopResolver);
  assert.deepEqual(routes, ["/double-quoted", "/single-quoted"]);
  assert.deepEqual(warnings, []);
});

test("an unparseable case value is warned about, not silently dropped", () => {
  const source = `
    switch (path) {
      case "/fine":
        return null;
      case \`/template-literal-not-supported\`:
        return null;
    }
  `;
  const { routes, warnings } = parseRouteSwitchSource(source, noopResolver);
  assert.deepEqual(routes, ["/fine"]);
  assert.equal(warnings.length, 1, "expected exactly one warning for the unparseable case");
  assert.match(warnings[0], /Could not parse/);
});

test("a resolvable named path constant is included via the injected resolver", () => {
  const source = `
    switch (path) {
      case SOME_PATH:
        return null;
    }
  `;
  const { routes, warnings } = parseRouteSwitchSource(source, (id) => (id === "SOME_PATH" ? "/resolved" : null));
  assert.deepEqual(routes, ["/resolved"]);
  assert.deepEqual(warnings, []);
});

// --- Defect 3a: a reformatted switch header must degrade, not throw ---

test("a switch header with unconventional whitespace still parses", () => {
  const source = `
    switch (
      path
    ) {
      case "/still-found":
        return null;
    }
  `;
  const { routes, warnings } = parseRouteSwitchSource(source, noopResolver);
  assert.deepEqual(routes, ["/still-found"]);
  assert.deepEqual(warnings, []);
});

test("a missing switch(path) block warns and returns no routes, does not throw", () => {
  const source = `function RouteSwitch() { return null; }`;
  assert.doesNotThrow(() => {
    const { routes, warnings } = parseRouteSwitchSource(source, noopResolver);
    assert.deepEqual(routes, []);
    assert.equal(warnings.length, 1);
  });
});

// --- Defect 2: non-"reviewed" status and duplicate entries must not inflate coverage ---

test("an entry with a non-reviewed status does not count as coverage", () => {
  const appRoutes = ["/a", "/b"];
  const rawEntries = [
    { route: "/a", status: "reviewed" },
    { route: "/b", status: "unreviewed" },
  ];
  const { unlisted, coveredCount, warnings } = computeCensusReport(appRoutes, rawEntries);
  assert.equal(coveredCount, 1, "only /a should count as covered");
  assert.deepEqual(unlisted, ["/b"]);
  assert.ok(warnings.some((w) => w.includes('status "unreviewed"')));
});

test("a duplicate route entry is counted once, not once per entry — no Coverage: N/(N-1)", () => {
  const appRoutes = ["/a"];
  const rawEntries = [
    { route: "/a", status: "reviewed" },
    { route: "/a", status: "reviewed" },
  ];
  const { coveredCount, warnings } = computeCensusReport(appRoutes, rawEntries);
  assert.equal(coveredCount, 1, "coveredCount must never exceed appRoutes.length");
  assert.ok(coveredCount <= appRoutes.length);
  assert.ok(warnings.some((w) => w.includes("more than one manifest entry")));
});

test("conflicting statuses remain unreviewed in either order, even after another reviewed entry", () => {
  for (const status of ["unreviewed", undefined, null]) {
    const reviewed = { route: "/a", status: "reviewed" };
    const other = { route: "/a", status };
    for (const entries of [[reviewed, other, reviewed], [other, reviewed, reviewed]]) {
      const { coveredCount, unlisted, warnings } = computeCensusReport(["/a"], entries);
      assert.equal(coveredCount, 0);
      assert.deepEqual(unlisted, ["/a"]);
      assert.ok(warnings.some((warning) => warning.includes("conflicting statuses")));
    }
  }
});

test("an entry missing the status field is not silently treated as reviewed", () => {
  const appRoutes = ["/a"];
  const rawEntries = [{ route: "/a" }];
  const { coveredCount, unlisted } = computeCensusReport(appRoutes, rawEntries);
  assert.equal(coveredCount, 0);
  assert.deepEqual(unlisted, ["/a"]);
});

test("a malformed entry (no route field) is reported and ignored, not counted", () => {
  const appRoutes = ["/a"];
  const rawEntries = [{ status: "reviewed" }, { route: 42, status: "reviewed" }];
  const { coveredCount, warnings } = computeCensusReport(appRoutes, rawEntries);
  assert.equal(coveredCount, 0);
  assert.ok(warnings.some((w) => w.includes("malformed")));
});

test("a stale reviewed entry does not inflate coverage past appRoutes.length", () => {
  const appRoutes = ["/a"];
  const rawEntries = [
    { route: "/a", status: "reviewed" },
    { route: "/this-route-no-longer-exists", status: "reviewed" },
  ];
  const { coveredCount, stale } = computeCensusReport(appRoutes, rawEntries);
  assert.equal(coveredCount, 1);
  assert.deepEqual(stale, ["/this-route-no-longer-exists"]);
});

// --- Defect 3b: normalizeManifestEntries itself must never throw on garbage input ---

test("normalizeManifestEntries does not throw on non-array-shaped garbage entries", () => {
  const warnings = [];
  assert.doesNotThrow(() => {
    normalizeManifestEntries([null, undefined, "a string", 42, { route: "/ok", status: "reviewed" }], warnings);
  });
});

const cliSource = `switch (path) {
  case "/a":
    return null;
  case '/b':
    return null;
}`;

function runChecker({ manifest = '{"routes":[]}', source = cliSource, appAsDirectory = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tier0-census-self-test-")));
  try {
    const scripts = join(root, ".claude/skills/tier0-census/scripts");
    mkdirSync(scripts, { recursive: true });
    for (const filename of ["check-manifest.mjs", "discover-routes.mjs"]) {
      copyFileSync(new URL(filename, import.meta.url), join(scripts, filename));
    }
    mkdirSync(join(root, "ui/src"), { recursive: true });
    const app = join(root, "ui/src/App.tsx");
    if (appAsDirectory) mkdirSync(app);
    else writeFileSync(app, source);
    writeFileSync(join(scripts, "../manifest.json"), manifest);
    const result = spawnSync(process.execPath, [join(scripts, "check-manifest.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `checker must exit 0:\n${result.stdout}${result.stderr}`);
    assert.equal(result.stderr, "");
    return result.stdout;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const reviewedEntries = [
  { route: "/a", status: "reviewed" },
  { route: "/b", status: "reviewed" },
];

for (const { name, entries, covered, unreviewed, stale = [], warning } of [
  { name: "empty manifest", entries: [], covered: 0, unreviewed: ["/a", "/b"] },
  { name: "fully reviewed manifest", entries: reviewedEntries, covered: 2, unreviewed: [] },
  { name: "identical duplicates", entries: [...reviewedEntries, reviewedEntries[0]], covered: 2, unreviewed: [], warning: /duplicates counted once/ },
  { name: "non-reviewed entry", entries: [reviewedEntries[0], { route: "/b", status: "unreviewed" }], covered: 1, unreviewed: ["/b"], warning: /not counted as coverage/ },
  { name: "conflicting duplicate, reviewed first", entries: [...reviewedEntries, { route: "/a", status: "unreviewed" }], covered: 1, unreviewed: ["/a"], warning: /conflicting statuses/ },
  { name: "conflicting duplicate, unreviewed first", entries: [{ route: "/a", status: "unreviewed" }, ...reviewedEntries], covered: 1, unreviewed: ["/a"], warning: /conflicting statuses/ },
  { name: "malformed entries", entries: [null, {}, { route: 42, status: "reviewed" }], covered: 0, unreviewed: ["/a", "/b"], warning: /malformed/ },
  { name: "stale reviewed entry", entries: [...reviewedEntries, { route: "/removed", status: "reviewed" }], covered: 2, unreviewed: [], stale: ["/removed"] },
]) {
  test(`CLI exits 0 with correct findings: ${name}`, () => {
    const output = runChecker({ manifest: JSON.stringify({ routes: entries }) });
    assert.ok(output.includes(`Coverage: ${covered}/2 routes reviewed.`));
    assert.deepEqual([...output.matchAll(/^  \? (.+)$/gm)].map((match) => match[1]), unreviewed);
    assert.deepEqual([...output.matchAll(/^  x (.+)$/gm)].map((match) => match[1]), stale);
    if (warning) assert.match(output, warning);
    if (unreviewed.length > 0) assert.doesNotMatch(output, /Every discovered route has a reviewed manifest entry/);
  });
}

test("CLI invalid JSON warns, treats manifest as empty, and exits 0", () => {
  const output = runChecker({ manifest: "{ invalid JSON" });
  assert.match(output, /1 warning\(s\):/);
  assert.match(output, /not valid JSON.*Treating the manifest as empty/);
  assert.match(output, /Coverage: 0\/2 routes reviewed\./);
  assert.deepEqual([...output.matchAll(/^  \? (.+)$/gm)].map((match) => match[1]), ["/a", "/b"]);
});

test("CLI malformed manifest shape warns, treats manifest as empty, and exits 0", () => {
  const output = runChecker({ manifest: '{"routes":{}}' });
  assert.match(output, /expected a top-level "routes" array/);
  assert.match(output, /Coverage: 0\/2 routes reviewed\./);
});

test("CLI reformatted switch header still discovers routes and exits 0", () => {
  const output = runChecker({ source: cliSource.replace("switch (path)", "switch(path)") });
  assert.match(output, /2 route\(s\) discovered/);
  assert.match(output, /Coverage: 0\/2 routes reviewed\./);
});

test("CLI unrecognized switch header warns and exits 0", () => {
  const output = runChecker({ source: "function RouteSwitch() { return null; }" });
  assert.match(output, /Could not find a "switch \(path\)/);
  assert.doesNotMatch(output, /Every discovered route has a reviewed manifest entry/);
});

test("CLI unexpected discovery read error is reported by the outer catch and exits 0", () => {
  const output = runChecker({ appAsDirectory: true });
  assert.match(output, /unexpected internal error and could not complete/);
  assert.match(output, /Advisory only/);
  assert.doesNotMatch(output, /Coverage:|Every discovered route has a reviewed manifest entry/);
});

// --- Proxy-coverage census: backend route-family discovery + the anti-drift check itself ---
// Three real bugs (/watchers, /communications, /comms) shipped from the same root cause:
// mcp/src/index.ts's register*Routes calls and ui/vite.config.ts's proxy table are two
// hand-maintained lists with nothing keeping them in sync. These tests lock in the parser that
// closes that gap.

test("parseIndexRegistrations finds an import that is actually called, excludes one that isn't", () => {
  const source = `
    import { registerFooRoutes } from "./foo/foo-routes.js";
    import { registerBarRoutes } from "./bar/bar-routes.js";
    export function main(app) {
      registerFooRoutes(app, {});
      // registerBarRoutes is imported but never invoked
    }
  `;
  const { registrations, warnings } = parseIndexRegistrations(source);
  assert.deepEqual(registrations.map((r) => r.functionName), ["registerFooRoutes"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /registerBarRoutes.*never called/);
});

// Two separate families (not the same one twice) so each assertion can only pass if its OWN
// call shape is recognized — an earlier version of this test used the same family for both
// shapes, so deleting the wrapper-shape regex entirely still left it green (the app.method()
// shape alone produced the same family, masking the loss). Verified: gutting the wrapper
// alternative from ROUTE_CALL_PATTERN drops these to failing, not just discover-backend-routes'
// own zero-match warning.
test("extractRouteFamilies recognizes the direct app.method(\"path\") shape", () => {
  const source = `
    export function registerFooRoutes(app) {
      app.get("/foo-direct/one", handler);
    }
  `;
  const { families, warnings } = extractRouteFamilies(source);
  assert.deepEqual(families, ["/foo-direct"]);
  assert.deepEqual(warnings, []);
});

test("extractRouteFamilies recognizes the local wrapper method(app, \"path\") shape", () => {
  const source = `
    export function registerBarRoutes(app, deps) {
      post(app, "/bar-wrapper/two", deps, handler);
    }
  `;
  const { families, warnings } = extractRouteFamilies(source);
  assert.deepEqual(families, ["/bar-wrapper"]);
  assert.deepEqual(warnings, []);
});

test("extractRouteFamilies handles a path literal split onto its own line", () => {
  const source = `
    app.post(
      "/fax/callback/:recordId",
      handler
    );
  `;
  const { families } = extractRouteFamilies(source);
  assert.deepEqual(families, ["/fax"]);
});

test("extractRouteFamilies warns instead of silently reporting zero families when nothing matches", () => {
  const { warnings } = extractRouteFamilies("export function registerNothingRoutes() {}");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No route-registration calls recognized/);
});

test("findReExportTarget follows a bare re-export, returns null when there isn't one", () => {
  const reExport = `export { registerFooRoutes } from "./real-foo-routes.js";`;
  assert.equal(findReExportTarget(reExport, "registerFooRoutes"), "./real-foo-routes.js");
  assert.equal(findReExportTarget("export function registerFooRoutes() {}", "registerFooRoutes"), null);
});

test("parseProxyKeys extracts only top-level keys, not nested bypass-function string literals", () => {
  const source = `
    proxy: {
      "/desk": {
        target: mcpTarget,
        bypass(req) {
          if (req.headers.accept.includes("text/html")) return "/index.html";
        },
      },
      "/watchers": { target: mcpTarget },
    },
  `;
  const warnings = [];
  const keys = parseProxyKeys(source, warnings);
  assert.deepEqual(keys, ["/desk", "/watchers"]);
  assert.deepEqual(warnings, []);
});

test("computeProxyCoverageReport flags a backend family with no proxy entry, ignores the reverse", () => {
  const { uncovered } = computeProxyCoverageReport(
    ["/watchers", "/fhir-adjacent"],
    ["/watchers", "/fhir", "/auth"], // /fhir and /auth are proxy-only (external target) — not a defect
  );
  assert.deepEqual(uncovered, ["/fhir-adjacent"]);
});

test("computeProxyCoverageReport reports nothing when every backend family is covered", () => {
  const { uncovered } = computeProxyCoverageReport(["/a", "/b"], ["/a", "/b", "/c"]);
  assert.deepEqual(uncovered, []);
});

// --- Report ---

console.log(`Tier 0 census self-test: ${passed}/${passed + failures.length} passed.`);
if (failures.length > 0) {
  console.log("");
  for (const { name, err } of failures) {
    console.log(`FAIL: ${name}`);
    console.log(`  ${err.message}`);
  }
  process.exitCode = 1;
} else {
  console.log("PASS");
}
