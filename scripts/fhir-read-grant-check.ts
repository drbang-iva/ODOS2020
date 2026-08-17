#!/usr/bin/env tsx
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  readonly excludedNonFhirCallSites: readonly string[];
  readonly grantedResourceTypes: readonly string[];
  readonly missingResourceTypes: readonly string[];
  readonly sourceRoots: readonly string[];
  readonly includedExtensions: readonly string[];
  readonly excludedDirectoryNames: readonly string[];
  readonly limitations: readonly string[];
}

export interface NonFhirLiteralCallSite {
  readonly path: string;
  readonly callee: string;
  readonly literal: string;
  readonly reason: string;
}

export const SERVICE_IDENTITY_ONLY_RESOURCE_TYPES = [
  {
    resourceType: "ProjectMembership",
    reason: "service identity authorization context",
  },
  {
    resourceType: "User",
    reason: "service identity account resolution",
  },
] as const;

export const NON_FHIR_LITERAL_CALL_SITES = [] as const satisfies readonly NonFhirLiteralCallSite[];

export const FHIR_READ_GRANT_LIMITATIONS = [
  "Computed read resourceTypes escape this scan.",
  "A computed search is marker-checked only when its argument is named resourceType, resource_type, or .resourceType; other names escape because receiver-independent matching would misclassify non-FHIR search APIs.",
  "Marked helper propagation follows named parameters; destructured or object-property resourceType forwarding escapes this scan.",
  "Marked helper propagation is function-name based across scanned roots; same-named non-FHIR helpers require the explicit call-site allowlist.",
  "This proves a grant exists, not that its scope is correct; a wrong-compartment grant can still 403 at runtime.",
] as const;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = ["mcp/src", "ui/src"] as const;
const INCLUDED_EXTENSIONS = [".ts", ".tsx"] as const;
const EXCLUDED_DIRECTORY_NAMES = ["__tests__"] as const;

export function collectLiteralFhirReadResourceTypes(
  files: readonly FhirReadSourceFile[],
  nonFhirCallSites: readonly NonFhirLiteralCallSite[] = NON_FHIR_LITERAL_CALL_SITES,
): readonly string[] {
  return collectFhirReadUsage(files, nonFhirCallSites).resourceTypes;
}

function collectFhirReadUsage(
  files: readonly FhirReadSourceFile[],
  nonFhirCallSites: readonly NonFhirLiteralCallSite[],
): {
  readonly resourceTypes: readonly string[];
  readonly excludedNonFhirCallSites: readonly string[];
} {
  const resourceTypes = new Set<string>();
  const excludedNonFhirCallSites = new Set<string>();
  const matchedNonFhirCallSites = new Set<NonFhirLiteralCallSite>();
  const sourceFiles = files.map((file) => ({
    file,
    source: ts.createSourceFile(
      file.path,
      file.text,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }));
  const markedSearchHelpers = new Map<string, Set<number>>();

  for (const { file, source } of sourceFiles) {
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === "read" || node.expression.name.text === "search")
      ) {
        const resourceType = stringLiteral(node.arguments[0]);
        if (resourceType) {
          addLiteralResourceType({
            file,
            source,
            node,
            resourceType,
            nonFhirCallSites,
            matchedNonFhirCallSites,
            excludedNonFhirCallSites,
            resourceTypes,
          });
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
          if (helper) markSearchHelper(markedSearchHelpers, helper);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  let discoveredHelper = markedSearchHelpers.size > 0;
  while (discoveredHelper) {
    discoveredHelper = false;
    for (const { file, source } of sourceFiles) {
      function visitHelperCalls(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const name = calledName(node.expression);
          const parameterIndices = name ? markedSearchHelpers.get(name) : undefined;
          for (const parameterIndex of parameterIndices ?? []) {
            const resourceTypeArgument = node.arguments[parameterIndex];
            const resourceType = stringLiteral(resourceTypeArgument);
            if (resourceType) {
              addLiteralResourceType({
                file,
                source,
                node,
                resourceType,
                nonFhirCallSites,
                matchedNonFhirCallSites,
                excludedNonFhirCallSites,
                resourceTypes,
              });
            } else {
              const helper = forwardingSearchHelper(node, resourceTypeArgument);
              if (helper) {
                discoveredHelper = markSearchHelper(markedSearchHelpers, helper) || discoveredHelper;
              }
            }
          }
        }
        ts.forEachChild(node, visitHelperCalls);
      }
      visitHelperCalls(source);
    }
  }

  for (const callSite of nonFhirCallSites) {
    if (!matchedNonFhirCallSites.has(callSite)) {
      throw new Error(
        `Non-FHIR call-site allowlist entry no longer matches source: ${callSite.path} ${callSite.callee}("${callSite.literal}").`,
      );
    }
  }

  return {
    resourceTypes: [...resourceTypes].sort(),
    excludedNonFhirCallSites: [...excludedNonFhirCallSites].sort(),
  };
}

export function findMissingFhirReadGrants(
  readResourceTypes: readonly string[],
  grantedResourceTypes: readonly string[],
): readonly string[] {
  const granted = new Set(grantedResourceTypes);
  return [...new Set(readResourceTypes)].filter((resourceType) => !granted.has(resourceType)).sort();
}

export function runFhirReadGrantCheck(): FhirReadGrantCheckResult {
  const usage = collectFhirReadUsage(readProductSourceFiles(), NON_FHIR_LITERAL_CALL_SITES);
  const discoveredResourceTypes = usage.resourceTypes;
  const serviceIdentityOnlyResourceTypes = new Set<string>(
    SERVICE_IDENTITY_ONLY_RESOURCE_TYPES.map(({ resourceType }) => resourceType),
  );
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
    excludedNonFhirCallSites: usage.excludedNonFhirCallSites,
    grantedResourceTypes,
    missingResourceTypes: findMissingFhirReadGrants(readResourceTypes, grantedResourceTypes),
    sourceRoots: SOURCE_ROOTS,
    includedExtensions: INCLUDED_EXTENSIONS,
    excludedDirectoryNames: EXCLUDED_DIRECTORY_NAMES,
    limitations: FHIR_READ_GRANT_LIMITATIONS,
  };
}

function readProductSourceFiles(): FhirReadSourceFile[] {
  return SOURCE_ROOTS.flatMap((root) => sourcePaths(resolve(REPO_ROOT, root)))
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

function sourcePaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return EXCLUDED_DIRECTORY_NAMES.includes(entry.name as "__tests__") ? [] : sourcePaths(path);
    }
    return entry.isFile() && INCLUDED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
      ? [path]
      : [];
  });
}

function addLiteralResourceType({
  file,
  source,
  node,
  resourceType,
  nonFhirCallSites,
  matchedNonFhirCallSites,
  excludedNonFhirCallSites,
  resourceTypes,
}: {
  file: FhirReadSourceFile;
  source: ts.SourceFile;
  node: ts.CallExpression;
  resourceType: string;
  nonFhirCallSites: readonly NonFhirLiteralCallSite[];
  matchedNonFhirCallSites: Set<NonFhirLiteralCallSite>;
  excludedNonFhirCallSites: Set<string>;
  resourceTypes: Set<string>;
}): void {
  const path = repoRelativePath(file.path);
  const callee = node.expression.getText(source);
  const exclusion = nonFhirCallSites.find((callSite) =>
    callSite.path === path
    && callSite.callee === callee
    && callSite.literal === resourceType
  );
  if (!exclusion) {
    resourceTypes.add(resourceType);
    return;
  }
  matchedNonFhirCallSites.add(exclusion);
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  excludedNonFhirCallSites.add(
    `${path}:${position.line + 1} ${callee}("${resourceType}") — ${exclusion.reason}`,
  );
}

function repoRelativePath(path: string): string {
  const candidate = isAbsolute(path) ? relative(REPO_ROOT, path) : path;
  return candidate.replaceAll("\\", "/").replace(/^\.\//, "");
}

function markSearchHelper(
  helpers: Map<string, Set<number>>,
  helper: { readonly name: string; readonly resourceTypeParameterIndex: number },
): boolean {
  const parameterIndices = helpers.get(helper.name) ?? new Set<number>();
  const previousSize = parameterIndices.size;
  parameterIndices.add(helper.resourceTypeParameterIndex);
  helpers.set(helper.name, parameterIndices);
  return parameterIndices.size !== previousSize;
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
  const status = result.missingResourceTypes.length ? "FAIL" : "PASS";
  const scope = result.sourceRoots.join(" + ");
  const lines = [
    `FHIR read grant check: ${status} (${result.readResourceTypes.length} literal/marked resourceTypes under ${scope})`,
  ];
  if (result.missingResourceTypes.length) {
    lines.push(`Missing resourceType grants: ${result.missingResourceTypes.join(", ")}`);
  }
  lines.push(`Included source extensions: ${result.includedExtensions.join(", ")}`);
  lines.push(`Excluded source directories: ${result.excludedDirectoryNames.join(", ") || "none"}`);
  lines.push(`Excluded source extensions: all except ${result.includedExtensions.join(", ")}`);
  lines.push(
    "Service-identity resourceTypes seen and excluded:",
    ...SERVICE_IDENTITY_ONLY_RESOURCE_TYPES
      .filter(({ resourceType }) => result.excludedServiceIdentityResourceTypes.includes(resourceType))
      .map(({ resourceType, reason }) => `- ${resourceType} — ${reason}`),
  );
  if (result.excludedServiceIdentityResourceTypes.length === 0) lines.push("- none");
  lines.push("Non-FHIR literal call sites excluded:");
  lines.push(...(result.excludedNonFhirCallSites.length ? result.excludedNonFhirCallSites.map((item) => `- ${item}`) : ["- none"]));
  lines.push("Limitations:", ...result.limitations.map((limitation) => `- ${limitation}`));
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runFhirReadGrantCheck();
  console.log(renderResult(result));
  if (result.missingResourceTypes.length > 0) process.exitCode = 1;
}
