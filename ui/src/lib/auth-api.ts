import { fhir, toError } from "./fhir";
import type { PracticeRoleId } from "./practice-roles";

export interface StaffInvitePayload {
  email: string;
  firstName: string;
  lastName: string;
  roleId: PracticeRoleId;
}

export interface StaffInviteResponse extends StaffInvitePayload {
  membershipReference?: string;
}

export type StaffPermissionActionClass = "baseline" | "credential-bound" | "owner-only" | "grantable";

export interface StaffPermissionAction {
  action: string;
  class: StaffPermissionActionClass;
  reason?: string;
}

export interface StaffPermissionMember {
  membershipReference: string;
  display: string;
  roles: PracticeRoleId[];
  roleActions: string[];
  granted: string[];
  revoked: string[];
  effective: string[];
  ignoredGranted: string[];
  ignoredRevoked: string[];
  malformed: boolean;
  owner: boolean;
  toggleImmune: boolean;
}

export interface StaffPermissionsResponse {
  actions: StaffPermissionAction[];
  members: StaffPermissionMember[];
}

export class PasswordResetTransportError extends Error {
  constructor(cause: unknown) {
    super("The reset request could not reach ODOS. Check the server connection and try again.", { cause });
    this.name = "PasswordResetTransportError";
  }
}

export async function defaultResetPassword(email: string): Promise<void> {
  try {
    await fetch("/auth/resetpassword", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch (error) {
    throw new PasswordResetTransportError(error);
  }
}

export async function defaultSetPassword(id: string, secret: string, password: string): Promise<void> {
  const response = await fetch("/auth/setpassword", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, secret, password }),
  });
  if (!response.ok) throw await toError(response);
}

export async function inviteStaff(payload: StaffInvitePayload): Promise<StaffInviteResponse> {
  const authorization = fhir.authHeader();
  const response = await fetch("/desk/staff/invite", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await apiError(response);
  return await response.json() as StaffInviteResponse;
}

export async function loadStaffPermissions(): Promise<StaffPermissionsResponse> {
  const response = await fetch("/desk/staff/permissions", {
    headers: authorizationHeaders(),
  });
  if (!response.ok) throw await apiError(response);
  return await response.json() as StaffPermissionsResponse;
}

export async function saveStaffPermissions(
  membershipId: string,
  granted: string[],
  revoked: string[],
): Promise<StaffPermissionMember> {
  const response = await fetch(`/desk/staff/permissions/${encodeURIComponent(membershipId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    body: JSON.stringify({ granted, revoked }),
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { member: StaffPermissionMember };
  return body.member;
}

function authorizationHeaders(): Record<string, string> {
  const authorization = fhir.authHeader();
  return authorization ? { Authorization: authorization } : {};
}

async function apiError(response: Response): Promise<Error> {
  const body = await response.clone().json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? new Error(body.error) : toError(response);
}
