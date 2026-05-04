import { randomUUID } from "node:crypto";
import type {
  CdsCard,
  CdsDsiType,
  CdsInterventionRiskManagement,
  CdsSourceAttributes,
} from "./types.js";
import { hasPredictiveDsiSourceAttributes } from "../agentops/device-registry.js";
import { INITIATION_MODES } from "../agentops/types.js";
import type { Device } from "@medplum/fhirtypes";

export interface CdsCardValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface CdsCardValidationOptions {
  readonly agentOrigin?: boolean;
  readonly agentDevice?: Device;
}

const DSI_TYPES: readonly CdsDsiType[] = ["predictive", "evidence-based", "rules-based"];
const INDICATORS = ["info", "warning", "critical"] as const;

export function validateCdsCard(card: unknown, options: CdsCardValidationOptions = {}): CdsCardValidationResult {
  const errors: string[] = [];
  if (!isRecord(card)) {
    return { valid: false, errors: ["card must be an object"] };
  }
  requireString(card, "uuid", errors);
  const summary = requireString(card, "summary", errors);
  if (summary && summary.length > 140) {
    errors.push("summary must be 140 characters or fewer");
  }
  const indicator = requireString(card, "indicator", errors);
  if (indicator && !INDICATORS.includes(indicator as (typeof INDICATORS)[number])) {
    errors.push("indicator must be info, warning, or critical");
  }
  if (!isRecord(card.source) || typeof card.source.label !== "string" || !card.source.label.trim()) {
    errors.push("source.label is required");
  }

  const dsiType = requireString(card, "dsi_type", errors);
  if (dsiType && !DSI_TYPES.includes(dsiType as CdsDsiType)) {
    errors.push("dsi_type must be predictive, evidence-based, or rules-based");
  }
  requireRiskManagement(card.intervention_risk_management, errors);
  requireSourceAttributes(card.source_attributes, errors);
  const hasAgentFields = typeof card.initiation_mode === "string" || typeof card.agent_device_reference === "string";
  if (options.agentOrigin || hasAgentFields) {
    const initiationMode = requireString(card, "initiation_mode", errors);
    if (initiationMode && !INITIATION_MODES.includes(initiationMode as (typeof INITIATION_MODES)[number])) {
      errors.push("initiation_mode must be user-initiated or autonomously-initiated");
    }
    const reference = requireString(card, "agent_device_reference", errors);
    if (reference && !reference.startsWith("Device/")) {
      errors.push("agent_device_reference must be a FHIR Reference(Device)");
    }
  }

  if (dsiType === "predictive") {
    if (!Array.isArray(card.training_data_demographics) || card.training_data_demographics.length === 0) {
      errors.push("training_data_demographics is required for predictive cards");
    }
    if (!isRecord(card.algorithmic_validity_bounds)) {
      errors.push("algorithmic_validity_bounds is required for predictive cards");
    } else {
      for (const field of [
        "intended_use_scope",
        "intended_user",
        "intended_health_outcome",
        "performance_metrics",
      ]) {
        if (typeof card.algorithmic_validity_bounds[field] !== "string" || !card.algorithmic_validity_bounds[field]) {
          errors.push(`algorithmic_validity_bounds.${field} is required for predictive cards`);
        }
      }
    }
    if ((options.agentOrigin || hasAgentFields) && !hasPredictiveDsiSourceAttributes(options.agentDevice)) {
      errors.push("dsi-source-attributes-missing");
    }
  }

  if (containsExecutableContent(card)) {
    errors.push("card contains executable content");
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidCdsCard(card: unknown, options: CdsCardValidationOptions = {}): asserts card is CdsCard {
  const result = validateCdsCard(card, options);
  if (!result.valid) {
    throw new Error(`CDS card validation failed: ${result.errors.join("; ")}`);
  }
}

export function validatedCdsCards(cards: readonly unknown[]): {
  readonly accepted: CdsCard[];
  readonly rejected: Array<{ readonly card: unknown; readonly errors: readonly string[] }>;
} {
  const accepted: CdsCard[] = [];
  const rejected: Array<{ card: unknown; errors: readonly string[] }> = [];
  for (const card of cards) {
    const candidate = withGeneratedCardUuid(card);
    const result = validateCdsCard(candidate);
    if (result.valid) {
      accepted.push(candidate as CdsCard);
    } else {
      rejected.push({ card: candidate, errors: result.errors });
    }
  }
  return { accepted, rejected };
}

export function isCdsCardFresh(card: CdsCard, now = new Date()): boolean {
  if (!card.generatedAt) {
    return true;
  }
  const ttl = Math.max(card.card_ttl_minutes ?? 60, 1);
  return Date.parse(card.generatedAt) + ttl * 60_000 > now.getTime();
}

export function baseRulesBasedDsiFields(input: {
  readonly evidence: string;
  readonly monitoring?: string;
}): Pick<CdsCard, "dsi_type" | "intervention_risk_management" | "source_attributes"> {
  return {
    dsi_type: "rules-based",
    intervention_risk_management: {
      risk_identification: "Rules fire only from coded FHIR context and do not infer from images or raw media.",
      risk_mitigation: "Clinician remains responsible for accepting, ignoring, or overriding the card.",
      continual_monitoring: input.monitoring ?? "Practice admins review feedback and stale-card audit events.",
    },
    source_attributes: {
      developer_identity: "PerformanceOD / OSOD",
      funding_source: "OSOD open-source project",
      evidence_basis_citation: input.evidence,
    },
  };
}

function requireRiskManagement(value: unknown, errors: string[]): asserts value is CdsInterventionRiskManagement {
  if (!isRecord(value)) {
    errors.push("intervention_risk_management is required");
    return;
  }
  for (const field of ["risk_identification", "risk_mitigation", "continual_monitoring"]) {
    if (typeof value[field] !== "string" || !value[field]) {
      errors.push(`intervention_risk_management.${field} is required`);
    }
  }
}

function requireSourceAttributes(value: unknown, errors: string[]): asserts value is CdsSourceAttributes {
  if (!isRecord(value)) {
    errors.push("source_attributes is required");
    return;
  }
  for (const field of ["developer_identity", "funding_source", "evidence_basis_citation"]) {
    if (typeof value[field] !== "string" || !value[field]) {
      errors.push(`source_attributes.${field} is required`);
    }
  }
}

function requireString(record: Record<string, unknown>, field: string, errors: string[]): string | undefined {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} is required`);
    return undefined;
  }
  return value;
}

function withGeneratedCardUuid(card: unknown): unknown {
  if (!isRecord(card) || typeof card.uuid === "string") {
    return card;
  }
  return { ...card, uuid: randomUUID() };
}

function containsExecutableContent(value: unknown): boolean {
  if (typeof value === "string") {
    return /<script\b|javascript:|data:text\/html/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsExecutableContent);
  }
  if (!isRecord(value)) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/script|onclick|onload|executable/i.test(key)) {
      return true;
    }
    if (key === "body" && typeof child === "string") {
      return true;
    }
    if (containsExecutableContent(child)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
