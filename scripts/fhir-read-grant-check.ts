#!/usr/bin/env tsx
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccessPolicyResource } from "@medplum/fhirtypes";
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

export type ScannedFhirInteraction = "read" | "search" | "create" | "update" | "delete" | "patch";
export type RequiredFhirInteraction = Exclude<ScannedFhirInteraction, "patch">;

export interface FhirOperation {
  readonly path: string;
  readonly line: number;
  readonly callee: string;
  readonly interaction: ScannedFhirInteraction;
  readonly requiredInteraction: RequiredFhirInteraction;
  readonly resourceType: string;
  readonly scopeContract?: string;
}

export interface CriteriaScopeCoverage {
  readonly resourceType: string;
  readonly operations: number;
  readonly verified: number;
  readonly notVerified: number;
}

export interface FhirReadGrantCheckResult {
  readonly operations: readonly FhirOperation[];
  readonly readResourceTypes: readonly string[];
  readonly writeResourceTypes: readonly string[];
  readonly excludedServiceIdentityResourceTypes: readonly string[];
  readonly excludedServiceIdentityWriteCallSites: readonly string[];
  readonly suspectedBrokenPracticeRoleWriteCallSites: readonly string[];
  readonly excludedNonFhirCallSites: readonly string[];
  readonly grantedResourceTypes: readonly string[];
  readonly missingResourceTypes: readonly string[];
  readonly missingOperations: readonly FhirOperation[];
  readonly criteriaScopedResourceTypes: readonly string[];
  readonly criteriaScopeCoverage: readonly CriteriaScopeCoverage[];
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

export interface ExactFhirWriteCallSite {
  readonly path: string;
  readonly line: number;
  readonly callee: string;
  readonly resourceType: string;
  readonly reason: string;
}

export interface SuspectedBrokenPracticeRoleWriteCallSite extends ExactFhirWriteCallSite {
  readonly surface: string;
}

export const SERVICE_IDENTITY_ONLY_RESOURCE_TYPES = [
  { resourceType: "ProjectMembership", reason: "service identity authorization context" },
  { resourceType: "User", reason: "service identity account resolution" },
] as const;

export const NON_FHIR_LITERAL_CALL_SITES = [
  {
    path: "mcp/src/bulk-data/router.ts",
    callee: "router.delete",
    literal: "/bulk-export/status/:jobId",
    reason: "Express route registration, not a FHIR delete.",
  },
  {
    path: "mcp/src/clinical-graph/manual-procedure-charge-endpoint.ts",
    callee: "app.patch",
    literal: "/clinical-graph/protocols/encounters/:encounterId/procedure-charges/:proposalId",
    reason: "Express route registration, not a FHIR patch.",
  },
  {
    path: "mcp/src/index.ts",
    callee: "app.patch",
    literal: "/clinical-graph/protocols/:id/draft",
    reason: "Express route registration, not a FHIR patch.",
  },
  {
    path: "mcp/src/referral/referral-routes.ts",
    callee: "app.patch",
    literal: "/referrals/patients/:patientId/:referralId",
    reason: "Express route registration, not a FHIR patch.",
  },
  {
    path: "mcp/src/smart/authorization-server.ts",
    callee: "router.delete",
    literal: "/grants/:grantId",
    reason: "Express route registration, not a FHIR delete.",
  },
  {
    path: "ui/src/scenes/ProtocolLibrary.tsx",
    callee: "url.searchParams.delete",
    literal: "protocol",
    reason: "Browser URLSearchParams mutation, not a FHIR delete.",
  },
] as const satisfies readonly NonFhirLiteralCallSite[];

export const SERVICE_IDENTITY_FHIR_WRITE_CALL_SITES = [
  { path: "mcp/src/authz/liveAudit.ts", line: 448, callee: "client.create", resourceType: "AuditEvent", reason: "Dedicated audit projection client." },
  { path: "mcp/src/authz/liveAudit.ts", line: 457, callee: "(await this.projectionClient).create", resourceType: "AuditEvent", reason: "Dedicated password-authenticated audit projection fallback client." },
  { path: "mcp/src/clinical-graph/protocol-store.ts", line: 139, callee: "this.fhir.delete", resourceType: "Basic", reason: "ProtocolDefinitionStore is constructed with the process service client." },
  { path: "mcp/src/fax/inbound-fax.ts", line: 327, callee: "this.fhir.create", resourceType: "AuditEvent", reason: "Inbound fax triage service receives the explicit serviceFhir client." },
  { path: "mcp/src/fax/inbound-fax.ts", line: 425, callee: "this.fhir.create", resourceType: "AuditEvent", reason: "Inbound fax triage service receives the explicit serviceFhir client." },
  { path: "mcp/src/fax/inbound-fax.ts", line: 445, callee: "this.fhir.create", resourceType: "AuditEvent", reason: "Inbound fax triage service receives the explicit serviceFhir client." },
  { path: "mcp/src/fax/inbound-fax.ts", line: 471, callee: "this.fhir.create", resourceType: "AuditEvent", reason: "Inbound fax triage service receives the explicit serviceFhir client." },
  { path: "mcp/src/index.ts", line: 3153, callee: "fhir.create", resourceType: "VisionPrescription", reason: "MCP process service client." },
  { path: "mcp/src/index.ts", line: 3535, callee: "fhir.create", resourceType: "AllergyIntolerance", reason: "MCP process service client." },
  { path: "mcp/src/index.ts", line: 3589, callee: "fhir.create", resourceType: "CareTeam", reason: "MCP process service client." },
  { path: "mcp/src/index.ts", line: 3738, callee: "fhir.create", resourceType: "DeviceDefinition", reason: "MCP process service client." },
  { path: "mcp/src/index.ts", line: 3766, callee: "fhir.create", resourceType: "ConceptMap", reason: "MCP process service client." },
  { path: "mcp/src/index.ts", line: 3789, callee: "fhir.create", resourceType: "Substance", reason: "MCP process service client." },
  { path: "mcp/src/index.ts", line: 4119, callee: "fhir.create", resourceType: "AdverseEvent", reason: "MCP process service client." },
  { path: "mcp/src/index.ts", line: 5220, callee: "fhir.create", resourceType: "BodyStructure", reason: "MCP process service client." },
  { path: "mcp/src/index.ts", line: 7536, callee: "fhir.patch", resourceType: "AccessPolicy", reason: "Policy sync uses the MCP process service client." },
  { path: "mcp/src/legacy-import/appointment-encounter-import.ts", line: 657, callee: "input.fhir.create", resourceType: "Practitioner", reason: "Operator migration importer service identity." },
  { path: "mcp/src/legacy-import/appointment-encounter-import.ts", line: 674, callee: "input.fhir.update", resourceType: "Practitioner", reason: "Operator migration importer service identity." },
  { path: "mcp/src/legacy-import/ccda-import.ts", line: 394, callee: "input.fhir.create", resourceType: "ImportableResource", reason: "Operator legacy C-CDA importer service identity; generic resolves to the imported resource union." },
  { path: "mcp/src/payments/payment-credit-service.ts", line: 312, callee: "fhir.update", resourceType: "PaymentReconciliation", reason: "Payment lifecycle dependency is the MCP process service client." },
  { path: "mcp/src/referral/referral-endpoint.ts", line: 329, callee: "deps.serviceFhir.create", resourceType: "AuditEvent", reason: "Explicit referral service client." },
  { path: "mcp/src/referral/referral-endpoint.ts", line: 358, callee: "deps.serviceFhir.create", resourceType: "AuditEvent", reason: "Explicit referral service client." },
  { path: "mcp/src/referral/referral-endpoint.ts", line: 566, callee: "deps.serviceFhir.create", resourceType: "AuditEvent", reason: "Explicit referral service client." },
  { path: "mcp/src/referral/referral-endpoint.ts", line: 574, callee: "deps.serviceFhir.create", resourceType: "AuditEvent", reason: "Explicit referral service client." },
  { path: "mcp/src/scheduling/scheduling-resource-service.ts", line: 125, callee: "fhir.update", resourceType: "Schedule", reason: "Scheduling resource service receives the explicit serviceFhir client." },
  { path: "mcp/src/weno/weno-search-routes.ts", line: 173, callee: "deps.serviceFhir.update", resourceType: "MedicationRequest", reason: "WENO service client reserves the message id after authenticated Staff action; audit retains the Staff actor." },
  { path: "mcp/src/weno/weno-search-routes.ts", line: 186, callee: "deps.serviceFhir.update", resourceType: "MedicationRequest", reason: "WENO service client records an indeterminate external outcome; audit retains the Staff actor." },
  { path: "mcp/src/weno/weno-search-routes.ts", line: 214, callee: "deps.serviceFhir.update", resourceType: "MedicationRequest", reason: "WENO service client records the accepted electronic transmission; audit retains the Staff actor." },
  { path: "mcp/src/weno/weno-search-routes.ts", line: 220, callee: "deps.serviceFhir.update", resourceType: "MedicationRequest", reason: "WENO service client records a structured external error; audit retains the Staff actor." },
  { path: "mcp/src/weno/weno-search-routes.ts", line: 293, callee: "deps.serviceFhir.update", resourceType: "MedicationRequest", reason: "WENO service client clears a verified indeterminate reservation; audit retains the Staff actor." },
] as const satisfies readonly ExactFhirWriteCallSite[];

export const SUSPECTED_BROKEN_PRACTICE_ROLE_WRITE_CALL_SITES:
  readonly SuspectedBrokenPracticeRoleWriteCallSite[] = [];

export const FHIR_READ_GRANT_LIMITATIONS = [
  "Computed read resourceTypes escape this scan.",
  "Computed create resources require a generic resource type, an object-literal resourceType, or an fhir-scope-contract marker; other computed creates escape this scan.",
  "Computed update, delete, and patch resourceTypes escape this scan.",
  "A computed search is marker-checked only when its argument is named resourceType, resource_type, or .resourceType; other names escape because receiver-independent matching would misclassify non-FHIR search APIs.",
  "Marked helper propagation follows named parameters; destructured or object-property resourceType forwarding escapes this scan.",
  "Marked helper propagation is function-name based across scanned roots; an imported helper alias escapes unless its local name matches, and same-named non-FHIR helpers require the explicit call-site allowlist.",
  "Type-level comparison does not prove criteria scope; criteria-dependent operations without an exact fhir-scope-contract are counted as NOT SCOPE-VERIFIED.",
] as const;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = ["mcp/src", "ui/src"] as const;
const INCLUDED_EXTENSIONS = [".ts", ".tsx"] as const;
const EXCLUDED_DIRECTORY_NAMES = ["__tests__"] as const;
const SCANNED_INTERACTIONS = new Set<ScannedFhirInteraction>([
  "read", "search", "create", "update", "delete", "patch",
]);
const WRITE_INTERACTIONS = new Set<ScannedFhirInteraction>(["create", "update", "delete", "patch"]);
let excludedNonFhirCallSitesFromLastScan: string[] = [];

export function collectLiteralFhirReadResourceTypes(
  files: readonly FhirReadSourceFile[],
  nonFhirCallSites: readonly NonFhirLiteralCallSite[] = [],
): readonly string[] {
  return uniqueResourceTypes(
    collectFhirOperations(files, nonFhirCallSites).filter((operation) =>
      operation.interaction === "read" || operation.interaction === "search"
    ),
  );
}

export function collectFhirOperations(
  files: readonly FhirReadSourceFile[],
  nonFhirCallSites: readonly NonFhirLiteralCallSite[] = [],
): readonly FhirOperation[] {
  const operations: FhirOperation[] = [];
  const operationKeys = new Set<string>();
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
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const interaction = node.expression.name.text as ScannedFhirInteraction;
        if (SCANNED_INTERACTIONS.has(interaction)) {
          const scopeContract = fhirScopeContract(node, source);
          const resourceType = operationResourceType(node, interaction, scopeContract);
          if (resourceType) {
            addOperation({
              file, source, node, interaction, resourceType, scopeContract,
              nonFhirCallSites, matchedNonFhirCallSites, excludedNonFhirCallSites,
              operations, operationKeys,
            });
          } else if (interaction === "search" && isResourceTypeExpression(node.arguments[0])) {
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
              addOperation({
                file, source, node, interaction: "search", resourceType,
                scopeContract: fhirScopeContract(node, source),
                nonFhirCallSites, matchedNonFhirCallSites, excludedNonFhirCallSites,
                operations, operationKeys,
              });
            } else {
              const helper = forwardingSearchHelper(node, resourceTypeArgument);
              if (helper) discoveredHelper = markSearchHelper(markedSearchHelpers, helper) || discoveredHelper;
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

  excludedNonFhirCallSitesFromLastScan = [...excludedNonFhirCallSites].sort();
  return operations.sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.interaction.localeCompare(right.interaction)
  );
}

export function findMissingFhirReadGrants(
  readResourceTypes: readonly string[],
  grantedResourceTypes: readonly string[],
): readonly string[] {
  const granted = new Set(grantedResourceTypes);
  return [...new Set(readResourceTypes)].filter((resourceType) => !granted.has(resourceType)).sort();
}

export function findMissingFhirOperationGrants(
  operations: readonly FhirOperation[],
  grantedRules: readonly AccessPolicyResource[],
): readonly FhirOperation[] {
  return operations.filter((operation) => !grantedRules.some((rule) =>
    rule.resourceType === operation.resourceType
    && rule.interaction?.includes(operation.requiredInteraction)
    && (!operation.scopeContract || rule.criteria === operation.scopeContract)
  ));
}

export function runFhirReadGrantCheck(): FhirReadGrantCheckResult {
  const discoveredOperations = collectFhirOperations(readProductSourceFiles(), NON_FHIR_LITERAL_CALL_SITES);
  const excludedServiceIdentityWrites = matchExactWriteInventory(
    discoveredOperations.filter((operation) => WRITE_INTERACTIONS.has(operation.interaction)),
    SERVICE_IDENTITY_FHIR_WRITE_CALL_SITES,
    "Service-identity FHIR write exclusion",
  );
  const excludedServiceIdentityOperationSet = new Set(excludedServiceIdentityWrites);
  const serviceIdentityOnlyResourceTypes = new Set<string>(
    SERVICE_IDENTITY_ONLY_RESOURCE_TYPES.map(({ resourceType }) => resourceType),
  );
  const practiceAndUnclassifiedOperations = discoveredOperations.filter((operation) =>
    !serviceIdentityOnlyResourceTypes.has(operation.resourceType)
    && !excludedServiceIdentityOperationSet.has(operation)
  );
  const excludedServiceIdentityResourceTypes = uniqueResourceTypes(
    discoveredOperations.filter((operation) => serviceIdentityOnlyResourceTypes.has(operation.resourceType)),
  );
  const grantedRules = PRACTICE_ROLE_IDS.flatMap((roleId) =>
    buildMedplumAccessPolicy(getRoleDeclaration(roleId)).resource ?? []
  );
  const rawMissingOperations = findMissingFhirOperationGrants(practiceAndUnclassifiedOperations, grantedRules);
  const suspectedBrokenPracticeRoleWrites = matchExactWriteInventory(
    rawMissingOperations,
    SUSPECTED_BROKEN_PRACTICE_ROLE_WRITE_CALL_SITES,
    "Suspected broken practice-role write ratchet",
  );
  const classifiedMissingOperations = new Set([
    ...excludedServiceIdentityWrites,
    ...suspectedBrokenPracticeRoleWrites,
  ]);
  const missingOperations = rawMissingOperations.filter((operation) => !classifiedMissingOperations.has(operation));
  const operations = practiceAndUnclassifiedOperations;
  const readOperations = operations.filter((operation) =>
    operation.interaction === "read" || operation.interaction === "search"
  );
  const writeOperations = operations.filter((operation) => WRITE_INTERACTIONS.has(operation.interaction));
  const readResourceTypes = uniqueResourceTypes(readOperations);
  const writeResourceTypes = uniqueResourceTypes(writeOperations);
  const grantedResourceTypes = [...new Set(grantedRules.flatMap((rule) => rule.resourceType ?? []))].sort();
  const criteriaScopedResourceTypes = [...new Set(grantedRules.flatMap((rule) =>
    rule.criteria && rule.resourceType ? [rule.resourceType] : []
  ))].sort();
  const criteriaScopeCoverage = criteriaScopedResourceTypes.map((resourceType) => {
    const resourceOperations = operations.filter((operation) =>
      operation.resourceType === resourceType && interactionDependsOnCriteria(operation, grantedRules)
    );
    const verified = resourceOperations.filter((operation) =>
      Boolean(operation.scopeContract) && !missingOperations.includes(operation)
    ).length;
    return {
      resourceType,
      operations: resourceOperations.length,
      verified,
      notVerified: resourceOperations.length - verified,
    };
  });

  return {
    operations,
    readResourceTypes,
    writeResourceTypes,
    excludedServiceIdentityResourceTypes,
    excludedServiceIdentityWriteCallSites: SERVICE_IDENTITY_FHIR_WRITE_CALL_SITES.map((entry) =>
      formatExactInventoryEntry(entry)
    ),
    suspectedBrokenPracticeRoleWriteCallSites: SUSPECTED_BROKEN_PRACTICE_ROLE_WRITE_CALL_SITES.map((entry) =>
      `${formatExactInventoryEntry(entry)} — surface: ${entry.surface}`
    ),
    excludedNonFhirCallSites: excludedNonFhirCallSitesFromLastScan,
    grantedResourceTypes,
    missingResourceTypes: [...new Set(missingOperations.map((operation) => operation.resourceType))].sort(),
    missingOperations,
    criteriaScopedResourceTypes,
    criteriaScopeCoverage,
    sourceRoots: SOURCE_ROOTS,
    includedExtensions: INCLUDED_EXTENSIONS,
    excludedDirectoryNames: EXCLUDED_DIRECTORY_NAMES,
    limitations: FHIR_READ_GRANT_LIMITATIONS,
  };
}

export function matchExactWriteInventory<T extends ExactFhirWriteCallSite>(
  missingOperations: readonly FhirOperation[],
  inventory: readonly T[],
  inventoryName: string,
): readonly FhirOperation[] {
  if (inventoryName === "Service-identity FHIR write exclusion") {
    const uiEntry = inventory.find((entry) => entry.path.startsWith("ui/src/"));
    if (uiEntry) {
      throw new Error(
        `Service-identity FHIR write exclusion cannot classify ui/src call sites: ${formatExactInventoryEntry(uiEntry)}.`,
      );
    }
  }
  const matched = inventory.map((entry) => {
    const operation = missingOperations.find((candidate) => exactWriteCallSiteMatches(candidate, entry));
    if (!operation) {
      throw new Error(
        `${inventoryName} entry no longer matches a real ungranted call site: ${formatExactInventoryEntry(entry)}. Remove or update the entry explicitly.`,
      );
    }
    return operation;
  });
  if (new Set(matched).size !== matched.length) {
    throw new Error(`${inventoryName} contains duplicate entries for the same call site.`);
  }
  return matched;
}

function exactWriteCallSiteMatches(
  operation: FhirOperation,
  entry: ExactFhirWriteCallSite,
): boolean {
  return operation.path === entry.path
    && operation.line === entry.line
    && operation.callee === entry.callee
    && operation.resourceType === entry.resourceType;
}

function formatExactInventoryEntry(entry: ExactFhirWriteCallSite): string {
  return `${entry.path}:${entry.line} ${entry.callee} ${entry.resourceType} — ${entry.reason}`;
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

function operationResourceType(
  node: ts.CallExpression,
  interaction: ScannedFhirInteraction,
  scopeContract: string | undefined,
): string | undefined {
  if (interaction !== "create") return stringLiteral(node.arguments[0]);
  return genericResourceType(node)
    ?? objectLiteralResourceType(node.arguments[0])
    ?? resourceTypeFromCriteria(scopeContract);
}

function genericResourceType(node: ts.CallExpression): string | undefined {
  const argument = node.typeArguments?.[0];
  if (!argument || !ts.isTypeReferenceNode(argument)) return undefined;
  return ts.isIdentifier(argument.typeName) ? argument.typeName.text : undefined;
}

function objectLiteralResourceType(node: ts.Expression | undefined): string | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
      ? property.name.text
      : undefined;
    if (name === "resourceType") return stringLiteral(property.initializer);
  }
  return undefined;
}

function resourceTypeFromCriteria(criteria: string | undefined): string | undefined {
  return criteria?.match(/^([A-Z][A-Za-z0-9]+)\?/)?.[1];
}

function requiredInteraction(interaction: ScannedFhirInteraction): RequiredFhirInteraction {
  return interaction === "patch" ? "update" : interaction;
}

function addOperation({
  file, source, node, interaction, resourceType, scopeContract,
  nonFhirCallSites, matchedNonFhirCallSites, excludedNonFhirCallSites,
  operations, operationKeys,
}: {
  file: FhirReadSourceFile;
  source: ts.SourceFile;
  node: ts.CallExpression;
  interaction: ScannedFhirInteraction;
  resourceType: string;
  scopeContract: string | undefined;
  nonFhirCallSites: readonly NonFhirLiteralCallSite[];
  matchedNonFhirCallSites: Set<NonFhirLiteralCallSite>;
  excludedNonFhirCallSites: Set<string>;
  operations: FhirOperation[];
  operationKeys: Set<string>;
}): void {
  const path = repoRelativePath(file.path);
  const callee = node.expression.getText(source);
  const exclusion = nonFhirCallSites.find((callSite) =>
    callSite.path === path && callSite.callee === callee && callSite.literal === resourceType
  );
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  if (exclusion) {
    matchedNonFhirCallSites.add(exclusion);
    excludedNonFhirCallSites.add(
      `${path}:${position.line + 1} ${callee}("${resourceType}") — ${exclusion.reason}`,
    );
    return;
  }
  const key = `${path}:${node.getStart(source)}:${interaction}:${resourceType}`;
  if (operationKeys.has(key)) return;
  operationKeys.add(key);
  operations.push({
    path,
    line: position.line + 1,
    callee,
    interaction,
    requiredInteraction: requiredInteraction(interaction),
    resourceType,
    ...(scopeContract ? { scopeContract } : {}),
  });
}

function interactionDependsOnCriteria(
  operation: FhirOperation,
  grantedRules: readonly AccessPolicyResource[],
): boolean {
  const matchingRules = grantedRules.filter((rule) =>
    rule.resourceType === operation.resourceType
    && rule.interaction?.includes(operation.requiredInteraction)
  );
  return matchingRules.length > 0 && matchingRules.every((rule) => Boolean(rule.criteria));
}

function uniqueResourceTypes(operations: readonly FhirOperation[]): string[] {
  return [...new Set(operations.map((operation) => operation.resourceType))].sort();
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

function markerValue(node: ts.Node, source: ts.SourceFile, marker: string): string | undefined {
  let current: ts.Node | undefined = node;
  const pattern = new RegExp(`${marker}:\\s*(\\S+)`);
  while (current && !ts.isSourceFile(current)) {
    const leadingTrivia = source.text.slice(current.getFullStart(), current.getStart(source));
    const match = leadingTrivia.match(pattern);
    if (match) return match[1];
    current = current.parent;
  }
  return undefined;
}

function searchContractKey(node: ts.CallExpression, source: ts.SourceFile): string | undefined {
  return markerValue(node, source, "search-contract");
}

function fhirScopeContract(node: ts.CallExpression, source: ts.SourceFile): string | undefined {
  return markerValue(node, source, "fhir-scope-contract");
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
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return isResourceTypeExpression(node.expression);
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

function formatOperation(operation: FhirOperation): string {
  return `${operation.interaction} ${operation.resourceType}${operation.scopeContract ? ` (${operation.scopeContract})` : ""}`;
}

function renderResult(result: FhirReadGrantCheckResult): string {
  const status = result.missingOperations.length ? "FAIL" : "PASS";
  const scope = result.sourceRoots.join(" + ");
  const lines = [
    `FHIR read grant check: ${status} (${result.readResourceTypes.length} literal/marked resourceTypes under ${scope})`,
    `FHIR operation grant coverage: ${status} (${result.operations.length} read/write operations)`,
  ];
  if (result.missingResourceTypes.length) {
    lines.push(`Missing resourceType grants: ${result.missingResourceTypes.join(", ")}`);
    lines.push(`Missing FHIR grants: ${[...new Set(result.missingOperations.map(formatOperation))].join(", ")}`);
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
  lines.push(
    `Service-identity FHIR write call sites excluded (${result.excludedServiceIdentityWriteCallSites.length}):`,
    ...result.excludedServiceIdentityWriteCallSites.map((item) => `- ${item}`),
    `SUSPECTED BROKEN FEATURE — known ungranted practice-role write call sites (${result.suspectedBrokenPracticeRoleWriteCallSites.length}):`,
    ...result.suspectedBrokenPracticeRoleWriteCallSites.map((item) => `- ${item}`),
  );
  lines.push("Non-FHIR literal call sites excluded:");
  lines.push(...(result.excludedNonFhirCallSites.length
    ? result.excludedNonFhirCallSites.map((item) => `- ${item}`)
    : ["- none"]));
  lines.push(
    `Criteria-scoped resource types (${result.criteriaScopedResourceTypes.length}): ${result.criteriaScopedResourceTypes.join(", ")}`,
    "Criteria-dependent operation scope coverage:",
    ...result.criteriaScopeCoverage.map((row) =>
      `- ${row.resourceType}: ${row.operations} operations; ${row.verified} scope-verified; ${row.notVerified} NOT SCOPE-VERIFIED`
    ),
  );
  lines.push("Limitations:", ...result.limitations.map((limitation) => `- ${limitation}`));
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runFhirReadGrantCheck();
  console.log(renderResult(result));
  if (result.missingOperations.length > 0) process.exitCode = 1;
}
