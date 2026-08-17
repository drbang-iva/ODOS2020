import { useEffect, useState } from "react";
import { OdosChips } from "../inputs/OdosChips";
import { OdosSelect } from "../inputs/OdosSelect";
import type {
  ClockHourExtentValue,
  CustomFindingField,
  FindingDetails,
  FindingQualifierDefinition,
  FindingQualifierValue,
} from "./CustomFindingSection";
import { formatStepValue } from "./power-options";
import { formatDate } from "./PrescriptionSection";

export interface PriorReading {
  recordedAt: string;
  value: FindingQualifierValue | "present";
}

export type PriorFindingReadings = Record<string, {
  presence?: PriorReading;
  qualifiers: Record<string, PriorReading>;
}>;

type FindingOption = NonNullable<CustomFindingField["options"]>[number];

interface FindingWorksheetCapture {
  selections: string[];
  findingDetails?: FindingDetails;
}

export function FindingWorksheetRow({ option, allOptions, capture, prior, onSelections, onFindingDetail }: {
  option: FindingOption;
  allOptions: FindingOption[];
  capture: FindingWorksheetCapture;
  prior: PriorFindingReadings;
  onSelections(selections: string[]): void;
  onFindingDetail(optionCode: string, qualifierKey: string, value: FindingQualifierValue | undefined): void;
}) {
  const children = allOptions.filter((candidate) => candidate.parentCode === option.code);
  const childCodes = children.map((child) => child.code);
  const controls = [
    ...(option.qualifiers ?? []).map((qualifier) => (
      <FindingQualifierControl
        key={qualifier.key}
        qualifier={qualifier}
        value={capture.findingDetails?.[option.code]?.[qualifier.key]}
        prior={prior[option.code]?.qualifiers[qualifier.key]}
        onChange={(value) => onFindingDetail(option.code, qualifier.key, value)}
      />
    )),
    ...(children.length > 0 ? [(
      <div key="children" className="min-w-0">
        <div className="mb-1 text-xs font-semibold text-[color:var(--odos-muted)]">Details</div>
        <OdosChips
          options={children.map((child) => ({ value: child.code, label: findingChipLabel(child.display) }))}
          selected={capture.selections.filter((code) => childCodes.includes(code))}
          onChange={(nextChildren) => onSelections(replaceSelectionGroup(capture.selections, childCodes, nextChildren))}
          ariaLabel={`${option.display} details`}
        />
        {children.flatMap((child) => {
          const reading = prior[child.code]?.presence;
          return reading ? [<PriorValue key={child.code} reading={reading} value={`${findingChipLabel(child.display)} present`} />] : [];
        })}
      </div>
    )] : []),
  ];
  const removeCodes = new Set([option.code, ...childCodes]);
  const optionPrior = prior[option.code]?.presence;
  return (
    <div data-finding-row={option.code} className="grid gap-3 rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-3 md:grid-cols-[minmax(8rem,0.7fr)_minmax(0,2fr)_auto]">
      <div className="flex min-h-11 flex-col items-start justify-center text-sm font-semibold text-[color:var(--odos-text)]">
        <span>{findingChipLabel(option.display)}</span>
        {optionPrior && <PriorValue reading={optionPrior} value="Present" />}
      </div>
      {controls.length > 0 && <div data-finding-controls={option.code} className="grid gap-3 sm:grid-cols-2">{controls}</div>}
      <button
        type="button"
        aria-label={`Remove ${option.display}`}
        onClick={() => onSelections(capture.selections.filter((code) => !removeCodes.has(code)))}
        className="min-h-11 min-w-11 justify-self-end rounded border border-[color:var(--odos-line-2)] text-[color:var(--odos-muted)] outline-none hover:bg-[var(--odos-surface-3)] hover:text-[color:var(--odos-text)] focus-visible:border-brand"
      >
        ×
      </button>
    </div>
  );
}

export function FindingQualifierControl({ qualifier, value, prior, onChange }: {
  qualifier: FindingQualifierDefinition;
  value: FindingQualifierValue | undefined;
  prior?: PriorReading;
  onChange(value: FindingQualifierValue | undefined): void;
}) {
  if (qualifier.kind === "graded") {
    const selected = typeof value === "string" ? [value] : [];
    return (
      <div className="min-w-0">
        <div className="mb-1 text-xs font-semibold text-[color:var(--odos-muted)]">{qualifier.display}</div>
        <OdosChips
          options={qualifier.options.map((option) => ({ value: option, label: findingChipLabel(option) }))}
          selected={selected}
          onChange={(next) => onChange(next[0])}
          ariaLabel={qualifier.display}
          exclusive
        />
        {prior && <PriorValue reading={prior} value={formatPriorQualifierValue(qualifier, prior.value)} />}
      </div>
    );
  }
  if (qualifier.kind === "enum") {
    const selected = typeof value === "string" ? [value] : [];
    return (
      <div className="min-w-0">
        <div className="mb-1 text-xs font-semibold text-[color:var(--odos-muted)]">{qualifier.display}</div>
        <OdosChips
          options={qualifier.options.map((option) => ({ value: option.code, label: option.display }))}
          selected={selected}
          onChange={(next) => onChange(next[0])}
          ariaLabel={qualifier.display}
          exclusive
        />
        {prior && <PriorValue reading={prior} value={formatPriorQualifierValue(qualifier, prior.value)} />}
      </div>
    );
  }
  if (qualifier.kind === "numeric") {
    return <NumericFindingQualifier qualifier={qualifier} value={typeof value === "number" ? value : undefined} prior={prior} onChange={onChange} />;
  }
  const extent = isClockHourExtentValue(value) ? value : undefined;
  const hours = [
    { value: "", label: "Not recorded" },
    ...Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) })),
  ];
  const updateHour = (key: "from" | "to", next: string) => {
    if (next === "") {
      onChange(undefined);
      return;
    }
    const hour = Number(next);
    onChange(extent ? { ...extent, [key]: hour } : { from: hour, to: hour, clockwise: true });
  };
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-semibold text-[color:var(--odos-muted)]">{qualifier.display}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <OdosSelect value={extent ? String(extent.from) : ""} options={hours} onChange={(next) => updateHour("from", next)} ariaLabel={`${qualifier.display} from clock hour`} />
        <OdosSelect value={extent ? String(extent.to) : ""} options={hours} onChange={(next) => updateHour("to", next)} ariaLabel={`${qualifier.display} to clock hour`} />
      </div>
      {extent && <div className="mt-2"><OdosChips
        options={[{ value: true, label: "Clockwise" }, { value: false, label: "Counterclockwise" }]}
        selected={[extent.clockwise]}
        onChange={(next) => { if (next.length) onChange({ ...extent, clockwise: next[0]! }); }}
        ariaLabel={`${qualifier.display} direction`}
        exclusive
      /></div>}
      {prior && <PriorValue reading={prior} value={formatPriorQualifierValue(qualifier, prior.value)} />}
    </div>
  );
}

export function NumericFindingQualifier({ qualifier, value, prior, onChange }: {
  qualifier: Extract<FindingQualifierDefinition, { kind: "numeric" }>;
  value: number | undefined;
  prior?: PriorReading;
  onChange(value: number | undefined): void;
}) {
  const storedText = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(storedText);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(storedText);
    setValidationError(null);
  }, [storedText]);

  const commit = () => {
    const text = draft.trim();
    if (text === "") {
      onChange(undefined);
      setDraft("");
      setValidationError(null);
      return;
    }
    const parsed = Number(text);
    const stepPosition = (parsed - qualifier.min) / qualifier.step;
    if (!Number.isFinite(parsed) || parsed < qualifier.min || parsed > qualifier.max ||
      Math.abs(stepPosition - Math.round(stepPosition)) > 1e-9) {
      setDraft(storedText);
      setValidationError(`${qualifier.display} must be between ${qualifier.min} and ${qualifier.max} in increments of ${qualifier.step}.`);
      return;
    }
    onChange(parsed);
    setDraft(String(parsed));
    setValidationError(null);
  };

  return (
    <div className="min-w-0">
      <label>
        <span className="mb-1 block text-xs font-semibold text-[color:var(--odos-muted)]">{qualifier.display}</span>
        <div className={`flex min-h-11 overflow-hidden rounded border bg-bg-deep focus-within:border-brand ${validationError ? "border-[color:var(--odos-alert)]" : "border-[color:var(--odos-line-2)]"}`}>
          <input
            type="text"
            inputMode="decimal"
            aria-label={qualifier.display}
            aria-invalid={validationError ? true : undefined}
            value={draft}
            min={qualifier.min}
            max={qualifier.max}
            step={qualifier.step}
            onChange={(event) => {
              setDraft(event.target.value);
              setValidationError(null);
            }}
            onBlur={commit}
            className="min-h-11 min-w-0 flex-1 bg-transparent px-3 text-sm text-[color:var(--odos-text)] outline-none"
          />
          {qualifier.unit && <span className="flex min-h-11 items-center border-l border-[color:var(--odos-line)] px-3 text-sm text-[color:var(--odos-muted)]">{qualifier.unit}</span>}
        </div>
      </label>
      {prior && <PriorValue reading={prior} value={formatPriorQualifierValue(qualifier, prior.value)} />}
      {validationError && <span role="alert" className="mt-1 block text-xs text-[color:var(--odos-alert)]">{validationError}</span>}
    </div>
  );
}

export function PriorValue({ reading, value }: { reading: PriorReading; value: string }) {
  return (
    <div data-prior-reading="" className="mt-1 text-xs font-normal text-[color:var(--odos-faint)]">
      Prior: {value} · {formatDate(reading.recordedAt)}
    </div>
  );
}

function formatPriorQualifierValue(
  qualifier: FindingQualifierDefinition,
  value: FindingQualifierValue | "present",
): string {
  if (qualifier.kind === "enum" && typeof value === "string") {
    return qualifier.options.find((option) => option.code === value)?.display ?? findingChipLabel(value);
  }
  if (qualifier.kind === "numeric" && typeof value === "number") {
    return `${formatStepValue(value, qualifier.step)}${qualifier.unit ? ` ${qualifier.unit}` : ""}`;
  }
  if (qualifier.kind === "extent" && isClockHourExtentValue(value)) {
    return `${value.from}–${value.to} ${value.clockwise ? "clockwise" : "counterclockwise"}`;
  }
  return typeof value === "string" ? findingChipLabel(value) : String(value);
}

export function findingChipLabel(display: string): string {
  return display.replace(/(^|[\s(/-])\p{L}/gu, (wordStart) => wordStart.toUpperCase());
}

export function replaceSelectionGroup(selected: string[], group: string[], nextGroup: string[]): string[] {
  const groupSet = new Set(group);
  const nextSet = new Set(nextGroup);
  return [
    ...selected.filter((value) => !groupSet.has(value) || nextSet.has(value)),
    ...nextGroup.filter((value) => !selected.includes(value)),
  ];
}

export function isClockHourExtentValue(value: FindingQualifierValue | undefined): value is ClockHourExtentValue {
  return typeof value === "object" && value !== null &&
    Number.isInteger(value.from) && value.from >= 1 && value.from <= 12 &&
    Number.isInteger(value.to) && value.to >= 1 && value.to <= 12 &&
    typeof value.clockwise === "boolean";
}
