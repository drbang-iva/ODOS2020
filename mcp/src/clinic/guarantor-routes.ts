import type { Application, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { MedplumClient } from "../fhir-client.js";
import { handleGuarantorOperation, type GuarantorOperationDeps, type GuarantorOperationStaff } from "./guarantor-link-operation.js";

export interface GuarantorRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(header: string | undefined): Promise<GuarantorOperationStaff | null>;
  serviceFhir: GuarantorOperationDeps["serviceFhir"] & Pick<MedplumClient, "getAuthenticatedProfileReference">;
  recordAudit: GuarantorOperationDeps["recordAudit"];
  now?: () => string;
}

export function registerGuarantorRoutes(app: Pick<Application, "get" | "post">, deps: GuarantorRouteDeps): void {
  const limit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many guarantor requests. Try again shortly." } });
  const handle = (action: string) => async (req: Request, res: Response): Promise<void> => {
    try {
      await deps.authenticateService();
      const staff = await deps.authenticate(req.header("authorization"));
      if (!staff) { res.status(401).json({ error: "Authentication required to manage guarantors." }); return; }
      const taskId = typeof req.params.taskId === "string" ? req.params.taskId : undefined;
      if (["status", "complete", "correct"].includes(action) && !/^[A-Za-z0-9.-]{1,64}$/.test(taskId ?? "")) { res.status(400).json({ error: "Operation id is invalid." }); return; }
      const result = await handleGuarantorOperation({ serviceFhir: deps.serviceFhir,
        serviceReference: await deps.serviceFhir.getAuthenticatedProfileReference(), recordAudit: deps.recordAudit, now: deps.now }, staff, { action, taskId, body: req.body });
      res.status(result.status).json(result.body);
    } catch {
      console.error(`odos-mcp: guarantor link-operation ${action} setup failed; result unconfirmed.`);
      if (!res.headersSent) res.status(500).json({ error: "The guarantor operation result could not be confirmed. Reload before continuing." });
    }
  };
  app.post("/guarantors/link-operations/preview", limit, handle("preview"));
  app.post("/guarantors/link-operations", limit, handle("create"));
  app.get("/guarantors/link-operations/:taskId", limit, handle("status"));
  app.post("/guarantors/link-operations/:taskId/complete", limit, handle("complete"));
  app.post("/guarantors/link-operations/:taskId/correct", limit, handle("correct"));
}
