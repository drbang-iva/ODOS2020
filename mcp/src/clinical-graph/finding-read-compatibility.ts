import type { Observation, ObservationComponent } from "@medplum/fhirtypes";
import {
  observationCustomValue,
  type CustomFieldEntry,
  type FindingDetails,
  type FindingQualifierValue,
} from "./custom-fields.js";

interface RetiredFindingQualifierReadTranslation {
  definitionStableKey: string;
  findingCode: string;
  qualifierKey: string;
  persistedValue: FindingQualifierValue;
}

interface RetiredFindingReadTranslation {
  definitionStableKey: string;
  retiredFindingCode: string;
  replacementFindingCode: string;
  replacementQualifierValues: Readonly<Record<string, FindingQualifierValue>>;
}

const RETIRED_FINDING_QUALIFIER_READ_TRANSLATIONS: readonly RetiredFindingQualifierReadTranslation[] = [{
  definitionStableKey: "ocular-health:anterior:cornea",
  findingCode: "superficial-punctate-keratitis-spk",
  qualifierKey: "grade",
  persistedValue: "Grade 0",
}];

// Read only: remove after a persisted-data census or migration confirms that no live Lens
// brunescent selection components remain.
const RETIRED_FINDING_READ_TRANSLATIONS: readonly RetiredFindingReadTranslation[] = [{
  definitionStableKey: "ocular-health:anterior:lens",
  retiredFindingCode: "brunescent",
  replacementFindingCode: "nuclear-sclerosis",
  replacementQualifierValues: {
    colour: "4+ (dark brown/black; brunescent)",
  },
}, {
  // Read only: the historical chip could mean full-thickness or lamellar, so preserve the finding
  // without asserting its type or a Gass stage. Remove after a persisted-data census or migration
  // confirms that no live Macula macular-hole-full-lamellar selection components remain.
  definitionStableKey: "ocular-health:posterior:macula",
  retiredFindingCode: "macular-hole-full-lamellar",
  replacementFindingCode: "macular-hole",
  replacementQualifierValues: {},
}];

export function translateRetiredFindingRead(
  observation: Observation,
  definitionStableKey: string,
  field: Pick<CustomFieldEntry, "localCode" | "valueType" | "options">,
  codePrefix: string,
): {
  value: ReturnType<typeof observationCustomValue>;
  findingDetails: FindingDetails;
} {
  const persistedValue = observationCustomValue(observation, field, codePrefix);
  if (field.valueType !== "multi-select") return { value: persistedValue, findingDetails: {} };
  let selected = Array.isArray(persistedValue) ? [...persistedValue] : [];
  const findingDetails: FindingDetails = {};
  for (const translation of RETIRED_FINDING_READ_TRANSLATIONS) {
    if (
      translation.definitionStableKey !== definitionStableKey ||
      !observationSelectsFinding(observation, field.localCode, codePrefix, translation.retiredFindingCode)
    ) continue;
    const replacement = field.options?.find((option) =>
      option.code === translation.replacementFindingCode && option.active
    );
    if (!replacement) continue;
    selected = selected.filter((code) => code !== translation.retiredFindingCode);
    if (!selected.includes(replacement.code)) selected.push(replacement.code);
    const qualifierKeys = new Set((replacement.qualifiers ?? []).map((qualifier) => qualifier.key));
    const qualifierValues = Object.fromEntries(
      Object.entries(translation.replacementQualifierValues)
        .filter(([qualifierKey]) => qualifierKeys.has(qualifierKey)),
    );
    if (Object.keys(qualifierValues).length > 0) findingDetails[replacement.code] = qualifierValues;
  }
  return {
    value: selected.length > 0 ? selected : undefined,
    findingDetails,
  };
}

export function translateRetiredFindingQualifierForRead(
  definitionStableKey: string,
  findingCode: string,
  qualifierKey: string,
  persistedValue: FindingQualifierValue,
): FindingQualifierValue | undefined {
  // A selected SPK chip records a deliberate abnormal finding, while Grade 0 records absence.
  // Hydration keeps the chip and drops only that contradictory retired rung; the Observation stays
  // untouched. Remove this entry after a persisted-data census or migration confirms that no live
  // SPK Grade 0 qualifier components remain.
  const retired = RETIRED_FINDING_QUALIFIER_READ_TRANSLATIONS.some((translation) =>
    translation.definitionStableKey === definitionStableKey &&
    translation.findingCode === findingCode &&
    translation.qualifierKey === qualifierKey &&
    translation.persistedValue === persistedValue
  );
  return retired ? undefined : persistedValue;
}

function observationSelectsFinding(
  observation: Observation,
  fieldCode: string,
  codePrefix: string,
  findingCode: string,
): boolean {
  return findComponent(observation, `${codePrefix}${fieldCode}::${findingCode}`)?.valueBoolean === true ||
    findComponent(observation, `${codePrefix}${findingCode}`)?.valueBoolean === true;
}

function findComponent(observation: Observation, code: string): ObservationComponent | undefined {
  return observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  );
}
