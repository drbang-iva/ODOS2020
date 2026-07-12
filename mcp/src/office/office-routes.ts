import type { Application, Request, Response } from "express";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import type { PracticeRoleId } from "../authz/roles.js";
import { acknowledgeOfficeMessage, listOfficeMessages, OfficeMessageValidationError, sendOfficeMessage, type OfficeBox, type OfficeFhir, type OfficeView } from "./office-channel.js";

type OfficeStaff = Omit<AuthenticatedStaff, "fhir" | "actorRole"> & { actorRole: PracticeRoleId; fhir: OfficeFhir };

export interface OfficeRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<OfficeStaff | null>;
  now?: () => string;
}

export function registerOfficeRoutes(app: Pick<Application, "get" | "post">, deps: OfficeRouteDeps): void {
  app.post("/office/messages", async (req, res) => handleSend(req, res, deps));
  app.get("/office/messages", async (req, res) => handleList(req, res, deps));
  app.post("/office/messages/:messageId/ack", async (req, res) => handleAck(req, res, deps));
}

async function handleSend(req: Request, res: Response, deps: OfficeRouteDeps): Promise<void> {
  await withStaff(req, res, deps, async (staff) => {
    const body = record(req.body);
    res.status(201).json(await sendOfficeMessage(staff.fhir, {
      senderReference: staff.staffReference,
      ...(typeof body.recipientReference === "string" ? { recipientReference: body.recipientReference } : {}),
      ...(typeof body.recipientRole === "string" ? { recipientRole: body.recipientRole as PracticeRoleId } : {}),
      text: typeof body.text === "string" ? body.text : "",
      urgent: body.urgent === true,
      ...(typeof body.patientReference === "string" ? { patientReference: body.patientReference } : {}),
      now: deps.now?.(),
    }));
  });
}

async function handleList(req: Request, res: Response, deps: OfficeRouteDeps): Promise<void> {
  await withStaff(req, res, deps, async (staff) => {
    const box = singleQuery(req.query.box) ?? "inbox";
    const view = singleQuery(req.query.view) ?? "all";
    if (!isBox(box) || !isView(view)) throw new OfficeMessageValidationError("Office message list query is invalid.");
    res.json(await listOfficeMessages(staff.fhir, { staffReference: staff.staffReference, role: staff.actorRole, box, view }));
  });
}

async function handleAck(req: Request, res: Response, deps: OfficeRouteDeps): Promise<void> {
  await withStaff(req, res, deps, async (staff) => {
    const messageId = Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId;
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(messageId ?? "")) throw new OfficeMessageValidationError("Office message id is invalid.");
    res.json(await acknowledgeOfficeMessage(staff.fhir, { messageId, staffReference: staff.staffReference, role: staff.actorRole, now: deps.now?.() }));
  });
}

async function withStaff(req: Request, res: Response, deps: OfficeRouteDeps, action: (staff: OfficeStaff) => Promise<void>): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to use the internal Office channel." });
      return;
    }
    await action(staff);
  } catch (error) {
    console.error("osod-mcp: Office channel route failed:", error);
    if (!res.headersSent) res.status(error instanceof OfficeMessageValidationError ? 400 : 500).json({ error: error instanceof OfficeMessageValidationError ? error.message : "Office channel route failed." });
  }
}

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function singleQuery(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function isBox(value: string): value is OfficeBox { return value === "inbox" || value === "sent"; }
function isView(value: string): value is OfficeView { return value === "unread" || value === "all"; }
