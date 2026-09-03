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
// Runs against synthetic in-memory fixtures only — never touches the real ui/src/App.tsx or the
// real manifest.json. Exits 1 if any assertion fails; exits 0 and prints PASS otherwise.
//
// Usage: node self-test.mjs

import assert from "node:assert/strict";
import { parseRouteSwitchSource } from "./discover-routes.mjs";
import { normalizeManifestEntries, computeCensusReport } from "./check-manifest.mjs";

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
