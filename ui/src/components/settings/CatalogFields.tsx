import { useEffect, useState } from "react";
import {
  CATALOG_WEEKDAYS,
  type CatalogFieldDefinition,
  type CatalogTimeWindowWeekdays,
  type CatalogWeekday,
  type CatalogWeeklyHours,
} from "../../lib/catalog-field-kernel";
import { nextAvailableHoursWindow } from "../../lib/scheduling-settings";
import { DISCIPLINE_COLOR_BANDS } from "../../lib/scheduling";
import { RequiredFieldLabel } from "./RequiredGate";

export const CATALOG_COLOR_PALETTE = [
  ...new Set(Object.values(DISCIPLINE_COLOR_BANDS).flat()),
] as readonly string[];

export type ReferencePickerOption = {
  reference: string;
  display: string;
};

export type CatalogFieldDescriptor = CatalogFieldDefinition & {
  search?: (query: string) => Promise<ReferencePickerOption[]>;
};

const WEEKDAY_DISPLAY: Record<CatalogWeekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export function CatalogFieldKit({
  fields,
  values,
  errors = {},
  fieldId,
  showRequired = false,
  onChange,
}: {
  fields: readonly CatalogFieldDescriptor[];
  values: Record<string, unknown>;
  errors?: Record<string, string>;
  fieldId?: (key: string) => string;
  showRequired?: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="grid gap-4">
      {fields.map((field) => (
        <CatalogFieldControl
          key={field.key}
          field={field}
          value={values[field.key]}
          error={errors[field.key]}
          inputId={fieldId?.(field.key)}
          showRequired={showRequired}
          onChange={(value) => onChange(field.key, value)}
        />
      ))}
    </div>
  );
}

function CatalogFieldControl({
  field,
  value,
  error,
  inputId,
  showRequired,
  onChange,
}: {
  field: CatalogFieldDescriptor;
  value: unknown;
  error?: string;
  inputId?: string;
  showRequired: boolean;
  onChange: (value: unknown) => void;
}) {
  const errorId = `${field.key}-error`;
  const describedBy = error ? errorId : undefined;

  switch (field.type) {
    case "text":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <input
            id={inputId}
            className="scheduler-input"
            value={typeof value === "string" ? value : ""}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        </FieldFrame>
      );
    case "color":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <div id={inputId} tabIndex={-1} className="flex flex-wrap gap-2" role="radiogroup" aria-label={field.label}>
            {field.palette.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-label={color}
                aria-checked={value === color}
                className={`h-8 w-8 rounded-full border-2 ${
                  value === color ? "border-white" : "border-white/20"
                }`}
                style={{ backgroundColor: color }}
                onClick={() => onChange(color)}
              />
            ))}
          </div>
        </FieldFrame>
      );
    case "duration":
    case "number":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <input
            id={inputId}
            className="scheduler-input"
            type="number"
            min={field.min}
            max={field.max}
            step={field.type === "duration" || field.integer ? 1 : undefined}
            value={typeof value === "number" ? value : ""}
            aria-describedby={describedBy}
            onChange={(event) =>
              onChange(event.target.value === "" ? undefined : Number(event.target.value))
            }
          />
        </FieldFrame>
      );
    case "select":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <select
            id={inputId}
            className="scheduler-input"
            value={typeof value === "string" ? value : ""}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Select…</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FieldFrame>
      );
    case "multi-select": {
      const selected = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <div id={inputId} className="grid gap-2 rounded border border-white/10 bg-black/20 p-3" aria-describedby={describedBy}>
            {field.options.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm text-white/75">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={(event) => onChange(event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((entry) => entry !== option.value))}
                />
                {option.label}
              </label>
            ))}
          </div>
        </FieldFrame>
      );
    }
    case "reference-picker":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <ReferencePicker
            label={field.label}
            value={typeof value === "string" ? value : ""}
            valueKind={field.valueKind ?? "reference"}
            search={field.search}
            describedBy={describedBy}
            inputId={inputId}
            onChange={onChange}
          />
        </FieldFrame>
      );
    case "toggle":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired} hideLabel>
          <label className="flex items-center gap-2 text-sm text-white/75">
            <input
              id={inputId}
              type="checkbox"
              checked={value === true}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.checked)}
            />
            <span>
              <RequiredFieldLabel required={showRequired && field.required}>{field.label}</RequiredFieldLabel>
            </span>
          </label>
        </FieldFrame>
      );
    case "weekly-hours":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <div id={inputId} tabIndex={-1}>
            <WeeklyHoursEditor
              hours={isWeeklyHours(value) ? value : {}}
              onChange={onChange}
            />
          </div>
        </FieldFrame>
      );
    case "time-window-weekdays":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <div id={inputId} tabIndex={-1}>
            <TimeWindowWeekdayField
              value={isTimeWindowWeekdays(value) ? value : { weekdays: [] }}
              onChange={onChange}
            />
          </div>
        </FieldFrame>
      );
  }
}

function FieldFrame({
  field,
  error,
  showRequired,
  hideLabel = false,
  children,
}: {
  field: CatalogFieldDescriptor;
  error?: string;
  showRequired: boolean;
  hideLabel?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      {!hideLabel && (
        <div className="text-sm font-medium text-white/75">
          <RequiredFieldLabel required={showRequired && field.required}>{field.label}</RequiredFieldLabel>
        </div>
      )}
      {children}
      {error && (
        <div id={`${field.key}-error`} className="text-sm text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}

function ReferencePicker({
  label,
  value,
  valueKind,
  search,
  describedBy,
  inputId,
  onChange,
}: {
  label: string;
  value: string;
  valueKind: "reference" | "text";
  search?: (query: string) => Promise<ReferencePickerOption[]>;
  describedBy?: string;
  inputId?: string;
  onChange: (value: unknown) => void;
}) {
  const [query, setQuery] = useState(value);
  const [options, setOptions] = useState<ReferencePickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!search || query.trim().length < 2 || query === value) {
      setOptions([]);
      setLoading(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      void search(query)
        .then((next) => {
          if (!cancelled) {
            setOptions(next);
            setSearchError(null);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setOptions([]);
            setSearchError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, search, value]);

  return (
    <div className="grid gap-2">
      <input
        id={inputId}
        className="scheduler-input"
        value={query}
        placeholder={`Search ${label.toLocaleLowerCase()}…`}
        aria-describedby={describedBy}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loading && <div className="text-xs text-white/45">Searching…</div>}
      {searchError && <div className="text-sm text-red-200">{searchError}</div>}
      {options.length > 0 && (
        <div className="border border-white/10 bg-[#10111c]">
          {options.map((option) => (
            <button
              key={option.reference}
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-white/75 hover:bg-white/10"
              onClick={() => {
                onChange(option.reference);
                setQuery(option.reference);
                setOptions([]);
              }}
            >
              {option.display}
            </button>
          ))}
        </div>
      )}
      {value && (
        <div className="text-xs text-white/45">
          Stored {valueKind === "text" ? "value" : "reference"}: {value}
        </div>
      )}
    </div>
  );
}

export function WeeklyHoursEditor({
  hours,
  onChange,
}: {
  hours: CatalogWeeklyHours;
  onChange: (hours: CatalogWeeklyHours) => void;
}) {
  function updateDay(day: CatalogWeekday, windows: Array<{ start: string; end: string }>) {
    onChange({ ...hours, [day]: windows });
  }

  return (
    <div className="grid gap-2">
      {CATALOG_WEEKDAYS.map((day) => {
        const windows = hours[day] ?? [];
        const closed = windows.length === 0;
        return (
          <div key={day} className="grid gap-2 border border-white/10 bg-white/[0.03] p-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-10 text-sm font-semibold text-white/75">{WEEKDAY_DISPLAY[day]}</div>
              <label className="flex items-center gap-2 text-sm text-white/70">
                <input
                  type="checkbox"
                  checked={closed}
                  onChange={(event) =>
                    updateDay(day, event.target.checked ? [] : [{ start: "09:00", end: "17:00" }])
                  }
                />
                <span>Closed</span>
              </label>
              {!closed && (
                <button
                  className="scheduler-button"
                  type="button"
                  disabled={!nextAvailableHoursWindow(windows)}
                  onClick={() => {
                    const next = nextAvailableHoursWindow(windows);
                    if (next) updateDay(day, [...windows, next]);
                  }}
                >
                  Add Window
                </button>
              )}
            </div>
            {!closed &&
              windows.map((window, index) => (
                <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input
                    className="scheduler-input"
                    type="time"
                    value={window.start}
                    onChange={(event) =>
                      updateDay(
                        day,
                        windows.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, start: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                  />
                  <input
                    className="scheduler-input"
                    type="time"
                    value={window.end}
                    onChange={(event) =>
                      updateDay(
                        day,
                        windows.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, end: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                  />
                  <button
                    className="scheduler-button"
                    type="button"
                    onClick={() =>
                      updateDay(day, windows.filter((_, candidateIndex) => candidateIndex !== index))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

export function TimeWindowWeekdayField({
  value,
  onChange,
}: {
  value: CatalogTimeWindowWeekdays;
  onChange: (value: CatalogTimeWindowWeekdays) => void;
}) {
  const allDay = !value.start && !value.end;
  return (
    <div className="grid gap-3">
      <fieldset className="border border-white/10 p-2">
        <legend className="px-1 text-xs uppercase text-white/45">Weekdays</legend>
        <div className="flex flex-wrap gap-3">
          {CATALOG_WEEKDAYS.map((weekday) => (
            <label key={weekday} className="flex items-center gap-1 text-sm text-white/75">
              <input
                type="checkbox"
                checked={value.weekdays.includes(weekday)}
                onChange={(event) => {
                  const weekdays = new Set(value.weekdays);
                  if (event.target.checked) weekdays.add(weekday);
                  else weekdays.delete(weekday);
                  onChange({ ...value, weekdays: [...weekdays] });
                }}
              />
              <span>{WEEKDAY_DISPLAY[weekday]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-white/75">
        <input
          type="checkbox"
          checked={allDay}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { weekdays: value.weekdays }
                : { ...value, start: "09:00", end: "17:00" },
            )
          }
        />
        <span>All Day</span>
      </label>
      {!allDay && (
        <div className="grid gap-2 md:grid-cols-2">
          <label className="scheduler-field">
            <span>Start</span>
            <input
              className="scheduler-input"
              type="time"
              value={value.start ?? ""}
              onChange={(event) => onChange({ ...value, start: event.target.value || undefined })}
            />
          </label>
          <label className="scheduler-field">
            <span>End</span>
            <input
              className="scheduler-input"
              type="time"
              value={value.end ?? ""}
              onChange={(event) => onChange({ ...value, end: event.target.value || undefined })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function isWeeklyHours(value: unknown): value is CatalogWeeklyHours {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeWindowWeekdays(value: unknown): value is CatalogTimeWindowWeekdays {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as CatalogTimeWindowWeekdays).weekdays)
  );
}
