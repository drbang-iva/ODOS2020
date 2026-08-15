import { useEffect, useRef, useState } from "react";
import {
  CATALOG_WEEKDAYS,
  centsFromCurrencyInput,
  currencyInputFromCents,
  type CatalogFieldDefinition,
  type CatalogTimeWindowWeekdays,
  type CatalogWeekday,
  type CatalogWeeklyHours,
} from "../../lib/catalog-field-kernel";
import { nextAvailableHoursWindow } from "../../lib/scheduling-settings";
import { DISCIPLINE_COLOR_BANDS } from "../../lib/scheduling";
import { RequiredFieldLabel } from "./RequiredGate";
import { OdosChips } from "../inputs/OdosChips";
import { OdosSearchPicker } from "../inputs/OdosSearchPicker";

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
          <div className="grid gap-2">
            <input
              id={inputId}
              className="scheduler-input"
              type="number"
              min={field.min}
              max={field.max}
              step={field.type === "duration" || field.integer ? 1 : undefined}
              inputMode={field.type === "duration" || field.integer ? "numeric" : "decimal"}
              value={typeof value === "number" ? value : ""}
              aria-describedby={describedBy}
              onChange={(event) =>
                onChange(event.target.value === "" ? undefined : Number(event.target.value))
              }
            />
            {field.type === "duration" && field.presets && (
              <div className="flex flex-wrap gap-2">
                {field.presets.map((minutes) => (
                  <button
                    key={minutes}
                    className="scheduler-button"
                    type="button"
                    aria-label={`Set duration to ${minutes} minutes`}
                    onClick={() => onChange(minutes)}
                  >
                    {minutes === 60 ? "1 hr" : `${minutes} min`}
                  </button>
                ))}
              </div>
            )}
          </div>
        </FieldFrame>
      );
    case "currency":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired}>
          <CurrencyInput
            id={inputId}
            value={typeof value === "number" ? value : undefined}
            ariaDescribedBy={describedBy}
            onChange={onChange}
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
          <div id={inputId} className="rounded border border-white/10 bg-black/20 p-3" aria-describedby={describedBy}>
            <OdosChips
              options={field.options}
              selected={selected}
              onChange={onChange}
              ariaLabel={field.label}
            />
          </div>
        </FieldFrame>
      );
    }
    case "reference-picker":
      return (
        <FieldFrame field={field} error={error} showRequired={showRequired} hideLabel>
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

export function CurrencyInput({
  id,
  value,
  ariaDescribedBy,
  ariaLabel,
  className = "scheduler-input",
  onChange,
}: {
  id?: string;
  value?: number;
  ariaDescribedBy?: string;
  ariaLabel?: string;
  className?: string;
  onChange: (value: number | undefined) => void;
}) {
  const [input, setInput] = useState(() => value === undefined ? "" : currencyInputFromCents(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setInput(value === undefined ? "" : currencyInputFromCents(value));
  }, [value]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--odos-muted)]" aria-hidden="true">$</span>
      <input
        id={id}
        className={`${className} pl-7`}
        type="text"
        inputMode="decimal"
        value={input}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        onFocus={() => { editing.current = true; }}
        onChange={(event) => {
          const next = event.target.value;
          setInput(next);
          if (next === "") onChange(undefined);
          else {
            const cents = centsFromCurrencyInput(next);
            if (cents !== undefined) onChange(cents);
          }
        }}
        onBlur={() => {
          editing.current = false;
          const cents = centsFromCurrencyInput(input);
          if (cents === undefined) {
            setInput(value === undefined ? "" : currencyInputFromCents(value));
            return;
          }
          setInput(currencyInputFromCents(cents));
          onChange(cents);
        }}
      />
    </div>
  );
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
  return (
    <div className="grid gap-2">
      <OdosSearchPicker
        inputId={inputId}
        describedBy={describedBy}
        label={label}
        value={value}
        selectedLabel={value}
        placeholder={`Search ${label.toLocaleLowerCase()}…`}
        searchDelayMs={200}
        disabled={!search}
        search={async (query) => (await search?.(query) ?? []).map((option) => ({
          value: option.reference,
          label: option.display,
          description: option.reference,
          item: option,
        }))}
        onClear={() => onChange("")}
        onSelect={(option) => onChange(option.item.reference)}
      />
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
        const open = windows.length > 0;
        return (
          <div key={day} className="grid gap-2 border border-white/10 bg-white/[0.03] p-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-10 text-sm font-semibold text-white/75">{WEEKDAY_DISPLAY[day]}</div>
              <label className="flex items-center gap-2 text-sm text-white/70">
                <input
                  type="checkbox"
                  checked={open}
                  onChange={(event) =>
                    updateDay(day, event.target.checked ? [{ start: "09:00", end: "17:00" }] : [])
                  }
                />
                <span>Open</span>
              </label>
              {open && (
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
            {open &&
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
