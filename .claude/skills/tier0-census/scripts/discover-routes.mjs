#!/usr/bin/env node
// Tier 0 dead-control census — route discovery.
//
// Extracts the canonical route inventory directly from ui/src/App.tsx's `switch (path)` block
// (RouteSwitch), instead of hand-maintaining a separate route list. That list would itself be one
// more guard that rots silently as routes are added — the exact disease this whole tier exists to
// catch. Discovery reads the same source the router reads, so it cannot fall behind the app.
//
// Usage: node discover-routes.mjs [--json]
//   --json   emit machine-readable JSON ({ routes: string[], warnings: string[] }) instead of
//            a human-readable list. check-manifest.mjs uses this mode.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// This skill lives at <repo>/.claude/skills/tier0-census/scripts/ — walk up to the repo root.
const REPO_ROOT = resolve(__dirname, "../../../..");
const APP_TSX = resolve(REPO_ROOT, "ui/src/App.tsx");

// Tolerant of whitespace/newline variation around "switch (path) {" — a reformat (prettier rerun,
// multi-line signature) must not crash this tool. Returns null + a warning instead of throwing;
// discoverRoutes() must never throw, since check-manifest.mjs promises "advisory only, always
// exits 0" and a thrown exception would break that promise for any caller.
function extractSwitchBlock(source, warnings) {
  const headerPattern = /switch\s*\(\s*path\s*\)\s*\{/;
  const headerMatch = headerPattern.exec(source);
  if (!headerMatch) {
    warnings.push(`Could not find a "switch (path) { ... }" block in ${APP_TSX} — RouteSwitch may have been renamed or restructured. Route discovery returned nothing; this script needs updating to match.`);
    return null;
  }
  const braceStart = headerMatch.index + headerMatch[0].length - 1;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  warnings.push(`Found "switch (path) {" in ${APP_TSX} but never found its matching closing brace — unbalanced braces. Route discovery returned nothing.`);
  return null;
}

function resolvePathConstant(identifier, warnings) {
  // Route cases sometimes use a named constant (e.g. `case DESK_HOME_PATH:`) instead of a string
  // literal, so the export it points to has to be resolved to get the actual URL path. Search the
  // whole ui/src tree for `(export )?const <IDENT> = "<value>"`.
  const candidates = grepConstant(identifier);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    warnings.push(`Route case uses identifier "${identifier}" but no "const ${identifier} = \"...\"" was found under ui/src — route omitted, census is incomplete until this resolves.`);
    return null;
  }
  warnings.push(`Route case uses identifier "${identifier}" but it resolves to ${candidates.length} different definitions (${candidates.join(", ")}) — ambiguous, route omitted.`);
  return null;
}

function grepConstant(identifier) {
  // Minimal recursive grep, no shelling out — keeps this script dependency-free.
  const found = new Set();
  const pattern = new RegExp(`(?:export\\s+)?const\\s+${identifier}\\s*=\\s*"([^"]+)"`);
  walk(resolve(REPO_ROOT, "ui/src"), (file) => {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;
    const text = readFileSync(file, "utf8");
    const match = pattern.exec(text);
    if (match) found.add(match[1]);
  });
  return [...found];
}

function walk(dir, onFile) {
  for (const entry of readDirSafe(dir)) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

function readDirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Recognizes a `case`'s value as one of: a double-quoted literal, a single-quoted literal, or a
// bare identifier resolved via resolvePathConstant. Anything else (a template literal, a computed
// expression, a typo) is reported as a warning rather than silently dropped — a route case this
// script can't parse must not disappear from the census without a trace.
function parseCaseValue(rawValue, warnings, rawLineForContext, resolveIdentifier) {
  const trimmed = rawValue.trim();
  const doubleQuoted = /^"([^"]*)"$/.exec(trimmed);
  if (doubleQuoted) return doubleQuoted[1];
  const singleQuoted = /^'([^']*)'$/.exec(trimmed);
  if (singleQuoted) return singleQuoted[1];
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/.exec(trimmed);
  if (identifier) return resolveIdentifier(trimmed, warnings);
  warnings.push(`Could not parse a route out of case value "${trimmed}" (line: ${rawLineForContext.trim()}) — this route is OMITTED from the census, not silently counted as covered. Fix this script if it's a legitimate new case shape.`);
  return null;
}

// Pure parsing core, no filesystem access — takes the App.tsx source text and an identifier
// resolver as plain arguments so it can be unit-tested against synthetic fixtures (see
// self-test.mjs) without touching the real repo. discoverRoutes() below is the thin production
// wrapper that supplies the real file and the real ui/src grep-based resolver.
export function parseRouteSwitchSource(source, resolveIdentifier) {
  const warnings = [];
  const block = extractSwitchBlock(source, warnings);
  if (block === null) return { routes: [], warnings };

  const routes = new Set();
  // Process case-by-case rather than with one global regex: every case in this file is a single
  // physical line ("case <value>:"), and per-line parsing lets an unrecognized shape raise a
  // warning instead of just not matching and vanishing.
  const caseLinePattern = /^\s*case\s+(.+?)\s*:\s*(?:\{)?\s*$/;
  for (const line of block.split(/\r?\n/)) {
    if (!/^\s*case\s/.test(line)) continue;
    const match = caseLinePattern.exec(line);
    if (!match) {
      warnings.push(`Could not parse case line: "${line.trim()}" — OMITTED from the census, not silently counted as covered.`);
      continue;
    }
    const resolved = parseCaseValue(match[1], warnings, line, resolveIdentifier);
    if (resolved !== null) routes.add(resolved);
  }

  return { routes: [...routes].sort(), warnings };
}

export function discoverRoutes() {
  if (!existsSync(APP_TSX)) {
    return { routes: [], warnings: [`${APP_TSX} does not exist — is this running from inside the ODOS2020 repo? Route discovery returned nothing.`] };
  }
  const source = readFileSync(APP_TSX, "utf8");
  return parseRouteSwitchSource(source, resolvePathConstant);
}

// --- CLI entry point ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const asJson = process.argv.includes("--json");
  const { routes, warnings } = discoverRoutes();
  if (asJson) {
    console.log(JSON.stringify({ routes, warnings }, null, 2));
  } else {
    console.log(`Discovered ${routes.length} route(s) from ui/src/App.tsx's RouteSwitch:\n`);
    for (const route of routes) console.log(`  ${route}`);
    if (warnings.length > 0) {
      console.log(`\n${warnings.length} warning(s):`);
      for (const warning of warnings) console.log(`  ! ${warning}`);
    }
  }
  if (warnings.length > 0) process.exitCode = 1;
}
