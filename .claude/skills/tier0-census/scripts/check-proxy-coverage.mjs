#!/usr/bin/env node
// Tier 0 dead-control census — proxy-coverage check.
//
// Closes the actual root cause behind four real bugs shipped in one day: mcp/src/index.ts's
// register*Routes calls and ui/vite.config.ts's proxy table are two hand-maintained lists, and
// nothing reported when they drifted. /watchers and /communications both shipped with a real
// backend registration and no proxy entry, silently returning 200 text/html instead of reaching
// the server; /inventory and /comms shipped the same gap and were caught only by manual or
// evaluator runs, not CI. See performance-od's
// decisions/2026-09-02-odos-watchers-route-missing-from-proxy-table.md.
//
// CI-reporting only, same advisory-first discipline as check-manifest.mjs — findings become
// GitHub Actions annotations but always exit 0 pending burn-in and a separate blocking decision.
//
// Usage: node check-proxy-coverage.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBackendRouteFamilies } from "./discover-backend-routes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const VITE_CONFIG = resolve(REPO_ROOT, "ui/vite.config.ts");

// Pure: given vite.config.ts's source text, extracts the top-level keys of its `proxy: { ... }`
// object. Matches only lines shaped `"/key": {` — the multi-line entries (/audit, /desk, /clinic)
// have target/changeOrigin/bypass properties inside them that never take this shape, so a
// per-line regex is safe here without full brace-depth tracking.
export function parseProxyKeys(source, warnings) {
  const headerPattern = /proxy\s*:\s*\{/;
  const headerMatch = headerPattern.exec(source);
  if (!headerMatch) {
    warnings.push(`Could not find a "proxy: { ... }" block in ${VITE_CONFIG} — the server config may have been restructured. Proxy-key discovery returned nothing.`);
    return [];
  }
  const braceStart = headerMatch.index + headerMatch[0].length - 1;
  let depth = 0;
  let block = null;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        block = source.slice(braceStart + 1, i);
        break;
      }
    }
  }
  if (block === null) {
    warnings.push(`Found "proxy: {" in ${VITE_CONFIG} but never found its matching closing brace. Proxy-key discovery returned nothing.`);
    return [];
  }

  const keys = new Set();
  const keyPattern = /^\s*"(\/[^"]+)"\s*:\s*\{/gm;
  let match;
  while ((match = keyPattern.exec(block)) !== null) keys.add(match[1]);
  return [...keys].sort();
}

function loadProxyKeys(warnings) {
  let source;
  try {
    source = readFileSync(VITE_CONFIG, "utf8");
  } catch (err) {
    warnings.push(`Could not read ${VITE_CONFIG}: ${err.message}.`);
    return [];
  }
  return parseProxyKeys(source, warnings);
}

// Pure: diffs discovered backend route families against the proxy table's keys. A proxy key with
// no matching backend family is NOT reported as a problem — several entries (/fhir, /auth,
// /oauth2) intentionally target a different service (Medplum, not the ODOS mcp server) and are
// correctly outside this census's scope. Only the direction that produced three real bugs —
// backend family, no proxy entry — is a finding.
export function computeProxyCoverageReport(backendFamilies, proxyKeys) {
  const proxyKeySet = new Set(proxyKeys);
  const uncovered = backendFamilies.filter((family) => !proxyKeySet.has(family));
  return { uncovered };
}

function emitActionsWarning(file, title, message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning file=${file},title=${title}::${message}`);
  }
}

function main() {
  const warnings = [];
  const { families: backendFamilies, byRegistration, warnings: discoveryWarnings } = discoverBackendRouteFamilies();
  warnings.push(...discoveryWarnings);
  const proxyKeys = loadProxyKeys(warnings);
  const { uncovered } = computeProxyCoverageReport(backendFamilies, proxyKeys);

  console.log(`Proxy-coverage census — ${backendFamilies.length} backend route famil${backendFamilies.length === 1 ? "y" : "ies"} discovered, ${proxyKeys.length} proxy table entr${proxyKeys.length === 1 ? "y" : "ies"}.\n`);

  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s):`);
    for (const warning of warnings) {
      console.log(`  ! ${warning}`);
      emitActionsWarning(
        ".claude/skills/tier0-census/scripts/check-proxy-coverage.mjs",
        "Proxy coverage diagnostic",
        warning,
      );
    }
    console.log("");
  }

  if (uncovered.length > 0) {
    console.log(`${uncovered.length} backend route famil${uncovered.length === 1 ? "y has" : "ies have"} NO proxy table entry — this is the exact shape of the /watchers, /communications, /inventory, and /comms bugs:`);
    for (const family of uncovered) {
      // A family can have more than one registration (/comms has three) — list all of them, not
      // just the first, or a fix targeting the wrong owner ships against incomplete information.
      const owners = byRegistration.filter((r) => r.families.includes(family));
      const ownerText = owners.map((o) => `${o.functionName}, ${o.importPath}`).join("; ");
      console.log(`  ! ${family}${ownerText ? ` (registered by ${ownerText})` : ""}`);
      emitActionsWarning(
        "ui/vite.config.ts",
        "Proxy coverage gap",
        `Backend route family ${family} has no matching Vite proxy entry.`,
      );
    }
    console.log("");
  } else if (warnings.length === 0) {
    console.log("Every backend route family has a proxy table entry.\n");
  } else {
    console.log("Coverage result incomplete — resolve the diagnostic warning(s) above before treating this run as clean.\n");
  }

  console.log("Reporting only — CI annotates findings, but this check never fails the build.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    const message = `Proxy-coverage census hit an unexpected internal error and could not complete: ${err instanceof Error ? err.message : String(err)}`;
    console.log(message);
    emitActionsWarning(
      ".claude/skills/tier0-census/scripts/check-proxy-coverage.mjs",
      "Proxy coverage internal error",
      message,
    );
    console.log("Reporting only — this check never fails the build. Reporting the error above instead.");
  }
}
