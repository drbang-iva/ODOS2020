#!/usr/bin/env tsx
import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export interface ShippedCptTextFile {
  path: string;
  text: string;
}

export interface ShippedCptFinding {
  path: string;
  line: number;
  token: string;
}

export interface ShippedCptAllowance {
  path: string;
  token: string;
  reason: string;
}

const SHIPPED_ROOTS = ["mcp/src", "ui/src", "data"] as const;
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs",
  ".sh", ".sql", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const LEXICAL_EXTENSIONS = new Set([".cjs", ".js", ".json", ".jsx", ".mjs", ".ts", ".tsx"]);

export const SHIPPED_CPT_ALLOWANCES: readonly ShippedCptAllowance[] = [
  { path: "mcp/src/claims/billing-identity-config.ts", token: "80840", reason: "Synthetic billing-identity prefix before an NPI." },
  { path: "mcp/src/comms/adapters/twilio-adapter.ts", token: "21610", reason: "Twilio opted-out-recipient error identifier." },
  { path: "mcp/src/comms/suppression-gate.ts", token: "10000", reason: "Communication search row bound." },
  { path: "mcp/src/index.ts", token: "65535", reason: "Maximum TCP port in a validation message." },
  { path: "mcp/src/reminders/reminder-engine.ts", token: "10000", reason: "Reminder search row bound." },
  { path: "mcp/src/reminders/reminder-engine.ts", token: "15000", reason: "Reminder worker minimum interval." },
  { path: "mcp/src/smart/authorization-server.ts", token: "86400", reason: "SMART metadata cache duration in seconds." },
  { path: "ui/src/scenes/settings/billing-identity-config.ts", token: "80840", reason: "Synthetic billing-identity prefix before an NPI." },
  { path: "data/migrations/2026-04-29-v05b-odos-audit-events.sql", token: "42501", reason: "PostgreSQL insufficient-privilege SQLSTATE." },
  { path: "data/migrations/2026-05-09-v06a-frames-data.sql", token: "42501", reason: "PostgreSQL insufficient-privilege SQLSTATE." },
];

export function findShippedCptLiterals(
  files: readonly ShippedCptTextFile[],
  allowances: readonly ShippedCptAllowance[] = SHIPPED_CPT_ALLOWANCES,
): ShippedCptFinding[] {
  const allowed = new Set(allowances.map((entry) => `${normalizePath(entry.path)}\0${entry.token}`));
  const findings: ShippedCptFinding[] = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    for (const segment of scannedSegments(path, file.text)) {
      const pattern = /(?<![A-Za-z0-9-])(?:[0-9]{5}|[0-9]{4}[FT])(?![A-Za-z0-9-])/g;
      for (const match of segment.text.matchAll(pattern)) {
        const token = match[0];
        const index = match.index ?? 0;
        if (insideExternalIdentifier(segment.text, index)) continue;
        if (allowed.has(`${path}\0${token}`)) continue;
        const absoluteOffset = segment.offset + index;
        findings.push({
          path,
          line: file.text.slice(0, absoluteOffset).split("\n").length,
          token,
        });
      }
    }
  }
  return findings;
}

export function scanShippedCptLiterals(repoRoot: string): ShippedCptFinding[] {
  const files = SHIPPED_ROOTS.flatMap((root) => readTree(resolve(repoRoot, root), repoRoot));
  return findShippedCptLiterals(files);
}

export function assertNoShippedCptLiterals(repoRoot: string): void {
  const findings = scanShippedCptLiterals(repoRoot);
  if (!findings.length) return;
  throw new Error(findings.map((finding) =>
    `Forbidden shipped CPT-shaped token ${finding.token} at ${finding.path}:${finding.line}`
  ).join("\n"));
}

function scannedSegments(path: string, text: string): Array<{ text: string; offset: number }> {
  if (!LEXICAL_EXTENSIONS.has(extname(path).toLowerCase())) return [{ text, offset: 0 }];
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const segments: Array<{ text: string; offset: number }> = [];
  const commentOffsets = new Set<number>();
  const addComments = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (commentOffsets.has(range.pos)) continue;
      commentOffsets.add(range.pos);
      segments.push({ text: text.slice(range.pos, range.end), offset: range.pos });
    }
  };
  const visit = (node: ts.Node): void => {
    addComments(ts.getLeadingCommentRanges(text, node.getFullStart()));
    addComments(ts.getTrailingCommentRanges(text, node.end));
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      const offset = node.getStart(source);
      segments.push({ text: text.slice(offset, node.end), offset });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return segments;
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".cjs":
    case ".mjs": return ts.ScriptKind.JS;
    case ".json": return ts.ScriptKind.JSON;
    default: return ts.ScriptKind.TS;
  }
}

function insideExternalIdentifier(text: string, index: number): boolean {
  const pattern = /(?:https?:\/\/|doi:)[^\s"'`<>]+/gi;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (index >= start && index < start + match[0].length) return true;
  }
  return false;
}

function readTree(root: string, repoRoot: string): ShippedCptTextFile[] {
  const files: ShippedCptTextFile[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = resolve(root, entry.name);
    const path = normalizePath(relative(repoRoot, absolute));
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "tests") continue;
      files.push(...readTree(absolute, repoRoot));
      continue;
    }
    if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    if (path.startsWith("data/code-bindings/") && path.endsWith(".md")) continue;
    files.push({ path, text: readFileSync(absolute, "utf8") });
  }
  return files;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  try {
    assertNoShippedCptLiterals(repoRoot);
    console.log("Shipped CPT literal guard: clean.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
