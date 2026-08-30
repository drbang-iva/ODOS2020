import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import type { WatcherPracticeConfig } from "./watcher-types.js";

export const WATCHER_HEALTH_SYSTEM = "https://odos2020.com/fhir/CodeSystem/watcher-health";
export const WATCHER_HEALTH_CODE = "odos-watcher-health";
const WATCHER_HEALTH_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/watcher-engine-health";

export interface WatcherHealthState {
  lastAttemptAt: string;
  lastSuccessfulAt?: string;
  outcome: "running" | "healthy" | "failed";
  failureDetail?: string;
}

export type WatcherHealthProjection =
  | { status: "healthy"; lastSuccessfulAt: string }
  | { status: "degraded"; reason: "failed" | "stale" | "never-succeeded"; lastSuccessfulAt?: string };

export interface WatcherHealthFhir {
  search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string>): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T>;
  update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T>;
}

export function buildWatcherHealthResource(state: WatcherHealthState, existing?: Basic): Basic {
  const validated = validateState(state);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [{ system: WATCHER_HEALTH_SYSTEM, code: WATCHER_HEALTH_CODE }],
      text: "ODOS Watcher Engine Health",
    },
    extension: [{ url: WATCHER_HEALTH_EXTENSION_URL, valueString: JSON.stringify(validated) }],
  };
}

export function parseWatcherHealthResource(resource: Basic): WatcherHealthState {
  const coded = resource.code?.coding?.some(
    (coding) => coding.system === WATCHER_HEALTH_SYSTEM && coding.code === WATCHER_HEALTH_CODE,
  );
  if (!coded) throw new Error("Basic resource is not the watcher-health singleton.");
  const raw = resource.extension?.find((extension) => extension.url === WATCHER_HEALTH_EXTENSION_URL)?.valueString;
  if (!raw) throw new Error("Watcher-health singleton is missing its state extension.");
  try {
    return validateState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Watcher-health JSON is malformed and cannot be parsed.");
    throw error;
  }
}

export async function loadWatcherHealth(fhir: WatcherHealthFhir): Promise<{ resource?: Basic; state?: WatcherHealthState }> {
  // search-contract: watcher-health.search-singleton
  const bundle = await fhir.search<Basic>("Basic", {
    code: `${WATCHER_HEALTH_SYSTEM}|${WATCHER_HEALTH_CODE}`,
    _count: "2",
  });
  const resources = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  if (resources.length > 1) throw new Error("Watcher-health singleton search returned multiple resources.");
  return resources[0]
    ? { resource: resources[0], state: parseWatcherHealthResource(resources[0]) }
    : {};
}

export async function saveWatcherHealth(
  fhir: WatcherHealthFhir,
  state: WatcherHealthState,
): Promise<Basic> {
  const current = await loadWatcherHealth(fhir);
  const resource = buildWatcherHealthResource(state, current.resource);
  if (resource.id) return fhir.update("Basic", resource.id, resource);
  return fhir.create(resource, {
    "If-None-Exist": `code=${WATCHER_HEALTH_SYSTEM}|${WATCHER_HEALTH_CODE}`,
  });
}

export function projectWatcherHealth(
  state: WatcherHealthState | undefined,
  config: WatcherPracticeConfig,
  now: string,
): WatcherHealthProjection {
  if (!state?.lastSuccessfulAt) {
    return { status: "degraded", reason: "never-succeeded" };
  }
  if (state.outcome === "failed") {
    return { status: "degraded", reason: "failed", lastSuccessfulAt: state.lastSuccessfulAt };
  }
  const freshnessMs = config.staleAfterMinutes * 60_000;
  if (Date.parse(now) - Date.parse(state.lastSuccessfulAt) > freshnessMs) {
    return { status: "degraded", reason: "stale", lastSuccessfulAt: state.lastSuccessfulAt };
  }
  return { status: "healthy", lastSuccessfulAt: state.lastSuccessfulAt };
}

function validateState(value: unknown): WatcherHealthState {
  const state = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const lastAttemptAt = instant(state.lastAttemptAt, "Watcher last attempt");
  const lastSuccessfulAt = state.lastSuccessfulAt === undefined
    ? undefined
    : instant(state.lastSuccessfulAt, "Watcher last success");
  if (!new Set(["running", "healthy", "failed"]).has(String(state.outcome))) {
    throw new Error("Watcher health outcome is invalid.");
  }
  const failureDetail = typeof state.failureDetail === "string" && state.failureDetail.trim()
    ? state.failureDetail.trim()
    : undefined;
  return {
    lastAttemptAt,
    ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}),
    outcome: state.outcome as WatcherHealthState["outcome"],
    ...(failureDetail ? { failureDetail } : {}),
  };
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO dateTime.`);
  }
  return value;
}
