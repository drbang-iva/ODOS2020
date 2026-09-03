#!/usr/bin/env node
// Tier 0 dead-control census — backend route-family discovery.
//
// This is the OTHER side of the same defect class that discover-routes.mjs's route census
// catches: not "does the UI have a control wired to a route," but "does the front-door proxy
// table (ui/vite.config.ts) even carry a route family the backend actually serves." Three real
// instances of this shipped in one day (/watchers, /communications, and a previously-uncounted
// /comms) before this existed — mcp/src/index.ts's register*Routes calls and vite.config.ts's
// proxy table are two hand-maintained lists that drift from each other, and nothing enforced they
// stay in sync. See performance-od's
// decisions/2026-09-02-odos-watchers-route-missing-from-proxy-table.md, "Structural fix, not just
// this instance."
//
// Discovers every route-family prefix (e.g. "/watchers", "/communications") the backend actually
// registers, by parsing mcp/src/index.ts for `register*Routes` imports that are BOTH imported and
// actually called, then reading each resolved file for its literal `app.<method>("/path...")`
// calls. check-proxy-coverage.mjs diffs this against vite.config.ts's proxy table.
//
// Usage: node discover-backend-routes.mjs [--json]

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const INDEX_TS = resolve(REPO_ROOT, "mcp/src/index.ts");
const MCP_SRC = resolve(REPO_ROOT, "mcp/src");

// Pure: given mcp/src/index.ts's source text, finds every `register*Routes` name that is BOTH
// imported (with its source file) AND actually invoked as `functionName(app` somewhere in the
// file. An import with no call site would be dead code, not a live registration — excluded rather
// than falsely reported as a route family.
export function parseIndexRegistrations(indexSource) {
  const warnings = [];
  const registrations = [];

  const importPattern = /^\s*import\s*\{([^}]+)\}\s*from\s*"([^"]+)";?\s*$/gm;
  let match;
  while ((match = importPattern.exec(indexSource)) !== null) {
    const [, namedImports, importPath] = match;
    const names = namedImports.split(",").map((n) => n.trim()).filter(Boolean);
    for (const name of names) {
      if (!/^register[A-Za-z0-9]*Routes$/.test(name)) continue;
      const calledPattern = new RegExp(`\\b${name}\\s*\\(\\s*app\\b`);
      if (!calledPattern.test(indexSource)) {
        warnings.push(`"${name}" is imported from "${importPath}" but never called as ${name}(app, ...) — excluded from the census as dead code, not a live route family. If it's actually called under a different form, this script needs updating.`);
        continue;
      }
      registrations.push({ functionName: name, importPath });
    }
  }

  return { registrations, warnings };
}

// Pure: given a route file's source text, extracts every route-family prefix (the first path
// segment of each literal route-registration call). Scans the whole text rather than line-by-line
// — several of these calls split the path literal onto its own line (mcp/src/fax/fax-routes.ts is
// one real example), so a per-line regex would miss them.
//
// Two call shapes are recognized, both real in this codebase:
//   1. app.get("/path", ...) / app.post(...) / etc. — the direct Express form.
//   2. get(app, "/path", ...) / post(app, ...) / etc. — a local wrapper several route files use
//      (mcp/src/payments/payment-routes.ts and five others), where the bare function name takes
//      `app` as its first argument instead of being a method on it.
const ROUTE_CALL_PATTERN = /\b(?:app\s*\.\s*(?:get|post|put|delete|patch)|(?:get|post|put|delete|patch)\s*\(\s*app\s*,)\s*\(?\s*(?:"([^"]+)"|'([^']+)')/g;

export function extractRouteFamilies(routeFileSource) {
  const warnings = [];
  const families = new Set();
  let match;
  let callCount = 0;
  ROUTE_CALL_PATTERN.lastIndex = 0;
  while ((match = ROUTE_CALL_PATTERN.exec(routeFileSource)) !== null) {
    callCount++;
    const path = match[1] ?? match[2];
    const segment = /^\/([^/]+)/.exec(path);
    if (!segment) {
      warnings.push(`Route literal "${path}" doesn't start with a "/segment" — could not derive a family prefix, omitted.`);
      continue;
    }
    families.add(`/${segment[1]}`);
  }
  if (callCount === 0) {
    warnings.push(`No route-registration calls recognized (neither app.<method>("/path", ...) nor <method>(app, "/path", ...)) — either this file registers routes a third way and this script needs updating, or it re-exports its registration function from elsewhere (see the re-export check in discoverBackendRouteFamilies) and has no route calls of its own.`);
  }
  return { families: [...families].sort(), warnings };
}

// A file that only re-exports its register function from another file
// (`export { registerXRoutes } from "./other-file.js";`) has to be followed to find real route
// calls — mcp/src/clinical-graph/pretest-endpoint.ts is exactly this shape.
export function findReExportTarget(routeFileSource, functionName) {
  const pattern = new RegExp(`export\\s*\\{[^}]*\\b${functionName}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`);
  const match = pattern.exec(routeFileSource);
  return match ? match[1] : null;
}

function resolveImportPath(importPath) {
  // index.ts imports compiled-output-style paths ("./watchers/watcher-routes.js") from TS source
  // — swap the extension and resolve relative to mcp/src.
  const tsPath = importPath.replace(/\.js$/, ".ts");
  return resolve(MCP_SRC, tsPath);
}

export function discoverBackendRouteFamilies() {
  const warnings = [];
  if (!existsSync(INDEX_TS)) {
    return { families: [], byRegistration: [], warnings: [`${INDEX_TS} does not exist — is this running from inside the ODOS2020 repo?`] };
  }
  const indexSource = readFileSync(INDEX_TS, "utf8");
  const { registrations, warnings: registrationWarnings } = parseIndexRegistrations(indexSource);
  warnings.push(...registrationWarnings);

  const allFamilies = new Set();
  const byRegistration = [];
  for (const { functionName, importPath } of registrations) {
    let filePath = resolveImportPath(importPath);
    let currentImportPath = importPath;
    let hops = 0;
    // Follow re-export chains (e.g. pretest-endpoint.ts just re-exports registerPretestVitalsRoutes
    // from pretest-vitals-endpoint.ts). Bounded to prevent an infinite loop on a cycle.
    while (hops < 5 && existsSync(filePath)) {
      const source = readFileSync(filePath, "utf8");
      const reExportTarget = findReExportTarget(source, functionName);
      if (!reExportTarget) break;
      currentImportPath = reExportTarget;
      filePath = resolve(dirname(filePath), reExportTarget.replace(/\.js$/, ".ts"));
      hops++;
    }
    if (hops >= 5) {
      warnings.push(`"${functionName}" re-export chain starting at "${importPath}" didn't resolve within 5 hops — possible cycle, skipped.`);
      continue;
    }
    if (!existsSync(filePath)) {
      warnings.push(`"${functionName}" imports from "${importPath}" (resolved to "${currentImportPath}") but the file does not exist — skipped.`);
      continue;
    }
    const source = readFileSync(filePath, "utf8");
    const { families, warnings: extractWarnings } = extractRouteFamilies(source);
    for (const w of extractWarnings) warnings.push(`${functionName} (${importPath}): ${w}`);
    for (const f of families) allFamilies.add(f);
    byRegistration.push({ functionName, importPath, families });
  }

  return { families: [...allFamilies].sort(), byRegistration, warnings };
}

// --- CLI entry point ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const asJson = process.argv.includes("--json");
  const { families, byRegistration, warnings } = discoverBackendRouteFamilies();
  if (asJson) {
    console.log(JSON.stringify({ families, byRegistration, warnings }, null, 2));
  } else {
    console.log(`Discovered ${families.length} backend route famil${families.length === 1 ? "y" : "ies"} across ${byRegistration.length} registration(s):\n`);
    for (const family of families) console.log(`  ${family}`);
    if (warnings.length > 0) {
      console.log(`\n${warnings.length} warning(s):`);
      for (const warning of warnings) console.log(`  ! ${warning}`);
    }
  }
  if (warnings.length > 0) process.exitCode = 1;
}
