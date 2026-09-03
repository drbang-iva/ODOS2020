#!/usr/bin/env node
// Tier 0 dead-control census — anti-rot check.
//
// The trick this whole tier depends on: a route the app actually serves but that has no entry in
// manifest.json is ITSELF the finding. That inverts the usual failure mode of a hand-authored
// checklist — normally the list quietly falls behind as the app grows past it; here, every new
// unreviewed route raises its hand instead of going silent.
//
// Advisory only (per decisions/2026-09-02-odos-wiring-verification-loop-design.md, "Advisory
// first, always") — this always exits 0. It reports; it does not block. Do not wire this into a
// blocking CI gate without a burn-in period first, same discipline as Tier 2's live-authz lane.
//
// Usage: node check-manifest.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRoutes } from "./discover-routes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, "../manifest.json");

function loadManifest() {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.routes)) {
    throw new Error(`${MANIFEST_PATH} is malformed — expected a top-level "routes" array.`);
  }
  return parsed;
}

const { routes: appRoutes, warnings } = discoverRoutes();
const manifest = loadManifest();
const manifestRoutePaths = new Set(manifest.routes.map((entry) => entry.route));

const unlisted = appRoutes.filter((route) => !manifestRoutePaths.has(route));
const stale = manifest.routes
  .map((entry) => entry.route)
  .filter((route) => !appRoutes.includes(route));

console.log(`Tier 0 dead-control census — ${appRoutes.length} route(s) discovered, ${manifest.routes.length} manifest entr${manifest.routes.length === 1 ? "y" : "ies"}.\n`);

if (warnings.length > 0) {
  console.log(`${warnings.length} discovery warning(s) — census is incomplete until these resolve:`);
  for (const warning of warnings) console.log(`  ! ${warning}`);
  console.log("");
}

if (unlisted.length > 0) {
  console.log(`${unlisted.length} route(s) served by the app with NO manifest entry (unreviewed — advisory finding, not a failure):`);
  for (const route of unlisted) console.log(`  ? ${route}`);
  console.log("");
} else {
  console.log("Every discovered route has a manifest entry.\n");
}

if (stale.length > 0) {
  console.log(`${stale.length} manifest entr${stale.length === 1 ? "y" : "ies"} reference${stale.length === 1 ? "s" : ""} a route RouteSwitch no longer serves (stale — the route was removed or renamed, update or delete the entry):`);
  for (const route of stale) console.log(`  x ${route}`);
  console.log("");
}

console.log(`Coverage: ${manifest.routes.length - stale.length}/${appRoutes.length} routes reviewed.`);
console.log("Advisory only — this check never fails the build. See SKILL.md for how to act on findings.");
