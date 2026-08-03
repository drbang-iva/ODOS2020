import { randomUUID } from "node:crypto";
import type { Observation, ObservationComponent } from "@medplum/fhirtypes";
import { z } from "zod";
import {
  UCUM_CODE_SYSTEM,
  UCUM_UNIT_CODES,
  type UcumUnitCode,
} from "../fhir/contactLens.js";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import type {
  ClinicalFindingDefinition,
  ClinicalGraphProvenance,
  FindingValue,
} from "./glaucoma-suspect.js";

export const CUSTOM_FIELD_VALUE_TYPES = ["number", "select", "multi-select", "string"] as const;
export type CustomFieldValueType = typeof CUSTOM_FIELD_VALUE_TYPES[number];

export type QualifierSeed =
  | {
      kind: "graded";
      key: string;
      display: string;
      options: string[];
      scheme?: string;
    }
  | {
      kind: "enum";
      key: string;
      display: string;
      options: Array<{ code: string; display: string }>;
    }
  | {
      kind: "numeric";
      key: string;
      display: string;
      min: number;
      max: number;
      step: number;
      unit?: string;
    }
  | { kind: "extent"; key: string; display: string };

export interface ClockHourExtentValue {
  from: number;
  to: number;
  clockwise: boolean;
}

export type FindingQualifierValue = number | string | ClockHourExtentValue;
export type FindingDetails = Record<string, Record<string, FindingQualifierValue>>;

const qualifierSeedSchema: z.ZodType<QualifierSeed> = z.union([
  z.object({
    kind: z.literal("graded"),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    display: z.string().trim().min(1).max(120),
    options: z.array(z.string().trim().min(1).max(100)).min(1).max(100)
      .refine((options) => new Set(options).size === options.length, "Graded qualifier options must be unique."),
    scheme: z.string().trim().min(1).max(120).optional(),
  }).strict(),
  z.object({
    kind: z.literal("enum"),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    display: z.string().trim().min(1).max(120),
    options: z.array(z.object({
      code: z.string().trim().min(1).max(100),
      display: z.string().trim().min(1).max(120),
    }).strict()).min(1).max(100)
      .refine((options) => new Set(options.map((option) => option.code)).size === options.length, "Enum qualifier option codes must be unique."),
  }).strict(),
  z.object({
    kind: z.literal("numeric"),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    display: z.string().trim().min(1).max(120),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().positive().finite(),
    unit: z.string().trim().min(1).max(40).optional(),
  }).strict().refine((qualifier) => qualifier.min <= qualifier.max, "Qualifier minimum cannot exceed maximum."),
  z.object({
    kind: z.literal("extent"),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    display: z.string().trim().min(1).max(120),
  }).strict(),
]);

const qualifierSeedsSchema = z.array(qualifierSeedSchema).min(1).max(100)
  .refine((qualifiers) => new Set(qualifiers.map((qualifier) => qualifier.key)).size === qualifiers.length, "Qualifier keys must be unique per finding.");

export interface CustomFieldEntry {
  localCode: string;
  display: string;
  origin: "practice";
  valueType: CustomFieldValueType;
  unit?: UcumUnitCode;
  min?: number;
  max?: number;
  step?: number;
  inputControl?: "date" | "toggle";
  defaultValue?: number | string;
  options?: Array<{
    code: string;
    display: string;
    active: boolean;
    parentCode?: string;
    priority?: boolean;
    qualifiers?: QualifierSeed[];
  }>;
  order: number;
  active: boolean;
}

export interface CustomFieldValue {
  code: string;
  value: number | string | string[];
}

export const customFieldValueSchema = z.object({
  code: z.string().trim().min(1).max(100),
  value: z.union([
    z.number(),
    z.string().trim().min(1).max(200),
    z.array(z.string().trim().min(1).max(100)).max(100),
  ]),
}).strict();

export const customFieldOptionInputSchema = z.object({
  code: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  display: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
  parentCode: z.string().trim().min(1).max(100).optional(),
  priority: z.boolean().optional(),
  qualifiers: qualifierSeedsSchema.optional(),
}).strict();

export const createCustomFieldInputSchema = z.object({
  display: z.string().trim().min(1).max(120),
  valueType: z.enum(CUSTOM_FIELD_VALUE_TYPES),
  unit: z.enum(UCUM_UNIT_CODES).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  options: z.array(customFieldOptionInputSchema).min(1).max(100).optional(),
  order: z.number().int().min(0).optional(),
}).strict();

export const updateCustomFieldInputSchema = z.object({
  display: z.string().trim().min(1).max(120).optional(),
  unit: z.enum(UCUM_UNIT_CODES).nullable().optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  step: z.number().positive().nullable().optional(),
  options: z.array(customFieldOptionInputSchema).min(1).max(100).optional(),
  order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
}).strict();

export function customFieldEntries(
  definition: ClinicalFindingDefinition,
  includeInactive = false,
): CustomFieldEntry[] {
  const fields = asRecord(definition.valueSchema.fields);
  return Object.values(fields)
    .flatMap((raw) => {
      const row = asRecord(raw);
      if (row.origin !== "practice") return [];
      const parsed = parseCustomField(row);
      return parsed && (includeInactive || parsed.active) ? [parsed] : [];
    })
    .sort((left, right) => left.order - right.order || left.localCode.localeCompare(right.localCode));
}

export function createCustomField(
  definition: ClinicalFindingDefinition,
  input: z.infer<typeof createCustomFieldInputSchema>,
  provenance: ClinicalGraphProvenance,
  shortId = () => randomUUID().replaceAll("-", "").slice(0, 8),
): { definition: ClinicalFindingDefinition; field: CustomFieldEntry } {
  assertCustomFieldShape(input);
  const localCode = `CUSTOM_${slugify(input.display)}_${shortId()}`;
  const fields = asRecord(definition.valueSchema.fields);
  if (fields[localCode]) throw new Error(`Custom field code collision: ${localCode}.`);
  const existing = customFieldEntries(definition, true);
  const field: CustomFieldEntry = {
    localCode,
    display: input.display,
    origin: "practice",
    valueType: input.valueType,
    ...(input.unit ? { unit: input.unit } : {}),
    ...(input.min !== undefined ? { min: input.min } : {}),
    ...(input.max !== undefined ? { max: input.max } : {}),
    ...(input.step !== undefined ? { step: input.step } : {}),
    ...(input.options ? { options: input.options } : {}),
    order: input.order ?? (Math.max(-1, ...existing.map((candidate) => candidate.order)) + 1),
    active: true,
  };
  return {
    field,
    definition: withFields(definition, { ...fields, [localCode]: field }, provenance),
  };
}

export function updateCustomField(
  definition: ClinicalFindingDefinition,
  localCode: string,
  input: z.infer<typeof updateCustomFieldInputSchema>,
  provenance: ClinicalGraphProvenance,
): { definition: ClinicalFindingDefinition; field: CustomFieldEntry } {
  const fields = asRecord(definition.valueSchema.fields);
  const current = customFieldEntries(definition, true).find((field) => field.localCode === localCode);
  if (!current) throw new Error(`Custom field ${localCode} does not exist.`);
  let candidate = {
    ...current,
    ...(input.display !== undefined ? { display: input.display } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
  } as CustomFieldEntry;
  if ((current.valueType === "select" || current.valueType === "multi-select") && input.options) {
    const nextCodes = new Set(input.options.map((option) => option.code));
    const removed = current.options?.find((option) => !nextCodes.has(option.code));
    if (removed) {
      throw new Error(`Select option ${removed.code} must be deactivated instead of removed or recoded.`);
    }
  }
  for (const key of ["unit", "min", "max", "step"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value === null) delete candidate[key];
    else Object.assign(candidate, { [key]: value });
  }
  assertCustomFieldShape(candidate);
  let nextFields = { ...fields, [localCode]: candidate };
  if (input.active === false) {
    const picker = asRecord(nextFields.additionalFields);
    if (picker.type === "visible-hidden-field-picker") {
      nextFields = {
        ...nextFields,
        additionalFields: {
          ...picker,
          visibleCodes: readStringArray(picker.visibleCodes).filter((code) => code !== localCode),
        },
      };
    }
  }
  if (input.order !== undefined) {
    const ordered = customFieldEntries({
      ...definition,
      valueSchema: { ...definition.valueSchema, fields: nextFields },
    }, true).filter((field) => field.localCode !== localCode);
    ordered.splice(Math.min(input.order, ordered.length), 0, candidate);
    nextFields = ordered.reduce<Record<string, unknown>>(
      (result, field, order) => ({
        ...result,
        [field.localCode]: { ...field, order },
      }),
      { ...nextFields },
    );
    candidate = nextFields[localCode] as CustomFieldEntry;
  }
  return {
    field: candidate,
    definition: withFields(definition, nextFields, provenance),
  };
}

export function updatePickerConfiguration(
  definition: ClinicalFindingDefinition,
  input: { visibleCodes?: string[]; allowCreate?: boolean },
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  const fields = asRecord(definition.valueSchema.fields);
  const picker = asRecord(fields.additionalFields);
  if (picker.type !== "visible-hidden-field-picker") {
    throw new Error(`Finding definition ${definition.stableKey} does not have an additional-fields picker.`);
  }
  const allowedCodes = new Set([
    ...readSeedPickerOptions(definition, false).map((option) => option.code),
    ...customFieldEntries(definition, false).map((field) => field.localCode),
  ]);
  const visibleCodes = input.visibleCodes ?? readStringArray(picker.visibleCodes);
  if (new Set(visibleCodes).size !== visibleCodes.length) {
    throw new Error("Picker visibleCodes cannot contain duplicates.");
  }
  const unknown = visibleCodes.find((code) => !allowedCodes.has(code));
  if (unknown) throw new Error(`Picker visibleCodes contains an unknown or inactive field: ${unknown}.`);
  return withFields(definition, {
    ...fields,
    additionalFields: {
      ...picker,
      visibleCodes,
      ...(input.allowCreate !== undefined ? { allowCreate: input.allowCreate } : {}),
    },
  }, provenance);
}

export function pickerAllowsCreate(definition: ClinicalFindingDefinition): boolean {
  const picker = asRecord(asRecord(definition.valueSchema.fields).additionalFields);
  return picker.type === "visible-hidden-field-picker" && picker.allowCreate === true;
}

export function pickerFieldOptions(
  definition: ClinicalFindingDefinition,
  includeInactive = false,
): Array<{
  code: string;
  localCode: string;
  display: string;
  active: boolean;
  unit?: UcumUnitCode;
  parameterCode?: string;
  valueType: CustomFieldValueType;
  options?: CustomFieldEntry["options"];
  origin?: "practice";
  order: number;
}> {
  const seeds = readSeedPickerOptions(definition, includeInactive).map((option, index) => ({
    ...option,
    valueType: "number" as const,
    order: index,
  }));
  const custom = customFieldEntries(definition, includeInactive).map((field) => ({
    code: field.localCode,
    localCode: field.localCode,
    display: field.display,
    active: field.active,
    valueType: field.valueType,
    ...(field.unit ? { unit: field.unit } : {}),
    ...(field.options ? { options: field.options } : {}),
    origin: field.origin,
    order: field.order,
  }));
  return [...seeds, ...custom];
}

export function validateCustomFieldValues(
  values: readonly CustomFieldValue[],
  definition: ClinicalFindingDefinition,
  label: string,
): string | undefined {
  const fields = new Map(customFieldEntries(definition, false).map((field) => [field.localCode, field]));
  const knownIncludingInactive = new Map(customFieldEntries(definition, true).map((field) => [field.localCode, field]));
  const seen = new Set<string>();
  for (const item of values) {
    if (seen.has(item.code)) return `${label} custom field ${item.code} was supplied more than once.`;
    seen.add(item.code);
    const field = fields.get(item.code);
    if (!field) {
      return knownIncludingInactive.has(item.code)
        ? `${label} custom field is inactive: ${item.code}.`
        : `${label} custom field contains an unknown code: ${item.code}.`;
    }
    if (field.valueType === "number") {
      if (typeof item.value !== "number" || !Number.isFinite(item.value)) {
        return `${label} custom field ${item.code} requires a number.`;
      }
      if (field.min !== undefined && item.value < field.min) {
        return `${label} custom field ${item.code} must be at least ${field.min}.`;
      }
      if (field.max !== undefined && item.value > field.max) {
        return `${label} custom field ${item.code} must be at most ${field.max}.`;
      }
      if (field.step !== undefined) {
        const base = field.min ?? 0;
        const steps = (item.value - base) / field.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) {
          return `${label} custom field ${item.code} must use ${field.step} increments.`;
        }
      }
    } else if (field.valueType === "select") {
      if (typeof item.value !== "string") return `${label} custom field ${item.code} requires an option code.`;
      const option = field.options?.find((candidate) => candidate.code === item.value);
      if (!option || !option.active) {
        return `${label} custom field ${item.code} contains an unknown or inactive option: ${item.value}.`;
      }
    } else if (field.valueType === "multi-select") {
      if (!Array.isArray(item.value)) return `${label} custom field ${item.code} requires an array of option codes.`;
      const selected = item.value;
      if (new Set(selected).size !== selected.length) {
        return `${label} custom field ${item.code} contains duplicate option codes.`;
      }
      const unknown = selected.find((code) => {
        const option = field.options?.find((candidate) => candidate.code === code);
        return !option || !option.active;
      });
      if (unknown) {
        return `${label} custom field ${item.code} contains an unknown or inactive option: ${unknown}.`;
      }
      const orphan = selected.find((code) => {
        const option = field.options?.find((candidate) => candidate.code === code);
        return option?.parentCode && !selected.includes(option.parentCode);
      });
      if (orphan) {
        return `${label} custom field ${item.code} sub-option requires its parent selection: ${orphan}.`;
      }
    } else if (typeof item.value !== "string") {
      return `${label} custom field ${item.code} requires text.`;
    }
  }
  return undefined;
}

export function customFieldComponents(
  values: readonly CustomFieldValue[],
  definition: ClinicalFindingDefinition,
  codePrefix = "",
): Extract<FindingValue, { type: "components" }>["components"] {
  const fields = new Map(customFieldEntries(definition, true).map((field) => [field.localCode, field]));
  const components: Extract<FindingValue, { type: "components" }>["components"] = [];
  for (const item of values) {
    const field = fields.get(item.code);
    if (!field) continue;
    if (field.valueType === "multi-select" && Array.isArray(item.value)) {
      for (const code of item.value) {
        const option = field.options?.find((candidate) => candidate.code === code);
        if (option) components.push({
          code: `${codePrefix}${field.localCode}::${option.code}`,
          display: option.display,
          value: true,
        });
      }
      continue;
    }
    components.push({
      code: `${codePrefix}${field.localCode}`,
      display: field.display,
      value: item.value as number | string,
      ...(field.valueType === "number" && field.unit
        ? { unit: field.unit, system: UCUM_CODE_SYSTEM, unitCode: field.unit }
        : {}),
    });
  }
  return components;
}

export function codeCustomFieldComponents(
  observation: Observation,
  definition: ClinicalFindingDefinition,
  codePrefix = "",
): Observation {
  const fields = new Map(customFieldEntries(definition, true).map((field) => [field.localCode, field]));
  return {
    ...observation,
    component: observation.component?.map((component) => {
      const code = component.code.coding?.find((coding) => coding.code)?.code;
      const localCode = code?.startsWith(codePrefix) ? code.slice(codePrefix.length) : undefined;
      const field = localCode ? fields.get(localCode) : undefined;
    if (!field || field.valueType !== "select" || typeof component.valueString !== "string") return component;
      const option = field.options?.find((candidate) => candidate.code === component.valueString);
      if (!option) return component;
      const { valueString: _valueString, ...rest } = component;
      return { ...rest, valueCodeableConcept: odosConcept(option.code, option.display) };
    }),
  };
}

export function appendCustomFieldComponentsToObservation(
  observation: Observation,
  values: readonly CustomFieldValue[],
  definition: ClinicalFindingDefinition,
  codePrefix = "",
): Observation {
  const additions: ObservationComponent[] = customFieldComponents(values, definition, codePrefix)
    .map((item) => ({
      code: odosConcept(item.code, item.display),
      ...(typeof item.value === "number"
        ? {
            valueQuantity: {
              value: item.value,
              ...(item.unit ? { unit: item.unit } : {}),
              ...(item.system ? { system: item.system } : {}),
              ...(item.unitCode ? { code: item.unitCode } : {}),
            },
          }
        : typeof item.value === "string"
          ? { valueString: item.value }
          : { valueBoolean: item.value }),
    }));
  return codeCustomFieldComponents({
    ...observation,
    component: [...(observation.component ?? []), ...additions],
  }, definition, codePrefix);
}

export function observationCustomValue(
  observation: Observation,
  field: Pick<CustomFieldEntry, "localCode" | "valueType" | "options">,
  codePrefix = "",
): number | string | string[] | undefined {
  if (field.valueType === "multi-select") {
    const selected = (field.options ?? []).filter((option) =>
      findComponent(observation, `${codePrefix}${field.localCode}::${option.code}`)?.valueBoolean === true ||
      findComponent(observation, `${codePrefix}${option.code}`)?.valueBoolean === true
    ).map((option) => option.code);
    return selected.length > 0 ? selected : undefined;
  }
  const matched = findComponent(observation, `${codePrefix}${field.localCode}`);
  if (!matched) return undefined;
  if (field.valueType === "number") {
    const value = matched.valueQuantity?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
  if (field.valueType === "string") return matched.valueString?.trim() || undefined;
  const coding = matched.valueCodeableConcept?.coding?.find((candidate) => candidate.code);
  const code = coding?.code ?? matched.valueString;
  if (!code) return undefined;
  return field.options?.find((option) => option.code === code)?.display ?? coding?.display ?? code;
}

function parseCustomField(row: Record<string, unknown>): CustomFieldEntry | undefined {
  if (
    typeof row.localCode !== "string" || !row.localCode.startsWith("CUSTOM_") ||
    typeof row.display !== "string" || row.origin !== "practice" ||
    !CUSTOM_FIELD_VALUE_TYPES.includes(row.valueType as CustomFieldValueType) ||
    typeof row.order !== "number" || !Number.isInteger(row.order) || row.order < 0 ||
    typeof row.active !== "boolean"
  ) return undefined;
  const valueType = row.valueType as CustomFieldValueType;
  const options = readCustomOptions(row.options);
  if ((valueType === "select" || valueType === "multi-select") && !options) return undefined;
  if (row.unit !== undefined && !UCUM_UNIT_CODES.includes(row.unit as UcumUnitCode)) return undefined;
  return {
    localCode: row.localCode,
    display: row.display,
    origin: "practice",
    valueType,
    ...(row.unit ? { unit: row.unit as UcumUnitCode } : {}),
    ...(readFiniteNumber(row.min) !== undefined ? { min: readFiniteNumber(row.min) } : {}),
    ...(readFiniteNumber(row.max) !== undefined ? { max: readFiniteNumber(row.max) } : {}),
    ...(readFiniteNumber(row.step) !== undefined ? { step: readFiniteNumber(row.step) } : {}),
    ...(row.inputControl === "date" || row.inputControl === "toggle"
      ? { inputControl: row.inputControl }
      : {}),
    ...(typeof row.defaultValue === "number" || typeof row.defaultValue === "string"
      ? { defaultValue: row.defaultValue }
      : {}),
    ...(options ? { options } : {}),
    order: row.order,
    active: row.active,
  };
}

function assertCustomFieldShape(input: {
  valueType: CustomFieldValueType;
  unit?: UcumUnitCode;
  min?: number;
  max?: number;
  step?: number;
  options?: CustomFieldEntry["options"];
}): void {
  if (input.valueType === "number" && input.options !== undefined) {
    throw new Error("Number custom fields cannot define select options.");
  }
  if (input.valueType === "select" || input.valueType === "multi-select") {
    if (input.unit !== undefined || input.min !== undefined || input.max !== undefined || input.step !== undefined) {
      throw new Error("Select custom fields cannot define numeric constraints.");
    }
    if (!input.options?.length) throw new Error("Select custom fields require at least one option.");
    const codes = input.options.map((option) => option.code);
    if (new Set(codes).size !== codes.length) throw new Error("Select custom-field option codes must be unique.");
    const codeSet = new Set(codes);
    const invalidParent = input.options.find((option) => option.parentCode && !codeSet.has(option.parentCode));
    if (invalidParent) throw new Error(`Select option ${invalidParent.code} has an unknown parent code.`);
  }
  if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
    throw new Error("Custom field minimum cannot exceed maximum.");
  }
}

function withFields(
  definition: ClinicalFindingDefinition,
  fields: Record<string, unknown>,
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  return {
    ...definition,
    valueSchema: { ...definition.valueSchema, fields },
    provenance,
  };
}

function readSeedPickerOptions(definition: ClinicalFindingDefinition, includeInactive: boolean) {
  const picker = asRecord(asRecord(definition.valueSchema.fields).additionalFields);
  if (!Array.isArray(picker.options)) return [];
  return picker.options.flatMap((raw) => {
    const row = asRecord(raw);
    if (
      typeof row.code !== "string" || typeof row.localCode !== "string" ||
      typeof row.display !== "string" || typeof row.unit !== "string" ||
      !UCUM_UNIT_CODES.includes(row.unit as UcumUnitCode) ||
      (!includeInactive && row.active === false)
    ) return [];
    return [{
      code: row.code,
      localCode: row.localCode,
      display: row.display,
      active: row.active !== false,
      unit: row.unit as UcumUnitCode,
      ...(typeof row.parameterCode === "string" ? { parameterCode: row.parameterCode } : {}),
    }];
  });
}

function readCustomOptions(value: unknown): CustomFieldEntry["options"] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const options = value.flatMap((raw) => {
    const row = asRecord(raw);
    const qualifiers = row.qualifiers === undefined ? undefined : readQualifierSeeds(row.qualifiers);
    return typeof row.code === "string" && typeof row.display === "string" && typeof row.active === "boolean"
      && (row.qualifiers === undefined || qualifiers !== undefined)
      ? [{
          code: row.code,
          display: row.display,
          active: row.active,
          ...(typeof row.parentCode === "string" ? { parentCode: row.parentCode } : {}),
          ...(typeof row.priority === "boolean" ? { priority: row.priority } : {}),
          ...(qualifiers ? { qualifiers } : {}),
        }]
      : [];
  });
  return options.length === value.length ? options : undefined;
}

function readQualifierSeeds(value: unknown): QualifierSeed[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const qualifiers = value.flatMap((raw): QualifierSeed[] => {
    const row = asRecord(raw);
    if (
      typeof row.key !== "string" || typeof row.display !== "string" ||
      !isSlug(row.key)
    ) return [];
    if (row.kind === "graded") {
      if (
        !isStringArray(row.options) || row.options.length === 0 ||
        row.options.some((option) => option.length === 0) ||
        new Set(row.options).size !== row.options.length
      ) return [];
      if (row.scheme !== undefined && typeof row.scheme !== "string") return [];
      return [{
        kind: "graded",
        key: row.key,
        display: row.display,
        options: row.options,
        ...(typeof row.scheme === "string" ? { scheme: row.scheme } : {}),
      }];
    }
    if (row.kind === "enum") {
      if (!Array.isArray(row.options) || row.options.length === 0) return [];
      const options = row.options.flatMap((rawOption) => {
        const option = asRecord(rawOption);
        return typeof option.code === "string" && typeof option.display === "string"
          ? [{ code: option.code, display: option.display }]
          : [];
      });
      return options.length === row.options.length &&
          new Set(options.map((option) => option.code)).size === options.length
        ? [{ kind: "enum", key: row.key, display: row.display, options }]
        : [];
    }
    if (row.kind === "numeric") {
      const min = readFiniteNumber(row.min);
      const max = readFiniteNumber(row.max);
      const step = readFiniteNumber(row.step);
      if (
        min === undefined || max === undefined || step === undefined ||
        min > max || step <= 0 ||
        (row.unit !== undefined && typeof row.unit !== "string")
      ) return [];
      return [{
        kind: "numeric",
        key: row.key,
        display: row.display,
        min,
        max,
        step,
        ...(typeof row.unit === "string" ? { unit: row.unit } : {}),
      }];
    }
    return row.kind === "extent"
      ? [{ kind: "extent", key: row.key, display: row.display }]
      : [];
  });
  return qualifiers.length === value.length &&
      new Set(qualifiers.map((qualifier) => qualifier.key)).size === qualifiers.length
    ? qualifiers
    : undefined;
}

function findComponent(observation: Observation, code: string): ObservationComponent | undefined {
  return observation.component?.find((candidate) => candidate.code.coding?.some((coding) => coding.code === code));
}

function slugify(display: string): string {
  const slug = display.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return (slug || "FIELD").slice(0, 48);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
