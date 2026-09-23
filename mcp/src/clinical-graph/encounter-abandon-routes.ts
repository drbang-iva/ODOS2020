import type { Express } from "express";
import { rateLimit } from "express-rate-limit";
import { handleEncounterAbandonRequest, type EncounterAbandonEndpointDeps } from "./encounter-abandon-endpoint.js";

export function registerEncounterAbandonRoutes(
  app: Express,
  authenticateService: () => Promise<unknown>,
  routeDeps: (authHeader: string | undefined, action: "chart.write") => Promise<EncounterAbandonEndpointDeps>,
): void {
  const abandonWriteLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many abandon requests. Try again shortly." },
  });
  app.post("/clinical-graph/encounters/:encounterId/abandon", abandonWriteLimit, async (req, res) => {
    try {
      await authenticateService();
      const authHeader = req.header("authorization");
      const result = await handleEncounterAbandonRequest(await routeDeps(authHeader, "chart.write"), { authHeader, params: req.params });
      res.status(result.status).json(result.body);
    } catch {
      res.status(502).json({ error: "Could not confirm whether the visit was abandoned. Reload the visit before trying again." });
    }
  });
}
