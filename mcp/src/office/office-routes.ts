import type { Application, Request, Response } from "express";
import type { PracticeRoleId } from "../authz/roles.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import { acknowledgeOfficeMessage, listOfficeMessages, OfficeMessageValidationError, sendOfficeMessage, type OfficeFhir, type OfficeTier } from "./office-channel.js";

type OfficeStaff = Omit<AuthenticatedStaff, "fhir" | "actorRole" | "roles"> & {
  actorRole: PracticeRoleId;
  roles: readonly PracticeRoleId[];
  fhir: OfficeFhir;
};

export interface OfficeRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<OfficeStaff | null>;
  now?: () => string;
}

class OfficeAuthorizationError extends Error {}

export function registerOfficeRoutes(app: Pick<Application, "get" | "post">, deps: OfficeRouteDeps): void {
  app.post("/desk/office/messages", async (req, res) => withStaff(req, res, deps, "desk", async (staff) => {
    const body = record(req.body);
    res.status(201).json(await sendOfficeMessage(staff.fhir, {
      senderReference: staff.staffReference,
      text: typeof body.text === "string" ? body.text : "",
      tier: body.tier as OfficeTier,
      ...(typeof body.patientId === "string" ? { patientId: body.patientId } : body.patientId === undefined ? {} : { patientId: "" }),
      now: deps.now?.(),
    }));
  }));
  app.get("/clinic/office/messages", async (req, res) => withStaff(req, res, deps, "clinic", async (staff) => {
    rejectQuery(req);
    res.json(await listOfficeMessages(staff.fhir, { mailbox: "clinic", staffReference: staff.staffReference }));
  }));
  app.get("/desk/office/messages", async (req, res) => withStaff(req, res, deps, "desk", async (staff) => {
    rejectQuery(req);
    res.json(await listOfficeMessages(staff.fhir, { mailbox: "desk", staffReference: staff.staffReference }));
  }));
  app.post("/clinic/office/messages/:messageId/ack", async (req, res) => withStaff(req, res, deps, "clinic", async (staff) => {
    const messageId = stringParam(req.params.messageId);
    res.json(await acknowledgeOfficeMessage(staff.fhir, { messageId, staffReference: staff.staffReference, now: deps.now?.() }));
  }));
}

async function withStaff(
  req: Request,
  res: Response,
  deps: OfficeRouteDeps,
  side: "desk" | "clinic",
  action: (staff: OfficeStaff) => Promise<void>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to use the internal Office channel." });
      return;
    }
    const actorRole = officeActingRole(staff.roles, side);
    if (!actorRole) {
      throw new OfficeAuthorizationError(`${side === "desk" ? "Desk" : "Clinic"} role required for this Office channel action.`);
    }
    await action({ ...staff, actorRole });
  } catch (error) {
    console.error("odos-mcp: Office channel route failed:", error);
    if (res.headersSent) return;
    if (error instanceof OfficeMessageValidationError) {
      res.status(400).json({ error: error.message });
    } else if (error instanceof OfficeAuthorizationError) {
      res.status(403).json({ error: error.message });
    } else {
      res.status(500).json({ error: "Office channel route failed." });
    }
  }
}

export function officeActingRole(
  roles: readonly PracticeRoleId[],
  side: "desk" | "clinic",
): PracticeRoleId | undefined {
  const role = side === "desk" ? "front-desk" : "clinician";
  return roles.includes(role) ? role : undefined;
}

function rejectQuery(req: Request): void {
  if (Object.keys(req.query).length > 0) throw new OfficeMessageValidationError("Office message list does not accept query parameters.");
}

function stringParam(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new OfficeMessageValidationError("Office message id is invalid.");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
