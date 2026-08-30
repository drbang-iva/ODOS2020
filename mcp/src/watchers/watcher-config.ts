import type { Basic, Bundle } from "@medplum/fhirtypes";
import type {
  WatcherPracticeConfig,
  WatcherPracticeSettings,
  WatcherRegistry,
  WatcherSeverity,
} from "./watcher-types.js";

export const WATCHER_CONFIG_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/watcher-config";
export const WATCHER_CONFIG_CODE = "odos-watcher-config";
export const WATCHER_CONFIG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/watcher-practice-config";

interface WatcherConfigFhir {
  search<T extends Basic>(resourceType: "Basic", params: Record<string, string>): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, headers?: Record<string, string>): Promise<T>;
}

const SEVERITIES = new Set<WatcherSeverity>(["today", "this-week", "watch"]);

export function buildWatcherConfigResource(
  config: WatcherPracticeConfig,
  existing?: Basic,
): Basic {
  const validated = validateConfig(config);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [{
        system: WATCHER_CONFIG_SYSTEM,
        code: WATCHER_CONFIG_CODE,
        display: "ODOS Watcher Practice Config",
      }],
      text: "ODOS Watcher Practice Config",
    },
    extension: [{
      url: WATCHER_CONFIG_EXTENSION_URL,
      valueString: JSON.stringify(validated),
    }],
  };
}

export function parseWatcherConfigResource(resource: Basic): WatcherPracticeConfig {
  if (!resource.code?.coding?.some(
    (coding) => coding.system === WATCHER_CONFIG_SYSTEM && coding.code === WATCHER_CONFIG_CODE,
  )) {
    throw new Error("Basic resource is not the ODOS watcher-config singleton.");
  }
  const raw = resource.extension?.find(
    (extension) => extension.url === WATCHER_CONFIG_EXTENSION_URL,
  )?.valueString;
  if (!raw) throw new Error("Watcher-config singleton is missing its config extension.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Watcher-config JSON is malformed and cannot be parsed.");
  }
  return validateConfig(parsed);
}

export async function loadOrSeedWatcherConfig(
  fhir: WatcherConfigFhir,
  registry: WatcherRegistry,
  now: () => string = () => new Date().toISOString(),
): Promise<WatcherPracticeConfig> {
  // search-contract: watcher-config.search-singleton
  const bundle = await fhir.search<Basic>("Basic", {
    code: `${WATCHER_CONFIG_SYSTEM}|${WATCHER_CONFIG_CODE}`,
    _count: "2",
  });
  const resources = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  if (resources.length > 1) throw new Error("Watcher-config singleton search returned multiple resources.");
  if (resources[0]) return parseWatcherConfigResource(resources[0]);

  const seeded: WatcherPracticeConfig = {
    version: 1,
    goLiveAt: validInstant(now(), "Watcher go-live time"),
    needsHumanCap: 5,
    staleAfterMinutes: 15,
    watchers: Object.fromEntries(registry.list().map((definition) => [
      definition.id,
      { ...definition.seedSettings },
    ])),
  };
  const created = await fhir.create(
    buildWatcherConfigResource(seeded),
    { "If-None-Exist": `code=${WATCHER_CONFIG_SYSTEM}|${WATCHER_CONFIG_CODE}` },
  );
  return parseWatcherConfigResource(created);
}

function validateConfig(value: unknown): WatcherPracticeConfig {
  const candidate = record(value);
  if (candidate.version !== 1) throw new Error("Watcher config version must be 1.");
  const goLiveAt = validInstant(candidate.goLiveAt, "Watcher go-live time");
  const needsHumanCap = positiveInteger(candidate.needsHumanCap, "Needs-a-human cap");
  const staleAfterMinutes = positiveInteger(candidate.staleAfterMinutes, "Watcher freshness minutes");
  const watchersInput = record(candidate.watchers);
  const watchers: Record<string, WatcherPracticeSettings> = {};
  for (const [id, raw] of Object.entries(watchersInput)) {
    if (!id.trim()) throw new Error("Watcher config contains a blank watcher id.");
    const settings = record(raw);
    if (typeof settings.enabled !== "boolean") throw new Error(`${id} enabled must be boolean.`);
    if (!SEVERITIES.has(settings.severity as WatcherSeverity)) throw new Error(`${id} severity is invalid.`);
    const parsed: WatcherPracticeSettings = {
      enabled: settings.enabled,
      severity: settings.severity as WatcherSeverity,
    };
    for (const [key, setting] of Object.entries(settings)) {
      if (key === "enabled" || key === "severity") continue;
      if (!["boolean", "number", "string"].includes(typeof setting)) {
        throw new Error(`${id} setting ${key} must be scalar.`);
      }
      if (typeof setting === "number" && !Number.isFinite(setting)) {
        throw new Error(`${id} setting ${key} must be finite.`);
      }
      parsed[key] = setting as boolean | number | string;
    }
    watchers[id] = parsed;
  }
  return { version: 1, goLiveAt, needsHumanCap, staleAfterMinutes, watchers };
}

function validInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO dateTime.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer.`);
  return Number(value);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
