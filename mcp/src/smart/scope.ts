export const SMART_RESOURCE_SCOPE_PREFIXES = ["patient", "user", "system"] as const;
export const SMART_V2_PERMISSION_ORDER = ["c", "r", "u", "d", "s"] as const;
export const SMART_LEGACY_PERMISSIONS = ["read", "write", "*"] as const;

export type SmartScopePrefix = (typeof SMART_RESOURCE_SCOPE_PREFIXES)[number];
export type SmartV2Permission = (typeof SMART_V2_PERMISSION_ORDER)[number];
export type SmartLegacyPermission = (typeof SMART_LEGACY_PERMISSIONS)[number];

export interface SmartResourceScope {
  readonly raw: string;
  readonly prefix: SmartScopePrefix;
  readonly resourceType: string;
  readonly permissions: readonly SmartV2Permission[];
  readonly legacy: boolean;
}

export interface ParsedSmartScopes {
  readonly resourceScopes: readonly SmartResourceScope[];
  readonly passthroughScopes: readonly string[];
}

export class SmartScopeParseError extends Error {
  readonly code = "invalid_scope";

  constructor(scope: string) {
    super(`invalid SMART scope string: ${scope}`);
  }
}

const RESOURCE_TYPE_PATTERN = String.raw`(?:\*|[A-Z][A-Za-z0-9]*)`;
const V2_SCOPE_PATTERN = new RegExp(
  `^(${SMART_RESOURCE_SCOPE_PREFIXES.join("|")})/(${RESOURCE_TYPE_PATTERN})\\.([cruds]+|\\*)$`,
);
const LEGACY_SCOPE_PATTERN = new RegExp(
  `^(${SMART_RESOURCE_SCOPE_PREFIXES.join("|")})/(${RESOURCE_TYPE_PATTERN})\\.(read|write|\\*)$`,
);

const PASSTHROUGH_SMART_SCOPES = new Set([
  "launch",
  "launch/patient",
  "launch/encounter",
  "openid",
  "profile",
  "fhirUser",
  "online_access",
  "offline_access",
]);

export function parseSmartScopeList(scopeText: string | undefined): ParsedSmartScopes {
  const resourceScopes: SmartResourceScope[] = [];
  const passthroughScopes: string[] = [];
  for (const rawScope of splitScopeText(scopeText)) {
    if (PASSTHROUGH_SMART_SCOPES.has(rawScope)) {
      passthroughScopes.push(rawScope);
      continue;
    }
    resourceScopes.push(parseSmartResourceScope(rawScope));
  }
  return { resourceScopes, passthroughScopes };
}

export function parseSmartResourceScope(raw: string): SmartResourceScope {
  const v2Match = raw.match(V2_SCOPE_PATTERN);
  if (v2Match) {
    return {
      raw,
      prefix: v2Match[1] as SmartScopePrefix,
      resourceType: v2Match[2]!,
      permissions: normalizePermissionText(v2Match[3]!),
      legacy: false,
    };
  }

  const legacyMatch = raw.match(LEGACY_SCOPE_PATTERN);
  if (legacyMatch) {
    return {
      raw,
      prefix: legacyMatch[1] as SmartScopePrefix,
      resourceType: legacyMatch[2]!,
      permissions: legacyPermissionsToV2(legacyMatch[3] as SmartLegacyPermission),
      legacy: true,
    };
  }

  throw new SmartScopeParseError(raw);
}

export function formatSmartResourceScope(scope: SmartResourceScope): string {
  return `${scope.prefix}/${scope.resourceType}.${formatPermissions(scope.permissions)}`;
}

export function formatPermissions(permissions: readonly SmartV2Permission[]): string {
  const set = new Set(permissions);
  return SMART_V2_PERMISSION_ORDER.filter((permission) => set.has(permission)).join("");
}

export function splitScopeText(scopeText: string | undefined): string[] {
  return (scopeText ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function isSmartResourceScopeCandidate(value: string): boolean {
  return /^(?:patient|user|system)\//.test(value);
}

export function smartScopeLintVerdict(value: string): "valid-v2" | "legacy-warning" | "invalid" | "not-smart-resource" {
  if (!isSmartResourceScopeCandidate(value)) {
    return "not-smart-resource";
  }
  try {
    const parsed = parseSmartResourceScope(value);
    return parsed.legacy ? "legacy-warning" : "valid-v2";
  } catch {
    return "invalid";
  }
}

export function normalizeSmartResourceScopes(scopes: readonly SmartResourceScope[]): string[] {
  return [...new Set(scopes.map(formatSmartResourceScope))].sort();
}

export function smartScopeIncludesPermission(
  scope: SmartResourceScope,
  permission: SmartV2Permission,
): boolean {
  return scope.permissions.includes(permission);
}

function normalizePermissionText(value: string): SmartV2Permission[] {
  if (value === "*") {
    return [...SMART_V2_PERMISSION_ORDER];
  }
  const permissions = [...new Set(value.split(""))] as SmartV2Permission[];
  return SMART_V2_PERMISSION_ORDER.filter((permission) => permissions.includes(permission));
}

function legacyPermissionsToV2(permission: SmartLegacyPermission): SmartV2Permission[] {
  switch (permission) {
    case "read":
      return ["r", "s"];
    case "write":
      return ["c", "u", "d"];
    case "*":
      return [...SMART_V2_PERMISSION_ORDER];
  }
}
