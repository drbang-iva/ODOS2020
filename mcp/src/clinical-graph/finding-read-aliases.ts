import type { AtomicFindingCatalogRow } from "./diagnosis-findings-endpoint.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";
import { customFieldEntries, type FindingQualifierValue } from "./custom-fields.js";
import { translateRetiredFindingRead } from "./finding-read-compatibility.js";

const RETIRED_OPTIONS = [
  ["ocular-health:anterior:lens", "brunescent"],
  ["ocular-health:anterior:cornea", "iron-line-hudson-stahli-stocker-s-fleischer-s"],
  ["ocular-health:posterior:macula", "macular-hole-full-lamellar"],
  ["ocular-health:posterior:periphery", "operculated-hole"],
  ["ocular-health:posterior:periphery", "horseshoe-tear"],
] as const;

export interface FindingReadAlias {
  row?: AtomicFindingCatalogRow;
  qualifiers: Record<string, FindingQualifierValue>;
  reason?: string;
}

export function buildFindingReadAliases(
  definitions: readonly ClinicalFindingDefinition[],
  catalog: readonly AtomicFindingCatalogRow[],
): ReadonlyMap<string, FindingReadAlias> {
  const aliases = new Map<string, FindingReadAlias>();
  for (const [stableKey, retiredOption] of RETIRED_OPTIONS) {
    const definition = definitions.find(d => d.stableKey === stableKey);
    if (!definition) continue;
    for (const field of customFieldEntries(definition, true).filter(f => f.valueType === "multi-select")) {
      // Reuse the section translator's replacement and typed details; never infer a reverse implication.
      const translated = translateRetiredFindingRead({ resourceType: "Observation", status: "preliminary", code: {},
        component: [{ code: { coding: [{ code: `${field.localCode}::${retiredOption}` }] }, valueBoolean: true }],
      }, stableKey, field, "");
      const options = Array.isArray(translated.value) ? translated.value.filter(o => o !== retiredOption) : [];
      const row = options.length === 1 ? catalog.find(r => r.findingDefinitionKey === stableKey && r.fieldCode === field.localCode && r.optionCode === options[0]) : undefined;
      aliases.set(`${stableKey}::${field.localCode}::${retiredOption}`, { ...(row ? { row } : { reason: "Retired option has no active replacement in the effective definition." }),
        qualifiers: row ? translated.findingDetails[row.optionCode] ?? {} : {} });
    }
  }
  return aliases;
}
