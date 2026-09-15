import type { Basic } from "@medplum/fhirtypes";

export const ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM = "https://odos2020.com/fhir/CodeSystem/age-of-majority-config";
export const ODOS_AGE_OF_MAJORITY_CONFIG_CODE = "odos-age-of-majority-config";
export const ODOS_AGE_OF_MAJORITY_CONFIG_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/odos-age-of-majority-practice-config";
export interface AgeOfMajorityConfig { ageOfMajorityYears: number }

function assertAge(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 16 || value > 21) {
    throw new Error("Age of majority is not configured: ageOfMajorityYears must be an integer from 16 to 21.");
  }
}

export function buildAgeOfMajorityConfigResource(config: AgeOfMajorityConfig, existing?: Basic): Basic {
  assertAge(config.ageOfMajorityYears);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: { coding: [{ system: ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM, code: ODOS_AGE_OF_MAJORITY_CONFIG_CODE }], text: "Age of majority" },
    extension: [{ url: ODOS_AGE_OF_MAJORITY_CONFIG_EXTENSION_URL, valueString: JSON.stringify({ ageOfMajorityYears: config.ageOfMajorityYears }) }],
  };
}

export function parseAgeOfMajorityConfig(basic: Basic): AgeOfMajorityConfig {
  if (basic.resourceType !== "Basic" || !basic.code?.coding?.some((coding) => coding.system === ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM && coding.code === ODOS_AGE_OF_MAJORITY_CONFIG_CODE)) {
    throw new Error("Age of majority is not configured: wrong singleton code.");
  }
  const extensions = basic.extension?.filter((extension) => extension.url === ODOS_AGE_OF_MAJORITY_CONFIG_EXTENSION_URL) ?? [];
  let parsed: unknown;
  try { parsed = extensions.length === 1 ? JSON.parse(extensions[0]?.valueString ?? "") : undefined; }
  catch { throw new Error("Age of majority is not configured: malformed configuration."); }
  const age = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).ageOfMajorityYears : undefined;
  assertAge(age);
  return { ageOfMajorityYears: age };
}

export function resolveAgeOfMajorityYears(basic?: Basic): number {
  if (!basic) throw new Error("Age of majority is not configured (ageOfMajorityYears).");
  return parseAgeOfMajorityConfig(basic).ageOfMajorityYears;
}

export function isMinorAtAge(birthDate: string, today: string, ageOfMajorityYears: number): boolean {
  assertAge(ageOfMajorityYears);
  const [year, month, day] = birthDate.split("-").map(Number);
  const majorityDate = `${String(year! + ageOfMajorityYears).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return today < majorityDate;
}
