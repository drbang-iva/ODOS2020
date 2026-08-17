#!/usr/bin/env tsx
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  PRACTICE_ROLE_IDS,
  buildMedplumAccessPolicy,
  getRoleDeclaration,
} from "../mcp/src/authz/roles.js";

export interface FhirReadSourceFile {
  readonly path: string;
  readonly text: string;
}

export interface FhirReadGrantCheckResult {
  readonly readResourceTypes: readonly string[];
  readonly grantedResourceTypes: readonly string[];
  readonly missingResourceTypes: readonly string[];
  readonly limitations: readonly string[];
}

export const FHIR_READ_GRANT_LIMITATIONS = [
  "Literal resourceTypes only; a computed resourceType escapes this scan.",
  "This proves a grant exists, not that its scope is correct; a wrong-compartment grant can still 403 at runtime.",
] as const;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SOURCE_ROOT = resolve(REPO_ROOT, "mcp/src");

export function collectLiteralFhirReadResourceTypes(
  files: readonly FhirReadSourceFile[],
): readonly string[] {
  const resourceTypes = new Set<string>();

  for (const file of files) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === "read" || node.expression.name.text === "search")
        && /(^|\.)fhir$/.test(node.expression.expression.getText(source))
      ) {
        const resourceType = stringLiteral(node.arguments[0]);
        if (resourceType) {
          resourceTypes.add(resourceType);
        } else if (node.expression.name.text === "search" && !searchContractKey(node, source)) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          throw new Error(
            `${file.path}:${position.line + 1} has a computed FHIR search resourceType without a search-contract marker.`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  return [...resourceTypes].sort();
}

export function findMissingFhirReadGrants(
  readResourceTypes: readonly string[],
  grantedResourceTypes: readonly string[],
): readonly string[] {
  const granted = new Set(grantedResourceTypes);
  return [...new Set(readResourceTypes)].filter((resourceType) => !granted.has(resourceType)).sort();
}

export function runFhirReadGrantCheck(): FhirReadGrantCheckResult {
  const readResourceTypes = collectLiteralFhirReadResourceTypes(readMcpSourceFiles());
  const grantedResourceTypes = [...new Set(PRACTICE_ROLE_IDS.flatMap((roleId) =>
    (buildMedplumAccessPolicy(getRoleDeclaration(roleId)).resource ?? [])
      .flatMap((rule) => rule.resourceType ?? []),
  ))].sort();

  return {
    readResourceTypes,
    grantedResourceTypes,
    missingResourceTypes: findMissingFhirReadGrants(readResourceTypes, grantedResourceTypes),
    limitations: FHIR_READ_GRANT_LIMITATIONS,
  };
}

function readMcpSourceFiles(): FhirReadSourceFile[] {
  return sourcePaths(MCP_SOURCE_ROOT).map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

function sourcePaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourcePaths(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return stringLiteral(node.expression);
  return undefined;
}

function searchContractKey(node: ts.CallExpression, source: ts.SourceFile): string | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    const leadingTrivia = source.text.slice(current.getFullStart(), current.getStart(source));
    const match = leadingTrivia.match(/search-contract:\s*([a-z0-9]+(?:[.-][a-z0-9]+)*)/);
    if (match) return match[1];
    current = current.parent;
  }
  return undefined;
}

function renderResult(result: FhirReadGrantCheckResult): string {
  const lines = result.missingResourceTypes.length
    ? [
        "FHIR read grant check: FAIL",
        `Missing resourceType grants: ${result.missingResourceTypes.join(", ")}`,
      ]
    : [`FHIR read grant check: PASS (${result.readResourceTypes.length} literal resourceTypes checked)`];
  lines.push("Limits:", ...result.limitations.map((limitation) => `- ${limitation}`));
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runFhirReadGrantCheck();
  console.log(renderResult(result));
  if (result.missingResourceTypes.length > 0) process.exitCode = 1;
}
