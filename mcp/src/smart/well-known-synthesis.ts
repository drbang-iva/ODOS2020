import { sanitizeForPublicEmission } from "../capability/capability-statement-synthesizer.js";

export function sanitizeSmartDiscoveryString(value: string, practicePublicBaseUrl: string): string {
  return sanitizeForPublicEmission(value, practicePublicBaseUrl);
}

export function sanitizeSmartDiscoveryStrings<T extends Record<string, unknown>>(
  value: T,
  practicePublicBaseUrl: string,
): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "string" ? sanitizeSmartDiscoveryString(nested, practicePublicBaseUrl) : nested,
    ),
  ) as T;
}
