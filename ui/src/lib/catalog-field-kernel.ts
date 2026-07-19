export const CATALOG_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type CatalogWeekday = (typeof CATALOG_WEEKDAYS)[number];
export type CatalogTimeWindow = { start: string; end: string };
export type CatalogWeeklyHours = Partial<Record<CatalogWeekday, CatalogTimeWindow[]>>;
export type CatalogTimeWindowWeekdays = {
  weekdays: CatalogWeekday[];
  start?: string;
  end?: string;
};

type FieldBase = {
  key: string;
  label: string;
  required?: boolean;
};

export type CatalogFieldDefinition =
  | (FieldBase & { type: "text"; unique?: boolean })
  | (FieldBase & { type: "color"; palette: readonly string[] })
  | (FieldBase & { type: "duration" | "number"; min?: number; max?: number; integer?: boolean })
  | (FieldBase & { type: "currency"; min?: number; max?: number })
  | (FieldBase & { type: "select"; options: readonly { value: string; label: string }[] })
  | (FieldBase & { type: "multi-select"; options: readonly { value: string; label: string }[] })
  | (FieldBase & { type: "reference-picker"; valueKind?: "reference" | "text" })
  | (FieldBase & { type: "toggle" })
  | (FieldBase & { type: "weekly-hours" })
  | (FieldBase & { type: "time-window-weekdays" });

export class CatalogFieldValidationError extends Error {
  readonly fieldKey: string;

  constructor(fieldKey: string, message: string) {
    super(message);
    this.name = "CatalogFieldValidationError";
    this.fieldKey = fieldKey;
  }
}

const TIME_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FHIR_REFERENCE = /^[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/;

export function parseCatalogFields(
  item: Record<string, unknown>,
  fields: readonly CatalogFieldDefinition[],
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.key, clone(item[field.key])]));
}

export function buildCatalogFields(
  draft: Record<string, unknown>,
  fields: readonly CatalogFieldDefinition[],
  catalogItems: readonly Record<string, unknown>[] = [],
  currentItemId?: string,
): Record<string, unknown> {
  const built: Record<string, unknown> = {};
  for (const field of fields) {
    built[field.key] = validateField(field, draft[field.key], catalogItems, currentItemId);
  }
  return built;
}

function validateField(
  field: CatalogFieldDefinition,
  value: unknown,
  catalogItems: readonly Record<string, unknown>[],
  currentItemId?: string,
): unknown {
  if (field.required && isEmpty(value)) {
    throw new CatalogFieldValidationError(field.key, `${field.label} is required.`);
  }
  if (!field.required && isEmpty(value)) {
    return value;
  }

  switch (field.type) {
    case "text": {
      if (typeof value !== "string") {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be text.`);
      }
      const trimmed = value.trim();
      if (field.unique) {
        const duplicate = catalogItems.some((item) => {
          const candidate = item[field.key];
          return (
            item.id !== currentItemId &&
            typeof candidate === "string" &&
            candidate.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase()
          );
        });
        if (duplicate) {
          throw new CatalogFieldValidationError(
            field.key,
            `${field.label} must be unique within this catalog.`,
          );
        }
      }
      return trimmed;
    }
    case "color":
      if (typeof value !== "string" || !field.palette.includes(value)) {
        throw new CatalogFieldValidationError(
          field.key,
          `${field.label} must use the constrained catalog palette.`,
        );
      }
      return value;
    case "duration":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be a number.`);
      }
      if ((field.type === "duration" || field.integer) && !Number.isInteger(value)) {
        throw new CatalogFieldValidationError(
          field.key,
          field.type === "duration" ? `${field.label} must be a whole number of minutes.` : `${field.label} must be a whole number.`,
        );
      }
      if (field.min !== undefined && value < field.min) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be at least ${field.min}.`);
      }
      if (field.max !== undefined && value > field.max) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be at most ${field.max}.`);
      }
      return value;
    }
    case "currency": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be a dollar amount with no more than two decimal places.`);
      }
      if (field.min !== undefined && value < field.min) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be at least ${currencyDisplay(field.min)}.`);
      }
      if (field.max !== undefined && value > field.max) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be at most ${currencyDisplay(field.max)}.`);
      }
      return value;
    }
    case "select":
      if (typeof value !== "string" || !field.options.some((option) => option.value === value)) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be a listed option.`);
      }
      return value;
    case "multi-select": {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be a list.`);
      }
      const unique = [...new Set(value)];
      if (unique.some((entry) => !field.options.some((option) => option.value === entry))) {
        throw new CatalogFieldValidationError(field.key, `${field.label} contains an unlisted option.`);
      }
      if (field.required && unique.length === 0) {
        throw new CatalogFieldValidationError(field.key, `${field.label} requires at least one option.`);
      }
      return unique;
    }
    case "reference-picker":
      if (typeof value !== "string") {
        throw new CatalogFieldValidationError(
          field.key,
          field.valueKind === "text" ? `${field.label} must be text.` : `${field.label} must be a FHIR reference.`,
        );
      }
      if (field.valueKind !== "text" && !FHIR_REFERENCE.test(value)) {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be a FHIR reference.`);
      }
      return value.trim();
    case "toggle":
      if (typeof value !== "boolean") {
        throw new CatalogFieldValidationError(field.key, `${field.label} must be on or off.`);
      }
      return value;
    case "weekly-hours":
      return validateWeeklyHours(field, value);
    case "time-window-weekdays":
      return validateTimeWindowWeekdays(field, value);
  }
}

export function centsFromCurrencyInput(input: string): number | undefined {
  const match = input.trim().replace(/^\$/, "").match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) return undefined;
  const total = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(total) ? total : undefined;
}

export function currencyInputFromCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) return "";
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function currencyDisplay(cents: number): string {
  return `$${currencyInputFromCents(cents)}`;
}

function validateWeeklyHours(field: CatalogFieldDefinition, value: unknown): CatalogWeeklyHours {
  if (!isRecord(value)) {
    throw new CatalogFieldValidationError(field.key, `${field.label} must be weekly hours.`);
  }
  const result: CatalogWeeklyHours = {};
  for (const weekday of CATALOG_WEEKDAYS) {
    const windows = value[weekday];
    if (windows === undefined) continue;
    if (!Array.isArray(windows)) {
      throw new CatalogFieldValidationError(field.key, `${field.label} ${weekday} must be time windows.`);
    }
    result[weekday] = windows.map((window) => validateTimeWindow(field, weekday, window));
  }
  return result;
}

function validateTimeWindowWeekdays(
  field: CatalogFieldDefinition,
  value: unknown,
): CatalogTimeWindowWeekdays {
  if (!isRecord(value) || !Array.isArray(value.weekdays)) {
    throw new CatalogFieldValidationError(field.key, `${field.label} must include a weekday set.`);
  }
  const weekdays = value.weekdays.filter(
    (weekday): weekday is CatalogWeekday =>
      typeof weekday === "string" && CATALOG_WEEKDAYS.includes(weekday as CatalogWeekday),
  );
  if (weekdays.length !== value.weekdays.length) {
    throw new CatalogFieldValidationError(field.key, `${field.label} contains an unknown weekday.`);
  }
  if (!value.start && !value.end) {
    return { weekdays };
  }
  const window = validateTimeWindow(field, "", value);
  return { weekdays, ...window };
}

function validateTimeWindow(
  field: CatalogFieldDefinition,
  context: string,
  value: unknown,
): CatalogTimeWindow {
  const prefix = context ? `${field.label} ${context}` : field.label;
  if (!isRecord(value) || typeof value.start !== "string" || typeof value.end !== "string") {
    throw new CatalogFieldValidationError(field.key, `${prefix} must have start and end times.`);
  }
  if (!TIME_HHMM.test(value.start)) {
    throw new CatalogFieldValidationError(
      field.key,
      `${prefix} start must be an HH:MM 24-hour time, got "${value.start}".`,
    );
  }
  if (!TIME_HHMM.test(value.end)) {
    throw new CatalogFieldValidationError(
      field.key,
      `${prefix} end must be an HH:MM 24-hour time, got "${value.end}".`,
    );
  }
  if (value.end <= value.start) {
    throw new CatalogFieldValidationError(
      field.key,
      `${prefix} time window must end after it starts (${value.start}–${value.end}).`,
    );
  }
  return { start: value.start, end: value.end };
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
