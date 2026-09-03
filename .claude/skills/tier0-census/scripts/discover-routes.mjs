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

function extractSwitchBlock(source, switchHeader) {
  const headerIndex = source.indexOf(switchHeader);
  if (headerIndex === -1) {
    throw new Error(`Could not find "${switchHeader}" in ${APP_TSX}. RouteSwitch may have been renamed or restructured — this script needs updating to match.`);
  }
  const braceStart = source.indexOf("{", headerIndex);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error(`Unbalanced braces walking "${switchHeader}" from ${APP_TSX}.`);
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

export function discoverRoutes() {
  if (!existsSync(APP_TSX)) {
    throw new Error(`${APP_TSX} does not exist — is this running from inside the ODOS2020 repo?`);
  }
  const source = readFileSync(APP_TSX, "utf8");
  const block = extractSwitchBlock(source, "switch (path) {");

  const warnings = [];
  const routes = new Set();
  const caseLine = /case\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*:/g;
  let match;
  while ((match = caseLine.exec(block)) !== null) {
    const [, literal, identifier] = match;
    if (literal) {
      routes.add(literal);
    } else if (identifier) {
      const resolved = resolvePathConstant(identifier, warnings);
      if (resolved) routes.add(resolved);
    }
  }

  return { routes: [...routes].sort(), warnings };
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
