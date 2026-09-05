import type { Express } from "express";
import { handleHistoryItemActsRequest, handleHistoryItemReviewRequest, handleHistoryItemRetractionRequest, type HpiEndpointDeps } from "./hpi-endpoint.js";

export function registerHistoryItemRoutes(app: Express, deps: (authHeader: string | undefined, action: "chart.read" | "chart.write") => Promise<HpiEndpointDeps>) {
  app.get("/clinical-graph/encounters/:encounterId/history/items", async (req, res) => {
    try {
      const authHeader = req.header("authorization");
      const result = await handleHistoryItemActsRequest(await deps(authHeader, "chart.read"), { authHeader, params: req.params });
      res.status(result.status).json(result.body);
    } catch {
      res.status(500).json({ error: "History item read failed." });
    }
  });
  for (const [path, handler] of [
    ["review", handleHistoryItemReviewRequest], ["retract", handleHistoryItemRetractionRequest],
  ] as const) {
    app.post(`/clinical-graph/history/items/${path}`, async (req, res) => {
      try {
        const authHeader = req.header("authorization");
        const result = await handler(await deps(authHeader, "chart.write"), { authHeader, body: req.body });
        res.status(result.status).json(result.body);
      } catch {
        res.status(500).json({ error: "History item gesture failed." });
      }
    });
  }
}
