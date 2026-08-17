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
  readonly excludedServiceIdentityResourceTypes: readonly string[];
  readonly grantedResourceTypes: readonly string[];
  readonly missingResourceTypes: readonly string[];
  readonly limitations: readonly string[];
}

export const SERVICE_IDENTITY_ONLY_RESOURCE_TYPES = ["ProjectMembership", "User"] as const;

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
    const markedSearchHelpers = new Map<string, number>();

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === "read" || node.expression.name.text === "search")
      ) {
        const resourceType = stringLiteral(node.arguments[0]);
        if (resourceType) {
          resourceTypes.add(resourceType);
        } else if (
          node.expression.name.text === "search"
          && isResourceTypeExpression(node.arguments[0])
        ) {
          if (!searchContractKey(node, source)) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            throw new Error(
              `${file.path}:${position.line + 1} has a computed FHIR search resourceType without a search-contract marker.`,
            );
          }
          const helper = forwardingSearchHelper(node, node.arguments[0]);
          if (helper) markedSearchHelpers.set(helper.name, helper.resourceTypeParameterIndex);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
    let discoveredHelper = markedSearchHelpers.size > 0;
    while (discoveredHelper) {
      discoveredHelper = false;
      function visitHelperCalls(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const name = calledName(node.expression);
          const parameterIndex = name ? markedSearchHelpers.get(name) : undefined;
          if (parameterIndex !== undefined) {
            const resourceTypeArgument = node.arguments[parameterIndex];
            const resourceType = stringLiteral(resourceTypeArgument);
            if (resourceType) {
              resourceTypes.add(resourceType);
            } else {
              const helper = forwardingSearchHelper(node, resourceTypeArgument);
              if (helper && !markedSearchHelpers.has(helper.name)) {
                markedSearchHelpers.set(helper.name, helper.resourceTypeParameterIndex);
                discoveredHelper = true;
              }
            }
          }
        }
        ts.forEachChild(node, visitHelperCalls);
      }
      visitHelperCalls(source);
    }
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
  const discoveredResourceTypes = collectLiteralFhirReadResourceTypes(readMcpSourceFiles());
  const serviceIdentityOnlyResourceTypes = new Set<string>(SERVICE_IDENTITY_ONLY_RESOURCE_TYPES);
  const readResourceTypes = discoveredResourceTypes.filter(
    (resourceType) => !serviceIdentityOnlyResourceTypes.has(resourceType),
  );
  const excludedServiceIdentityResourceTypes = discoveredResourceTypes.filter(
    (resourceType) => serviceIdentityOnlyResourceTypes.has(resourceType),
  );
  const grantedResourceTypes = [...new Set(PRACTICE_ROLE_IDS.flatMap((roleId) =>
    (buildMedplumAccessPolicy(getRoleDeclaration(roleId)).resource ?? [])
      .flatMap((rule) => rule.resourceType ?? []),
  ))].sort();

  return {
    readResourceTypes,
    excludedServiceIdentityResourceTypes,
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

function forwardingSearchHelper(
  node: ts.CallExpression,
  resourceTypeArgument: ts.Expression | undefined,
): { readonly name: string; readonly resourceTypeParameterIndex: number } | undefined {
  const resourceType = unwrappedIdentifier(resourceTypeArgument);
  if (!resourceType) return undefined;

  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isMethodDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
    ) {
      const resourceTypeParameterIndex = current.parameters.findIndex((parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === resourceType.text);
      const name = functionName(current);
      if (name && resourceTypeParameterIndex >= 0) return { name, resourceTypeParameterIndex };
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function unwrappedIdentifier(node: ts.Expression | undefined): ts.Identifier | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return unwrappedIdentifier(node.expression);
  return undefined;
}

function isResourceTypeExpression(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return isResourceTypeExpression(node.expression);
  }
  if (ts.isIdentifier(node)) return node.text === "resourceType" || node.text === "resource_type";
  return ts.isPropertyAccessExpression(node) && node.name.text === "resourceType";
}

function functionName(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): string | undefined {
  if ("name" in node && node.name) {
    if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) return node.name.text;
  }
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return undefined;
}

function calledName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function renderResult(result: FhirReadGrantCheckResult): string {
  const lines = result.missingResourceTypes.length
    ? [
        "FHIR read grant check: FAIL",
        `Missing resourceType grants: ${result.missingResourceTypes.join(", ")}`,
      ]
    : [`FHIR read grant check: PASS (${result.readResourceTypes.length} literal resourceTypes checked)`];
  lines.push(
    `Service-identity resourceTypes seen and excluded: ${result.excludedServiceIdentityResourceTypes.join(", ") || "none"}`,
  );
  lines.push("Limits:", ...result.limitations.map((limitation) => `- ${limitation}`));
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runFhirReadGrantCheck();
  console.log(renderResult(result));
  if (result.missingResourceTypes.length > 0) process.exitCode = 1;
}
