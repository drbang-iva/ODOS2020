import { randomUUID } from "node:crypto";
import {
  getRoleDeclaration,
  type FhirInteraction,
  type PracticeRoleId,
} from "../authz/roles.js";
import {
  formatPermissions,
  formatSmartResourceScope,
  SMART_V2_PERMISSION_ORDER,
  type SmartResourceScope,
  type SmartV2Permission,
} from "./scope.js";

export type SmartScopeOutcomeClass = "granted" | "reduced" | "staged-review" | "rejected";
export type SmartClientAuthClass = "public" | "confidential-symmetric" | "confidential-asymmetric";

export interface SmartLaunchContext {
  readonly patient?: string;
  readonly encounter?: string;
  readonly intent?: string;
  readonly style?: string;
  readonly need_patient_banner?: boolean;
  readonly smart_style_url?: string;
}

export interface SmartScopeDecisionRecord {
  readonly id: string;
  readonly appClientId: string;
  readonly userId: string;
  readonly requestedScopes: readonly string[];
  readonly effectiveScopes: readonly string[];
  readonly policyId?: string;
  readonly parameterizedBounds: Record<string, unknown>;
  readonly outcomeClass: SmartScopeOutcomeClass;
  readonly decidedBy?: string;
  readonly decisionTimestamp: string;
  readonly expirationTimestamp: string;
  readonly reason?: string;
}

export interface SmartScopeIntersectionInput {
  readonly appClientId: string;
  readonly userId: string;
  readonly roleId: PracticeRoleId;
  readonly clientAuthClass: SmartClientAuthClass;
  readonly requestedScopes: readonly SmartResourceScope[];
  readonly launchContext?: SmartLaunchContext;
  readonly firstPartyOsodCoreClient?: boolean;
  readonly policyId?: string;
  readonly now?: Date;
  readonly decisionTtlMs?: number;
}

export interface SmartScopeApprovalInput {
  readonly decision: SmartScopeDecisionRecord;
  readonly adminUserId: string;
  readonly adminRole: PracticeRoleId;
  readonly actorRole?: string;
  readonly approvedScopes?: readonly string[];
  readonly now?: Date;
}

export function evaluateSmartScopeIntersection(input: SmartScopeIntersectionInput): SmartScopeDecisionRecord {
  const now = input.now ?? new Date();
  const requested = input.requestedScopes.map(formatSmartResourceScope);
  const effective = input.requestedScopes
    .flatMap((scope) =>
      intersectScopeWithRole(scope, {
        roleId: input.roleId,
        clientAuthClass: input.clientAuthClass,
        firstPartyOsodCoreClient:
          input.firstPartyOsodCoreClient ?? isFirstPartyOsodCoreClient(input.appClientId),
      }),
    )
    .map(formatSmartResourceScope);
  const uniqueEffective = [...new Set(effective)].sort();
  const missing = requested.filter((scope) => !uniqueEffective.includes(scope));
  const outcomeClass = classifyOutcome({
    requestedScopes: input.requestedScopes,
    effectiveScopes: uniqueEffective,
    missingScopes: missing,
    clientAuthClass: input.clientAuthClass,
    launchContext: input.launchContext,
  });

  return {
    id: randomUUID(),
    appClientId: input.appClientId,
    userId: input.userId,
    requestedScopes: requested,
    effectiveScopes: outcomeClass === "rejected" || outcomeClass === "staged-review" ? [] : uniqueEffective,
    policyId: input.policyId ?? `AccessPolicy/osod-${input.roleId}`,
    parameterizedBounds: {
      patient: input.launchContext?.patient,
      encounter: input.launchContext?.encounter,
      client_auth_class: input.clientAuthClass,
      role_id: input.roleId,
    },
    outcomeClass,
    decisionTimestamp: now.toISOString(),
    expirationTimestamp: new Date(now.getTime() + (input.decisionTtlMs ?? 15 * 60_000)).toISOString(),
    reason: decisionReason(outcomeClass, missing),
  };
}

export function approveStagedScopeDecision(input: SmartScopeApprovalInput): SmartScopeDecisionRecord {
  if (input.actorRole === "autonomous-agent") {
    throw new Error("Mandate 8 boundary: autonomous agents cannot approve SMART staged-review requests.");
  }
  if (input.adminRole !== "practice-admin") {
    throw new Error("Mandate 8 boundary: SMART staged-review approval requires a practice-admin Practitioner.");
  }
  if (input.decision.outcomeClass !== "staged-review") {
    throw new Error("SMART staged-review approval can only resolve staged-review decisions.");
  }
  const now = input.now ?? new Date();
  const approvedScopes = [...new Set(input.approvedScopes ?? input.decision.requestedScopes)].sort();
  return {
    ...input.decision,
    effectiveScopes: approvedScopes,
    outcomeClass: approvedScopes.length ? "granted" : "rejected",
    decidedBy: input.adminUserId,
    decisionTimestamp: now.toISOString(),
  };
}

export function assertSandboxScopeAllowed(scope: SmartResourceScope): void {
  if (scope.prefix === "patient" || scope.resourceType === "Patient") {
    throw new Error("invalid_scope: sandbox SMART apps cannot request PHI patient-compartment scopes.");
  }
}

function intersectScopeWithRole(
  requested: SmartResourceScope,
  input: {
    readonly roleId: PracticeRoleId;
    readonly clientAuthClass: SmartClientAuthClass;
    readonly firstPartyOsodCoreClient: boolean;
  },
): SmartResourceScope[] {
  if (requested.prefix === "system" && input.clientAuthClass === "public") {
    return [];
  }

  if (isFrameCatalogDeviceDefinitionReadScope(requested) && !input.firstPartyOsodCoreClient) {
    return [];
  }

  const allowedPermissions = allowedPermissionsForResource(input.roleId, requested.resourceType);
  const requestedPermissions = new Set(requested.permissions);
  const permissions = SMART_V2_PERMISSION_ORDER.filter(
    (permission) => allowedPermissions.has(permission) && requestedPermissions.has(permission),
  );

  if (!permissions.length) {
    return [];
  }

  return [{ ...requested, permissions, legacy: false }];
}

export function isFirstPartyOsodCoreClient(clientId: string): boolean {
  return clientId === "osod-core" || clientId.startsWith("osod-core-") || clientId.startsWith("osod-mcp");
}

function isFrameCatalogDeviceDefinitionReadScope(scope: SmartResourceScope): boolean {
  return (
    scope.resourceType === "DeviceDefinition" &&
    (scope.permissions.includes("r") || scope.permissions.includes("s"))
  );
}

function allowedPermissionsForResource(roleId: PracticeRoleId, resourceType: string): Set<SmartV2Permission> {
  const role = getRoleDeclaration(roleId);
  const rule = role.resourceRules.find(
    (candidate) => candidate.resourceType === resourceType || candidate.resourceType === "*",
  );
  return new Set(rule ? interactionsToSmartPermissions(rule.interactions) : []);
}

function interactionsToSmartPermissions(interactions: readonly FhirInteraction[]): SmartV2Permission[] {
  const permissions = new Set<SmartV2Permission>();
  for (const interaction of interactions) {
    if (interaction === "create") permissions.add("c");
    if (interaction === "read" || interaction === "history" || interaction === "vread") permissions.add("r");
    if (interaction === "update") permissions.add("u");
    if (interaction === "delete") permissions.add("d");
    if (interaction === "search") permissions.add("s");
  }
  return SMART_V2_PERMISSION_ORDER.filter((permission) => permissions.has(permission));
}

function classifyOutcome(input: {
  readonly requestedScopes: readonly SmartResourceScope[];
  readonly effectiveScopes: readonly string[];
  readonly missingScopes: readonly string[];
  readonly clientAuthClass: SmartClientAuthClass;
  readonly launchContext?: SmartLaunchContext;
}): SmartScopeOutcomeClass {
  if (!input.effectiveScopes.length) {
    return "rejected";
  }
  if (input.requestedScopes.some((scope) => scope.prefix === "system" && input.clientAuthClass === "public")) {
    return "rejected";
  }
  if (
    input.missingScopes.length &&
    input.requestedScopes.some((scope) => highRiskScope(scope, input.launchContext))
  ) {
    return "staged-review";
  }
  return input.missingScopes.length ? "reduced" : "granted";
}

function highRiskScope(scope: SmartResourceScope, launchContext: SmartLaunchContext | undefined): boolean {
  if (scope.prefix === "system") {
    return true;
  }
  if (scope.resourceType === "MedicationRequest") {
    return true;
  }
  if (scope.resourceType === "Observation" && !launchContext?.patient) {
    return true;
  }
  return scope.permissions.some((permission) => permission === "c" || permission === "u" || permission === "d");
}

function decisionReason(outcomeClass: SmartScopeOutcomeClass, missingScopes: readonly string[]): string | undefined {
  if (outcomeClass === "granted") {
    return "requested SMART scopes fit AccessPolicy bounds";
  }
  if (outcomeClass === "reduced") {
    return `effective SMART scope reduced to minimum necessary; removed: ${missingScopes.join(" ")}`;
  }
  if (outcomeClass === "staged-review") {
    return "high-risk SMART scope reduction requires staged admin review";
  }
  return "requested SMART scope cannot intersect with AccessPolicy bounds";
}
