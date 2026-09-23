import type { Basic } from "@medplum/fhirtypes";
import type { FhirSearchClient } from "../fhir-search.js";

export const ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM = "https://odos2020.com/fhir/CodeSystem/practice-time-zone-config";
export const ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE = "odos-practice-time-zone-config";
export const ODOS_PRACTICE_TIME_ZONE_CONFIG_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/odos-practice-time-zone-config";
export interface PracticeTimeZoneConfig { timeZone: string }
export interface ResolvedPracticeTimeZone extends PracticeTimeZoneConfig {
  timeZoneSource: "setting" | "environment";
  warnings?: string[];
}
export class PracticeTimeZoneError extends Error {
  constructor(readonly code: "practice-time-zone-invalid" | "practice-time-zone-unset" | "practice-time-zone-unreadable") {
    super(code);
  }
}
export function validatePracticeTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("An IANA time zone is required.");
  return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
}
export function buildPracticeTimeZoneConfigResource(config: PracticeTimeZoneConfig, existing?: Basic): Basic {
  const timeZone = validatePracticeTimeZone(config.timeZone);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: { coding: [{ system: ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM, code: ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE }], text: "Practice time zone" },
    extension: [{ url: ODOS_PRACTICE_TIME_ZONE_CONFIG_EXTENSION_URL, valueString: JSON.stringify({ timeZone }) }],
  };
}
export function parsePracticeTimeZoneConfig(resource: Basic): PracticeTimeZoneConfig {
  if (resource.resourceType !== "Basic" || !resource.code?.coding?.some(c => c.system === ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM && c.code === ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE)) throw new Error("Wrong practice time-zone singleton code.");
  const extensions = resource.extension?.filter(e => e.url === ODOS_PRACTICE_TIME_ZONE_CONFIG_EXTENSION_URL) ?? [];
  if (extensions.length !== 1) throw new Error("Malformed practice time-zone configuration.");
  const parsed: unknown = JSON.parse(extensions[0].valueString ?? "");
  return { timeZone: validatePracticeTimeZone(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).timeZone : undefined) };
}
export async function resolvePracticeTimeZone(serviceFhir: Pick<FhirSearchClient, "search">, envZone?: string): Promise<ResolvedPracticeTimeZone> {
  let rows: Basic[];
  let multiple: boolean;
  try {
    // fhir-scope-contract: Basic?code=https://odos2020.com/fhir/CodeSystem/practice-time-zone-config|odos-practice-time-zone-config
    const bundle = await serviceFhir.search<Basic>("Basic", { code: `${ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM}|${ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE}`, _sort: "-_lastUpdated", _count: "2" });
    rows = (bundle.entry ?? []).flatMap(e => e.resource ? [e.resource] : []);
    multiple = rows.length > 1 || Boolean(bundle.link?.some(link => link.relation === "next"));
  } catch { throw new PracticeTimeZoneError("practice-time-zone-unreadable"); }
  if (rows.length) {
    try {
      return { ...parsePracticeTimeZoneConfig(rows[0]), timeZoneSource: "setting", ...(multiple ? { warnings: ["Multiple practice time-zone settings found; the newest is used."] } : {}) };
    } catch { throw new PracticeTimeZoneError("practice-time-zone-invalid"); }
  }
  try { return { timeZone: validatePracticeTimeZone(envZone), timeZoneSource: "environment" }; }
  catch { throw new PracticeTimeZoneError("practice-time-zone-unset"); }
}
