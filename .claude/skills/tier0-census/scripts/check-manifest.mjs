#!/usr/bin/env node
// Tier 0 dead-control census — anti-rot check.
//
// The trick this whole tier depends on: a route the app actually serves but that has no *reviewed*
// entry in manifest.json is ITSELF the finding. That inverts the usual failure mode of a
// hand-authored checklist — normally the list quietly falls behind as the app grows past it; here,
// every new unreviewed route raises its hand instead of going silent.
//
// Advisory only (per decisions/2026-09-02-odos-wiring-verification-loop-design.md, "Advisory
// first, always") — this always exits 0. It reports; it does not block. Do not wire this into a
// blocking CI gate without a burn-in period first, same discipline as Tier 2's live-authz lane.
//
// Usage: node check-manifest.mjs
//
// Run this script's self-test (self-test.mjs) after touching either file here — it locks in the
// three defects an independent evaluation found in the first version: a valid single-quoted route
// silently vanishing, a non-"reviewed" or duplicate entry inflating coverage past 1.0, and a
// malformed manifest or reformatted switch statement crashing instead of degrading.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRoutes } from "./discover-routes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, "../manifest.json");

// Never throws. A malformed manifest is a finding to report, not a crash — this tool's whole
// promise is "advisory only, always exits 0," and that promise has to hold even when the file it
// reads is broken.
function loadManifest(warnings) {
  let raw;
  try {
    raw = readFileSync(MANIFEST_PATH, "utf8");
  } catch (err) {
    warnings.push(`Could not read ${MANIFEST_PATH}: ${err.message}. Treating the manifest as empty.`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(`${MANIFEST_PATH} is not valid JSON (${err.message}). Treating the manifest as empty.`);
    return [];
  }
  if (!Array.isArray(parsed.routes)) {
    warnings.push(`${MANIFEST_PATH} is malformed — expected a top-level "routes" array. Treating the manifest as empty.`);
    return [];
  }
  return parsed.routes;
}

// Validates and deduplicates raw manifest entries. Only an entry with a non-empty string `route`
// AND `status === "reviewed"` counts toward coverage — an entry with any other status (or a
// missing/malformed one) is not silently treated as reviewed just because it exists. A route
// listed more than once is reported as a duplicate finding rather than inflating the count.
export function normalizeManifestEntries(rawEntries, warnings) {
  const seenRoutes = new Map(); // route -> first entry's status
  const duplicates = new Set();
  const conflicts = new Set();
  const malformed = [];
  const reviewed = new Set();

  for (const entry of rawEntries) {
    if (typeof entry !== "object" || entry === null || typeof entry.route !== "string" || entry.route.length === 0) {
      malformed.push(entry);
      continue;
    }
    if (seenRoutes.has(entry.route)) {
      duplicates.add(entry.route);
      if (seenRoutes.get(entry.route) !== entry.status) conflicts.add(entry.route);
    } else {
      seenRoutes.set(entry.route, entry.status);
    }
    if (entry.status === "reviewed") {
      reviewed.add(entry.route);
    } else if (entry.status === undefined) {
      warnings.push(`Manifest entry for "${entry.route}" has no "status" field — not counted as reviewed. Add "status": "reviewed" once it's actually been walked.`);
    } else if (entry.status !== "reviewed") {
      warnings.push(`Manifest entry for "${entry.route}" has status "${entry.status}", not "reviewed" — not counted as coverage.`);
    }
  }

  for (const route of conflicts) reviewed.delete(route);
  if (conflicts.size > 0) {
    warnings.push(`${conflicts.size} route(s) have conflicting statuses — treated as unreviewed until the entries agree: ${[...conflicts].join(", ")}`);
  }

  if (malformed.length > 0) {
    warnings.push(`${malformed.length} manifest entr${malformed.length === 1 ? "y is" : "ies are"} malformed (missing or non-string "route") and ${malformed.length === 1 ? "was" : "were"} ignored: ${JSON.stringify(malformed)}`);
  }
  if (duplicates.size > 0) {
    warnings.push(`${duplicates.size} route(s) have more than one manifest entry (duplicates counted once, not once per entry): ${[...duplicates].join(", ")}`);
  }

  return { allRoutePaths: [...seenRoutes.keys()], reviewedRoutePaths: reviewed };
}

// Pure: takes the already-discovered app routes and the raw (unvalidated) manifest entries,
// returns the report shape with no I/O. This is what self-test.mjs exercises directly against
// synthetic inputs — main() below is the thin production wrapper that supplies real discovery
// output and the real manifest file's contents.
export function computeCensusReport(appRoutes, rawEntries) {
  const warnings = [];
  const { allRoutePaths: manifestRoutePaths, reviewedRoutePaths } = normalizeManifestEntries(rawEntries, warnings);

  const appRouteSet = new Set(appRoutes);
  const unlisted = appRoutes.filter((route) => !reviewedRoutePaths.has(route));
  const stale = manifestRoutePaths.filter((route) => !appRouteSet.has(route));
  // Coverage numerator: routes that are BOTH currently served by the app AND marked reviewed.
  // A stale "reviewed" entry (route no longer exists) does not inflate this past appRoutes.length.
  const coveredCount = appRoutes.filter((route) => reviewedRoutePaths.has(route)).length;

  return { warnings, manifestRoutePaths, unlisted, stale, coveredCount };
}

function main() {
  const { routes: appRoutes, warnings: discoveryWarnings } = discoverRoutes();
  const manifestWarnings = [];
  const rawEntries = loadManifest(manifestWarnings);

  const { warnings: reportWarnings, manifestRoutePaths, unlisted, stale, coveredCount } = computeCensusReport(appRoutes, rawEntries);
  const warnings = [...discoveryWarnings, ...manifestWarnings, ...reportWarnings];

  console.log(`Tier 0 dead-control census — ${appRoutes.length} route(s) discovered, ${manifestRoutePaths.length} manifest entr${manifestRoutePaths.length === 1 ? "y" : "ies"}.\n`);

  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s):`);
    for (const warning of warnings) console.log(`  ! ${warning}`);
    console.log("");
  }

  if (unlisted.length > 0) {
    console.log(`${unlisted.length} route(s) served by the app with NO reviewed manifest entry (unreviewed — advisory finding, not a failure):`);
    for (const route of unlisted) console.log(`  ? ${route}`);
    console.log("");
  } else if (appRoutes.length > 0) {
    console.log("Every discovered route has a reviewed manifest entry.\n");
  }

  if (stale.length > 0) {
    console.log(`${stale.length} manifest entr${stale.length === 1 ? "y" : "ies"} reference${stale.length === 1 ? "s" : ""} a route RouteSwitch no longer serves (stale — the route was removed or renamed, update or delete the entry):`);
    for (const route of stale) console.log(`  x ${route}`);
    console.log("");
  }

  console.log(`Coverage: ${coveredCount}/${appRoutes.length} routes reviewed.`);
  console.log("Advisory only — this check never fails the build. See SKILL.md for how to act on findings.");
}

// --- CLI entry point --- only runs main() when executed directly, not when imported (self-test.mjs
// imports computeCensusReport/normalizeManifestEntries and must not trigger a real census run as a
// side effect of that import).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    // Belt and suspenders: the contract is "advisory only, always exits 0." Every known throw site
    // above has been removed, but nothing here should ever crash a caller regardless.
    console.log(`Tier 0 census hit an unexpected internal error and could not complete: ${err.message}`);
    console.log("Advisory only — this check never fails the build. Reporting the error above instead.");
  }
}
