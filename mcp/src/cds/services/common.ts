import { randomUUID } from "node:crypto";
import type { Coding, CodeableConcept, Observation, ServiceRequest } from "@medplum/fhirtypes";
import { baseRulesBasedDsiFields } from "../card-schema.js";
import {
  DEFAULT_CARD_TTL_MINUTES,
  SNOMED_CT_SYSTEM,
  type CdsCard,
  type CdsHookEvaluationInput,
} from "../types.js";

export const PERFORMANCE_OD_SOURCE_URL =
  "https://github.com/drbang-iva/performance-od/tree/main/reference/domain/open-source-od";

export function snomed(code: string, display: string): Coding {
  return { system: SNOMED_CT_SYSTEM, code, display };
}

export function serviceRequestMatchesAnyCode(
  serviceRequests: readonly ServiceRequest[] | undefined,
  codes: readonly Coding[],
): boolean {
  return matchingServiceRequests(serviceRequests, codes).length > 0;
}

export function matchingServiceRequests(
  serviceRequests: readonly ServiceRequest[] | undefined,
  codes: readonly Coding[],
): ServiceRequest[] {
  if (!serviceRequests?.length) {
    return [];
  }
  return serviceRequests.filter((request) => codeableConceptMatches(request.code, codes));
}

export function observationMatchesAnyCode(
  observations: readonly Observation[] | undefined,
  codes: readonly Coding[],
): boolean {
  return matchingObservations(observations, codes).length > 0;
}

export function matchingObservations(
  observations: readonly Observation[] | undefined,
  codes: readonly Coding[],
): Observation[] {
  if (!observations?.length) {
    return [];
  }
  return observations.filter((observation) => codeableConceptMatches(observation.code, codes));
}

export function codeableConceptMatches(concept: CodeableConcept | undefined, codes: readonly Coding[]): boolean {
  return (concept?.coding ?? []).some((candidate) =>
    codes.some((code) => candidate.system === code.system && candidate.code === code.code),
  );
}

export function codedPrefetchResources(input: CdsHookEvaluationInput): ServiceRequest[] {
  const resources: ServiceRequest[] = [];
  for (const value of Object.values(input.prefetch ?? {})) {
    collectServiceRequests(value, resources);
  }
  for (const value of Object.values(input.context ?? {})) {
    collectServiceRequests(value, resources);
  }
  return [...(input.serviceRequests ?? []), ...resources];
}

export function codedObservationPrefetchResources(input: CdsHookEvaluationInput): Observation[] {
  const resources: Observation[] = [];
  for (const value of Object.values(input.prefetch ?? {})) {
    collectObservations(value, resources);
  }
  for (const value of Object.values(input.context ?? {})) {
    collectObservations(value, resources);
  }
  return [...(input.observations ?? []), ...resources];
}

export function ruleCard(input: {
  readonly summary: string;
  readonly detail: string;
  readonly evidence: string;
  readonly indicator?: CdsCard["indicator"];
  readonly ttlMinutes?: number;
  readonly now?: Date;
  readonly suggestions?: CdsCard["suggestions"];
}): CdsCard {
  const dsiFields = baseRulesBasedDsiFields({ evidence: input.evidence });
  return {
    uuid: randomUUID(),
    summary: input.summary,
    indicator: input.indicator ?? "info",
    source: {
      label: "OSOD local specialty rules",
      url: PERFORMANCE_OD_SOURCE_URL,
    },
    detail: input.detail,
    suggestions: input.suggestions,
    links: [
      {
        label: "OSOD CDS Hooks operator guide",
        url: "https://osod.dev/docs/cds-hooks",
        type: "absolute",
      },
    ],
    card_ttl_minutes: input.ttlMinutes ?? DEFAULT_CARD_TTL_MINUTES,
    generatedAt: (input.now ?? new Date()).toISOString(),
    dsi_type: dsiFields.dsi_type,
    intervention_risk_management: dsiFields.intervention_risk_management,
    source_attributes: dsiFields.source_attributes,
  };
}

function collectServiceRequests(value: unknown, output: ServiceRequest[]): void {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectServiceRequests(entry, output);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.resourceType === "ServiceRequest") {
    output.push(record as unknown as ServiceRequest);
    return;
  }
  if (Array.isArray(record.entry)) {
    for (const entry of record.entry) {
      collectServiceRequests((entry as { resource?: unknown }).resource, output);
    }
  }
}

function collectObservations(value: unknown, output: Observation[]): void {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectObservations(entry, output);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.resourceType === "Observation") {
    output.push(record as unknown as Observation);
    return;
  }
  if (Array.isArray(record.entry)) {
    for (const entry of record.entry) {
      collectObservations((entry as { resource?: unknown }).resource, output);
    }
  }
}
