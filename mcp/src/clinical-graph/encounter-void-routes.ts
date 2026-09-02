import type { Express } from "express";
import {
  VoidTransactionError,
  handleEncounterVoidRequest,
  type EncounterVoidEndpointDeps,
} from "./encounter-void-endpoint.js";

/**
 * POST /clinical-graph/encounters/:encounterId/void — the HTTP seam of the void.
 *
 * This is where the PHI split happens, so it lives in its own registrar and is exercised over
 * HTTP by encounterVoidRoutes.test.ts: a refused void's full detail (entry index, method + url
 * with resource ids, HTTP status, OperationOutcome text, what was applied) goes to `log` and
 * ONLY there; the response body is the error's `clientBody` — outcome, entry index, resource
 * TYPE, status, counts, a stable code — and nothing else. The route answers 502: the record
 * server, not ODOS, refused or failed the write, and the body says what that left behind.
 */
export interface EncounterVoidRouteOptions {
  /** Where the PHI-bearing detail goes. Defaults to console.error; the route test injects a capture. */
  log?: (...args: unknown[]) => void;
}

export function registerEncounterVoidRoutes(
  app: Express,
  authenticateService: () => Promise<unknown>,
  routeDeps: (authHeader: string | undefined, action: "chart.write") => Promise<EncounterVoidEndpointDeps>,
  options: EncounterVoidRouteOptions = {},
): void {
  const log = options.log ?? ((...args: unknown[]) => console.error(...args));
  app.post("/clinical-graph/encounters/:encounterId/void", async (req, res) => {
    try {
      await authenticateService();
      const authHeader = req.header("authorization");
      const result = await handleEncounterVoidRequest(
        await routeDeps(authHeader, "chart.write"),
        { authHeader, params: req.params, body: req.body },
      );
      res.status(result.status).json(result.body);
    } catch (error) {
      if (error instanceof VoidTransactionError) {
        log(
          "odos-mcp: encounter void transaction failed:",
          `Encounter/${req.params.encounterId}`,
          `outcome=${error.outcome}`,
          error.message,
          JSON.stringify(error.diagnostics),
        );
        if (!res.headersSent) res.status(502).json(error.clientBody);
        return;
      }
      log("odos-mcp: encounter void failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "encounter void route failed" });
    }
  });
}
