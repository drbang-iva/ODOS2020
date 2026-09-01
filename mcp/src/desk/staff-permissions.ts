import type { AccessPolicy, ProjectMembership } from "@medplum/fhirtypes";
import type { Application } from "express";
import {
  BUSINESS_ACTIONS,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  businessActionClass,
  effectiveBusinessActions,
  getRoleDeclaration,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";
import { readMembershipBusinessActionDeltas } from "../authz/membership-business-actions.js";

export interface StaffPermissionMember {
  membershipReference: string;
  display: string;
  roles: PracticeRoleId[];
  roleActions: BusinessAction[];
  granted: BusinessAction[];
  revoked: BusinessAction[];
  effective: BusinessAction[];
  ignoredGranted: BusinessAction[];
  ignoredRevoked: BusinessAction[];
  malformed: boolean;
  owner: boolean;
  toggleImmune: boolean;
}

export interface StaffPermissionsCaller {
  staffReference: string;
  userReference: string;
  projectId: string;
  businessActions: readonly BusinessAction[];
}

export interface StaffPermissionsDependencies {
  authenticateService?(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<StaffPermissionsCaller | null>;
  resolveProjectOwnerUserReference(projectId: string): Promise<string | undefined>;
  listMembers(projectId: string): Promise<StaffPermissionMember[]>;
  updateMember(
    caller: StaffPermissionsCaller,
    membershipId: string,
    granted: readonly BusinessAction[],
    revoked: readonly BusinessAction[],
  ): Promise<StaffPermissionMember>;
}

export interface StaffPermissionsResult {
  status: number;
  body: Record<string, unknown>;
}

export function buildStaffPermissionMember(input: {
  membership: ProjectMembership;
  policies: readonly AccessPolicy[];
  ownerUserReference: string;
}): StaffPermissionMember {
  const membershipId = input.membership.id;
  if (!membershipId) throw new Error("Staff ProjectMembership is missing its id.");
  const boundPolicyIds = new Set([
    ...(input.membership.access ?? []).flatMap((access) =>
      access.policy.reference?.match(/^AccessPolicy\/([^/]+)$/)?.[1] ?? []
    ),
    ...(input.membership.accessPolicy?.reference?.match(/^AccessPolicy\/([^/]+)$/)?.[1] ?? []),
  ]);
  const roles = PRACTICE_ROLE_IDS.filter((role) => input.policies.some((policy) =>
    policy.id &&
    boundPolicyIds.has(policy.id) &&
    policy.meta?.tag?.some((tag) =>
      tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === role
    )
  ));
  const roleActions = BUSINESS_ACTIONS.filter((action) =>
    roles.some((role) => getRoleDeclaration(role).businessActions.includes(action))
  );
  const deltas = readMembershipBusinessActionDeltas(input.membership);
  const resolution = effectiveBusinessActions(
    roles,
    deltas.malformed ? undefined : deltas.granted,
    deltas.malformed ? undefined : deltas.revoked,
  );
  const owner = input.membership.user.reference === input.ownerUserReference;
  return {
    membershipReference: `ProjectMembership/${membershipId}`,
    display: input.membership.profile.display ?? input.membership.userName ??
      input.membership.profile.reference ?? `ProjectMembership/${membershipId}`,
    roles,
    roleActions,
    granted: deltas.granted,
    revoked: deltas.revoked,
    effective: resolution.actions,
    ignoredGranted: resolution.ignoredGranted,
    ignoredRevoked: resolution.ignoredRevoked,
    malformed: deltas.malformed || resolution.malformed,
    owner,
    toggleImmune: owner,
  };
}

export function registerStaffPermissionRoutes(
  app: Pick<Application, "get" | "patch">,
  deps: StaffPermissionsDependencies,
): void {
  app.get("/desk/staff/permissions", async (req, res) => {
    try {
      await deps.authenticateService?.();
      const result = await handleStaffPermissionsList(deps, {
        authHeader: req.header("authorization"),
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: GET /desk/staff/permissions failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Staff permissions could not be loaded." });
    }
  });
  app.patch("/desk/staff/permissions/:membershipId", async (req, res) => {
    try {
      await deps.authenticateService?.();
      const result = await handleStaffPermissionsMutation(deps, {
        authHeader: req.header("authorization"),
        membershipId: routeParam(req.params.membershipId),
        body: req.body,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: PATCH /desk/staff/permissions failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Staff permissions could not be saved." });
    }
  });
}

export async function handleStaffPermissionsList(
  deps: StaffPermissionsDependencies,
  request: { authHeader: string | undefined },
): Promise<StaffPermissionsResult> {
  const authorized = await authorizeOwner(deps, request.authHeader);
  if ("result" in authorized) return authorized.result;
  return {
    status: 200,
    body: {
      actions: BUSINESS_ACTIONS.map((action) => ({
        action,
        class: businessActionClass(action),
        reason: actionReason(action),
      })),
      members: await deps.listMembers(authorized.caller.projectId),
    },
  };
}

export async function handleStaffPermissionsMutation(
  deps: StaffPermissionsDependencies,
  request: { authHeader: string | undefined; membershipId: string; body: unknown },
): Promise<StaffPermissionsResult> {
  const authorized = await authorizeOwner(deps, request.authHeader);
  if ("result" in authorized) return authorized.result;
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(request.membershipId)) {
    return { status: 400, body: { error: "ProjectMembership id is invalid." } };
  }
  const parsed = parseMutation(request.body);
  if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
  try {
    const member = await deps.updateMember(
      authorized.caller,
      request.membershipId,
      parsed.granted,
      parsed.revoked,
    );
    return { status: 200, body: { member } };
  } catch (error) {
    if (error instanceof Error && /owner.*toggle-immune/i.test(error.message)) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
}

async function authorizeOwner(
  deps: StaffPermissionsDependencies,
  authHeader: string | undefined,
): Promise<{ caller: StaffPermissionsCaller } | { result: StaffPermissionsResult }> {
  const caller = await deps.authenticate(authHeader);
  if (!caller) return { result: { status: 401, body: { error: "Authentication required." } } };
  if (!caller.businessActions.includes("identity.manage")) {
    return { result: { status: 403, body: { error: "identity.manage action required." } } };
  }
  const owner = await deps.resolveProjectOwnerUserReference(caller.projectId);
  if (!owner || caller.userReference !== owner) {
    return { result: { status: 403, body: { error: "Practice owner access is required." } } };
  }
  return { caller };
}

function parseMutation(body: unknown): {
  granted: BusinessAction[];
  revoked: BusinessAction[];
} | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Permission body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "granted" && key !== "revoked");
  if (extra.length > 0) return { error: `Unexpected permission field(s): ${extra.join(", ")}.` };
  const granted = parseActions(record.granted);
  const revoked = parseActions(record.revoked);
  if (!granted || !revoked) return { error: "granted and revoked must contain only known business actions." };
  const overlap = granted.filter((action) => revoked.includes(action));
  if (overlap.length > 0) return { error: `Actions cannot be both granted and revoked: ${overlap.join(", ")}.` };
  return { granted, revoked };
}

function parseActions(value: unknown): BusinessAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: BusinessAction[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !BUSINESS_ACTIONS.includes(item as BusinessAction)) return undefined;
    const action = item as BusinessAction;
    if (!actions.includes(action)) actions.push(action);
  }
  return BUSINESS_ACTIONS.filter((action) => actions.includes(action));
}

function actionReason(action: BusinessAction): string | undefined {
  const actionClass = businessActionClass(action);
  if (actionClass === "baseline") return "Required for every active staff account.";
  if (actionClass === "credential-bound") {
    return "Professional-role capability: it can be switched off for a holder but never granted to a non-holder.";
  }
  if (actionClass === "owner-only") return "Only the practice owner can hold this action.";
  return undefined;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}
