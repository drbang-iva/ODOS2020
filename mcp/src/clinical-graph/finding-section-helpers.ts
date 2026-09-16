import type { Observation, ObservationComponent } from "@medplum/fhirtypes";
import { z } from "zod";
import { customFieldEntries, type ClockHourExtentValue, type FindingDetails, type FindingQualifierValue, type QualifierSeed } from "./custom-fields.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";
import { translateRetiredFindingQualifierForRead, translateRetiredFindingRead } from "./finding-read-compatibility.js";

export const negativeActSchema = z.object({
  id: z.string().uuid(),
  definitionStableKey: z.string().min(1).max(200),
  eye: z.enum(["OD", "OS"]),
  optionCodes: z.array(z.string().min(1).max(100)).min(1).max(300),
  exclusions: z.array(z.string().min(1).max(100)).max(300),
  assertedAt: z.string().datetime(),
}).strict().refine((act) => new Set([...act.optionCodes, ...act.exclusions]).size === act.optionCodes.length + act.exclusions.length, {
  message: "Negative scope and exclusions must be unique and disjoint.",
});

export type NegativeAct = z.infer<typeof negativeActSchema> & { actorReference: string };
export const NEGATIVE_ACT_IDENTIFIER_SYSTEM = "urn:odos:negative-act";

export function observationFindingDetails(
  observation: Observation,
  definition: ClinicalFindingDefinition,
  codePrefix: string,
): FindingDetails | undefined {
  const field = customFieldEntries(definition, true).find((candidate) => candidate.valueType === "multi-select");
  if (!field) return undefined;
  const compatibility = translateRetiredFindingRead(
    observation,
    definition.stableKey,
    field,
    codePrefix,
  );
  const findingDetails: FindingDetails = {};
  for (const option of field.options ?? []) {
    const details: Record<string, FindingQualifierValue> = {};
    for (const qualifier of option.qualifiers ?? []) {
      const component = findComponent(
        observation,
        findingDetailComponentCode(codePrefix, field.localCode, option.code, qualifier.key),
      );
      const persistedValue = component ? observationFindingQualifierValue(component, qualifier) : undefined;
      const value = persistedValue === undefined
        ? undefined
        : translateRetiredFindingQualifierForRead(
            definition.stableKey,
            option.code,
            qualifier.key,
            persistedValue,
          );
      if (value !== undefined) details[qualifier.key] = value;
    }
    if (Object.keys(details).length > 0) findingDetails[option.code] = details;
  }
  for (const [findingCode, translated] of Object.entries(compatibility.findingDetails)) {
    findingDetails[findingCode] = {
      ...translated,
      ...findingDetails[findingCode],
    };
  }
  return hasFindingDetails(findingDetails) ? findingDetails : undefined;
}

function observationFindingQualifierValue(
  component: ObservationComponent,
  qualifier: QualifierSeed,
): FindingQualifierValue | undefined {
  if (qualifier.kind === "numeric") {
    const value = component.valueQuantity?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
  if (qualifier.kind === "extent") {
    if (!component.valueString) return undefined;
    try {
      const parsed: unknown = JSON.parse(component.valueString);
      return isClockHourExtent(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return component.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    (component.valueString?.trim() || undefined);
}

export function findingDetailComponentCode(
  codePrefix: string,
  fieldCode: string,
  optionCode: string,
  qualifierKey: string,
): string {
  return `${codePrefix}${fieldCode}::${optionCode}::${qualifierKey}`;
}

function findComponent(observation: Observation, code: string): ObservationComponent | undefined {
  return observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  );
}

export function hasFindingDetails(value: FindingDetails | undefined): value is FindingDetails {
  return value !== undefined && Object.values(value).some((details) => Object.keys(details).length > 0);
}

export function isClockHourExtent(value: unknown): value is ClockHourExtentValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).from === "number" &&
    Number.isFinite((value as Record<string, unknown>).from) &&
    (value as Record<string, number>).from >= 1 &&
    (value as Record<string, number>).from <= 12 &&
    typeof (value as Record<string, unknown>).to === "number" &&
    Number.isFinite((value as Record<string, unknown>).to) &&
    (value as Record<string, number>).to >= 1 &&
    (value as Record<string, number>).to <= 12 &&
    typeof (value as Record<string, unknown>).clockwise === "boolean";
}

export function componentString(observation: Observation, code: string): string | undefined {
  const value = observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  )?.valueString;
  return value?.trim() || undefined;
}

export function observationNegativeAct(observation: Observation): NegativeAct | undefined {
  const stored = componentString(observation, "NEGATIVE_ACT");
  if (stored === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const { actorReference, ...act } = parsed as Record<string, unknown>;
    const validated = negativeActSchema.safeParse(act);
    if (!validated.success || typeof actorReference !== "string" || !actorReference.trim()) throw new Error();
    return { ...validated.data, actorReference };
  } catch {
    throw new Error("Invalid persisted negative act; history cannot safely represent this assertion.");
  }
}
