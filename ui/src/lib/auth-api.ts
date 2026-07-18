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

async function apiError(response: Response): Promise<Error> {
  const body = await response.clone().json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? new Error(body.error) : toError(response);
}
