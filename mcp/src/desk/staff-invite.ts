import type { ProjectMembership } from "@medplum/fhirtypes";
import type { Application } from "express";
import { buildOdosAuditEventRow, type OdosAuditEventRecord } from "../authz/odosAudit.js";
import { PRACTICE_ROLE_IDS, type PracticeRoleId } from "../authz/roles.js";

export interface StaffInviteInput {
  email: string;
  firstName: string;
  lastName: string;
  roleId: PracticeRoleId;
}

export interface StaffInviteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    roles: readonly PracticeRoleId[];
  } | null>;
  invite(input: Omit<StaffInviteInput, "roleId">): Promise<ProjectMembership>;
  grantRole(membership: ProjectMembership, email: string, roleId: PracticeRoleId): Promise<void>;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
}

export interface StaffInviteResult {
  status: number;
  body: Record<string, unknown>;
}

const ALLOWED_FIELDS = new Set(["email", "firstName", "lastName", "roleId"]);

export function registerStaffInviteRoute(
  app: Pick<Application, "post">,
  deps: StaffInviteDeps,
): void {
  app.post("/desk/staff/invite", async (req, res) => {
    try {
      await deps.authenticateService();
      const result = await handleStaffInviteRequest(deps, {
        authHeader: req.header("authorization"),
        body: req.body,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: /desk/staff/invite failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Staff invite route failed." });
    }
  });
}

export async function handleStaffInviteRequest(
  deps: StaffInviteDeps,
  request: { authHeader: string | undefined; body: unknown },
): Promise<StaffInviteResult> {
  const staff = await deps.authenticate(request.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staff.roles.includes("practice-admin")) {
    return { status: 403, body: { error: "practice-admin role required" } };
  }

  const parsed = parseStaffInviteInput(request.body);
  if ("error" in parsed) return { status: 400, body: { error: parsed.error } };

  let membership: ProjectMembership;
  try {
    membership = await deps.invite({
      email: parsed.email,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
    });
  } catch (error) {
    if (errorStatus(error) === 409) {
      return { status: 409, body: { error: `An existing membership already exists for ${parsed.email}.` } };
    }
    throw error;
  }

  try {
    await deps.grantRole(membership, parsed.email, parsed.roleId);
  } catch (error) {
    console.error("odos-mcp: staff invite role grant failed:", error);
    return {
      status: 500,
      body: {
        error:
          `Invite created for ${parsed.email}, but the ${parsed.roleId} role grant failed. ` +
          `The account is in an invited-without-role half-state. Repair it with: ` +
          `npm run repair-practice-roles -- --email ${parsed.email}`,
      },
    };
  }

  await deps.recordAudit(buildOdosAuditEventRow({
    eventType: "staff.invite",
    actorReference: staff.staffReference,
    actorRole: "practice-admin",
    targetReference: membership.id ? `ProjectMembership/${membership.id}` : undefined,
    resourceType: "ProjectMembership",
    resourceId: membership.id,
    actionOutcome: "granted",
    actionReason: `invited ${parsed.email} as ${parsed.roleId}`,
  }));

  return {
    status: 201,
    body: {
      email: parsed.email,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      roleId: parsed.roleId,
      membershipReference: membership.id ? `ProjectMembership/${membership.id}` : undefined,
    },
  };
}

export function parseStaffInviteInput(body: unknown): StaffInviteInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invite body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  const disallowed = Object.keys(record).filter((key) => !ALLOWED_FIELDS.has(key));
  if (disallowed.length > 0) {
    return {
      error: disallowed.some((key) => /policy|access|membership/i.test(key))
        ? "Caller-supplied policy or membership references are not allowed. Choose roleId; the server maps the AccessPolicy."
        : `Unexpected invite field(s): ${disallowed.join(", ")}.`,
    };
  }

  const email = stringField(record.email);
  const firstName = stringField(record.firstName);
  const lastName = stringField(record.lastName);
  const roleId = stringField(record.roleId);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return { error: "A valid email is required." };
  if (!firstName) return { error: "First name is required." };
  if (!lastName) return { error: "Last name is required." };
  if (!PRACTICE_ROLE_IDS.includes(roleId as PracticeRoleId)) {
    return { error: `roleId must be one of: ${PRACTICE_ROLE_IDS.join(", ")}.` };
  }
  return { email: email.toLowerCase(), firstName, lastName, roleId: roleId as PracticeRoleId };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}
