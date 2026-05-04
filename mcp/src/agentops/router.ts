import express, { type Router } from "express";
import {
  InMemoryAgentOpsDeviceRegistry,
  type AgentRegistrationInput,
} from "./device-registry.js";
import type { AgentOpsThresholdMatrixStore } from "./threshold-matrix-loader.js";

export const DEFAULT_AGENTOPS_CAPABILITIES = [
  "agent_registration",
  "threshold_matrix_query",
  "safety_valve_inspection",
  "audit_record_query",
] as const;

export interface AgentOpsRouterOptions {
  readonly registry?: InMemoryAgentOpsDeviceRegistry;
  readonly thresholdMatrix?: AgentOpsThresholdMatrixStore;
}

export function createAgentOpsRouter(options: AgentOpsRouterOptions = {}): Router {
  const router = express.Router();
  const registry = options.registry ?? new InMemoryAgentOpsDeviceRegistry();

  router.post("/agents/register", (req, res) => {
    try {
      const input = parseRegistrationRequest(req.body);
      const result = registry.register(input);
      if (result.status === "pending-review") {
        res.status(202).json({ status: "pending_review" });
        return;
      }
      res.status(201).json({
        status: "registered",
        agent_device: result.agentDevice,
        model_device: result.modelDevice,
        provenance: result.provenance,
      });
    } catch (error) {
      res.status(403).json({
        error: "agentops_registration_blocked",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post("/agents/:agentId/deactivate", (req, res) => {
    const agentUri = `https://osod.dev/agents/${req.params.agentId}`;
    const device = registry.getDevice(agentUri);
    if (!device) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }
    res.status(202).json({
      status: "deactivation_pending_review",
      agent_device: `Device/${device.id}`,
      activity: "nullify",
    });
  });

  router.post("/policies/evaluate", (req, res) => {
    if (!options.thresholdMatrix) {
      res.status(503).json({ error: "threshold_matrix_unavailable" });
      return;
    }
    res.json(options.thresholdMatrix.lookup(req.body));
  });

  router.get("/capabilities", (_req, res) => {
    res.json({ capabilities: DEFAULT_AGENTOPS_CAPABILITIES });
  });

  return router;
}

function parseRegistrationRequest(body: unknown): AgentRegistrationInput {
  if (!isRecord(body)) {
    throw new Error("Agent registration body must be an object.");
  }
  const model = isRecord(body.model) ? body.model : {};
  return {
    agentUri: stringField(body, "agent_uri"),
    agentLogicalName: stringField(body, "agent_logical_name"),
    agentRole: stringField(body, "agent_role"),
    agentRiskClass: stringField(body, "agent_risk_class") as AgentRegistrationInput["agentRiskClass"],
    initiationModeCapabilities: arrayField(body, "initiation_mode_capabilities") as AgentRegistrationInput["initiationModeCapabilities"],
    vendorBaaStatus: stringField(body, "vendor_baa_status"),
    manufacturer: optionalStringField(body, "manufacturer"),
    deploymentDistinctIdentifier: stringField(body, "deployment_distinct_identifier"),
    adminReviewStatus: body.admin_approved === true ? "approved" : "pending",
    adminBaaConfirmation: body.admin_baa_confirmation === true,
    declaresThirdPartyMcpRouting: body.declares_third_party_mcp_routing === true,
    model: {
      modelUri: stringField(model, "model_uri"),
      vendorName: stringField(model, "vendor_name"),
      modelName: stringField(model, "model_name"),
      modelVersion: stringField(model, "model_version"),
      vendorBaaEligible: model.vendor_baa_eligible === true,
      mcpBaaCarveOut: model.mcp_baa_carve_out === true,
      modelFingerprint: optionalStringField(model, "model_fingerprint"),
    },
  };
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value ? value : undefined;
}

function arrayField(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} is required.`);
  }
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
