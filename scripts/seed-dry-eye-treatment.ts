#!/usr/bin/env tsx
import type { PackageDefinition, PackageDefinitionDraft } from "../mcp/src/commercial-engine/ledger-store.js";
import { DRY_EYE_PROCEDURE_STABLE_KEYS } from "../mcp/src/clinical-graph/procedure-definition-store.js";
import type {
  SeriesProtocolDefinition,
  SeriesProtocolDefinitionDraft,
} from "../mcp/src/series-tracker/protocol-definition-store.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";
import { loginForLocalRepair } from "./repair-practice-roles.js";

const DEFAULT_MEDPLUM_BASE_URL = "http://localhost:8103";
const DEFAULT_MCP_BASE_URL = "http://localhost:3333";

export const DRY_EYE_SERIES_PROTOCOL_DRAFTS: readonly SeriesProtocolDefinitionDraft[] = [
  {
    id: "dry-eye-ipl",
    name: "IPL",
    eligibleProcedureTypeCodes: [DRY_EYE_PROCEDURE_STABLE_KEYS.ipl],
    sessionCount: 4,
    intervalMinDays: 21,
    intervalMaxDays: 28,
    maintenanceAfter: true,
  },
  {
    id: "dry-eye-lllt",
    name: "LLLT",
    eligibleProcedureTypeCodes: [DRY_EYE_PROCEDURE_STABLE_KEYS.lllt],
    sessionCount: 4,
    intervalMinDays: 21,
    intervalMaxDays: 28,
    maintenanceAfter: true,
  },
] as const;

export const DRY_EYE_PACKAGE_DEFINITION_DRAFTS: readonly PackageDefinitionDraft[] = [
  {
    name: "IPL single session",
    eligibleProcedureTypeCodes: [DRY_EYE_PROCEDURE_STABLE_KEYS.ipl],
    sessionCount: 1,
    priceCents: 45_000,
    expiryDays: 365,
    refundPolicy: "non_refundable",
  },
  {
    name: "IPL 4 sessions",
    eligibleProcedureTypeCodes: [DRY_EYE_PROCEDURE_STABLE_KEYS.ipl],
    sessionCount: 4,
    priceCents: 160_000,
    expiryDays: 365,
    refundPolicy: "non_refundable",
  },
  {
    name: "LLLT single session",
    eligibleProcedureTypeCodes: [DRY_EYE_PROCEDURE_STABLE_KEYS.lllt],
    sessionCount: 1,
    priceCents: 12_500,
    expiryDays: 365,
    refundPolicy: "non_refundable",
  },
  {
    name: "LLLT 4 sessions",
    eligibleProcedureTypeCodes: [DRY_EYE_PROCEDURE_STABLE_KEYS.lllt],
    sessionCount: 4,
    priceCents: 40_000,
    expiryDays: 365,
    refundPolicy: "non_refundable",
  },
] as const;

export interface DryEyeTreatmentSeedAdapter {
  listSeriesProtocols(): Promise<SeriesProtocolDefinition[]>;
  saveSeriesProtocol(draft: SeriesProtocolDefinitionDraft): Promise<SeriesProtocolDefinition>;
  listPackageDefinitions(): Promise<PackageDefinition[]>;
  savePackageDefinition(draft: PackageDefinitionDraft): Promise<PackageDefinition>;
}

export interface DryEyeTreatmentSeedResult {
  series: { created: string[]; updated: string[]; unchanged: string[]; skippedArchived: string[] };
  packages: { created: string[]; updated: string[]; unchanged: string[]; skippedArchived: string[] };
}

export async function seedDryEyeTreatmentDefinitions(
  adapter: DryEyeTreatmentSeedAdapter,
): Promise<DryEyeTreatmentSeedResult> {
  const result: DryEyeTreatmentSeedResult = {
    series: { created: [], updated: [], unchanged: [], skippedArchived: [] },
    packages: { created: [], updated: [], unchanged: [], skippedArchived: [] },
  };
  const series = await adapter.listSeriesProtocols();
  for (const draft of DRY_EYE_SERIES_PROTOCOL_DRAFTS) {
    const matching = series.filter((candidate) => candidate.id === draft.id);
    const active = matching.filter((candidate) => candidate.active);
    if (active.length > 1) throw new Error(`Series protocol ${draft.id} has ${active.length} active matches; seed stopped.`);
    if (!active[0] && matching.length > 0) {
      result.series.skippedArchived.push(draft.name);
    } else if (!active[0]) {
      await adapter.saveSeriesProtocol(draft);
      result.series.created.push(draft.name);
    } else if (seriesMatches(active[0], draft)) {
      result.series.unchanged.push(draft.name);
    } else {
      await adapter.saveSeriesProtocol(draft);
      result.series.updated.push(draft.name);
    }
  }

  const packages = await adapter.listPackageDefinitions();
  for (const draft of DRY_EYE_PACKAGE_DEFINITION_DRAFTS) {
    const matching = packages.filter((candidate) => candidate.name === draft.name);
    const active = matching.filter((candidate) => candidate.active);
    if (active.length > 1) throw new Error(`Package ${draft.name} has ${active.length} active matches; seed stopped.`);
    if (!active[0] && matching.length > 0) {
      result.packages.skippedArchived.push(draft.name);
    } else if (!active[0]) {
      await adapter.savePackageDefinition(draft);
      result.packages.created.push(draft.name);
    } else if (packageMatches(active[0], draft)) {
      result.packages.unchanged.push(draft.name);
    } else {
      await adapter.savePackageDefinition({ ...draft, id: active[0].id });
      result.packages.updated.push(draft.name);
    }
  }
  return result;
}

class LiveDryEyeTreatmentSeedAdapter implements DryEyeTreatmentSeedAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly authorization: string,
  ) {}

  async listSeriesProtocols(): Promise<SeriesProtocolDefinition[]> {
    return (await this.request<{ protocols: SeriesProtocolDefinition[] }>(
      "/series-tracker/protocols?includeArchived=true",
    )).protocols;
  }

  async saveSeriesProtocol(draft: SeriesProtocolDefinitionDraft): Promise<SeriesProtocolDefinition> {
    return (await this.request<{ protocol: SeriesProtocolDefinition }>(
      "/series-tracker/protocols",
      draft,
    )).protocol;
  }

  async listPackageDefinitions(): Promise<PackageDefinition[]> {
    return (await this.request<{ definitions: PackageDefinition[] }>(
      "/commercial-engine/definitions?includeArchived=true",
    )).definitions;
  }

  async savePackageDefinition(draft: PackageDefinitionDraft): Promise<PackageDefinition> {
    return (await this.request<{ definition: PackageDefinition }>(
      "/commercial-engine/definitions",
      draft,
    )).definition;
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              Authorization: this.authorization,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }),
      ...(body === undefined ? { headers: { Authorization: this.authorization } } : {}),
    });
    if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
    return await response.json() as T;
  }
}

function seriesMatches(
  definition: SeriesProtocolDefinition,
  draft: SeriesProtocolDefinitionDraft,
): boolean {
  return definition.name === draft.name &&
    sameStrings(definition.eligibleProcedureTypeCodes, draft.eligibleProcedureTypeCodes) &&
    definition.sessionCount === draft.sessionCount &&
    definition.intervalMinDays === draft.intervalMinDays &&
    definition.intervalMaxDays === draft.intervalMaxDays &&
    definition.maintenanceAfter === draft.maintenanceAfter &&
    definition.active;
}

function packageMatches(
  definition: PackageDefinition,
  draft: PackageDefinitionDraft,
): boolean {
  return sameStrings(definition.eligibleProcedureTypeCodes, draft.eligibleProcedureTypeCodes) &&
    definition.sessionCount === draft.sessionCount &&
    definition.priceCents === draft.priceCents &&
    definition.expiryDays === (draft.expiryDays ?? 365) &&
    definition.refundPolicy === (draft.refundPolicy ?? "non_refundable") &&
    definition.active;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

async function runCli(): Promise<void> {
  const medplumBaseUrl = (process.env.MEDPLUM_BASE_URL ?? DEFAULT_MEDPLUM_BASE_URL).replace(/\/$/, "");
  const mcpBaseUrl = (process.env.ODOS_MCP_BASE_URL ?? DEFAULT_MCP_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(medplumBaseUrl);
  assertLocalMedplumBaseUrl(mcpBaseUrl);
  const email = requireEnv("ODOS_ADMIN_EMAIL", "MEDPLUM_ADMIN_EMAIL");
  const password = requireEnv("ODOS_ADMIN_PASSWORD", "MEDPLUM_ADMIN_PASSWORD");
  const accessToken = await loginForLocalRepair({ baseUrl: medplumBaseUrl, email, password });
  const result = await seedDryEyeTreatmentDefinitions(
    new LiveDryEyeTreatmentSeedAdapter(mcpBaseUrl, `Bearer ${accessToken}`),
  );
  console.log(`Series protocols: ${summary(result.series)}`);
  console.log(`Package definitions: ${summary(result.packages)}`);
}

function summary(result: {
  created: string[];
  updated: string[];
  unchanged: string[];
  skippedArchived: string[];
}): string {
  const archived = result.skippedArchived.length > 0
    ? `${result.skippedArchived.length} skipped — archived (${result.skippedArchived.join(", ")})`
    : "0 skipped — archived";
  return `${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged, ` +
    archived;
}

function requireEnv(primary: string, fallback: string): string {
  const value = process.env[primary]?.trim() || process.env[fallback]?.trim();
  if (!value) throw new Error(`${primary} or ${fallback} is required.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
