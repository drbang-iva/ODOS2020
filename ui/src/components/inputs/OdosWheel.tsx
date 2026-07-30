import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

export interface OdosWheelState {
  value: string;
  label: string;
}

export interface OdosWheelProps {
  value: number;
  centerOn: number;
  step: number;
  min: number;
  max: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  ariaLabel: string;
  unit?: string;
  states?: readonly OdosWheelState[];
  selectedState?: string;
  onStateChange?: (value: string) => void;
  disabled?: boolean;
}

interface DragState {
  pointerId: number;
  startY: number;
  previousY: number;
  previousTime: number;
  velocity: number;
  moved: boolean;
}

export function OdosWheel({
  value,
  centerOn,
  step,
  min,
  max,
  format,
  onChange,
  ariaLabel,
  unit,
  states = [],
  selectedState,
  onStateChange,
  disabled = false,
}: OdosWheelProps) {
  const values = useMemo(() => wheelValues(min, max, step), [max, min, step]);
  const centerIndex = closestIndex(values, centerOn);
  const selectedStateLabel = states.find((state) => state.value === selectedState)?.label;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [typedValue, setTypedValue] = useState(() => selectedStateLabel === undefined ? format(value) : "");
  const editingRef = useRef(editing);
  const formatRef = useRef(format);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const drag = useRef<DragState>();
  const suppressClick = useRef(false);
  const listboxId = useId();
  editingRef.current = editing;
  formatRef.current = format;

  useEffect(() => {
    if (!editingRef.current) setTypedValue(selectedStateLabel === undefined ? formatRef.current(value) : "");
  }, [selectedStateLabel, value]);

  useEffect(() => {
    if (!open || centerIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      optionRefs.current[centerIndex]?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [centerIndex, open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function commitTypedValue() {
    if (typedValue.trim() === "") {
      const blankState = states.find((state) => state.value === "");
      if (blankState && onStateChange) {
        onStateChange(blankState.value);
        setTypedValue("");
        setEditing(false);
        return;
      }
    }
    const parsed = Number(typedValue);
    if (!Number.isFinite(parsed)) {
      setTypedValue(format(value));
      setEditing(false);
      return;
    }
    const normalized = normalizeWheelValue(parsed, min, max, step);
    setTypedValue(format(normalized));
    setEditing(false);
    if (normalized !== value) onChange(normalized);
  }

  const changeBy = useCallback((next: number) => {
    const normalized = normalizeWheelValue(next, min, max, step);
    setTypedValue(format(normalized));
    if (normalized !== value) onChange(normalized);
  }, [format, max, min, onChange, step, value]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const handleWheel = (event: WheelEvent) => {
      if (disabled) return;
      event.preventDefault();
      changeBy(value + (event.deltaY > 0 ? step : -step));
    };
    input.addEventListener("wheel", handleWheel, { passive: false });
    return () => input.removeEventListener("wheel", handleWheel);
  }, [changeBy, disabled, step, value]);

  function select(next: number) {
    changeBy(next);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      changeBy(value + (event.key === "ArrowDown" ? step : -step));
    } else if (event.key === "Home") {
      event.preventDefault();
      changeBy(min);
    } else if (event.key === "End") {
      event.preventDefault();
      changeBy(max);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitTypedValue();
      setOpen(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setTypedValue(format(value));
      setEditing(false);
      setOpen(false);
    }
  }

  function snapFromScroll(projectedScrollTop?: number) {
    const list = listRef.current;
    if (!list || !values.length) return;
    const center = (projectedScrollTop ?? list.scrollTop) + list.clientHeight / 2;
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    optionRefs.current.forEach((option, index) => {
      if (!option) return;
      const optionCenter = option.offsetTop + option.offsetHeight / 2;
      const nextDistance = Math.abs(optionCenter - center);
      if (nextDistance < distance) {
        nearest = index;
        distance = nextDistance;
      }
    });
    optionRefs.current[nearest]?.scrollIntoView({ block: "center", behavior: "smooth" });
    changeBy(values[nearest]);
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div className="flex min-h-11 overflow-hidden rounded border border-[color:var(--odos-line-2)] bg-bg-deep focus-within:border-brand">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listboxId}
          disabled={disabled}
          value={typedValue}
          placeholder={selectedStateLabel}
          onFocus={() => setEditing(true)}
          onChange={(event) => {
            setEditing(true);
            setTypedValue(event.target.value);
          }}
          onBlur={commitTypedValue}
          onClick={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="min-h-11 min-w-0 flex-1 bg-transparent px-3 text-sm text-[color:var(--odos-text)] outline-none disabled:opacity-45"
        />
        {unit && <span aria-hidden="true" className="flex min-h-11 items-center px-2 text-xs text-[color:var(--odos-muted)]">{unit}</span>}
        <button
          type="button"
          aria-label={`${ariaLabel} wheel`}
          aria-expanded={open}
          aria-controls={listboxId}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          className="min-h-11 min-w-11 border-l border-[color:var(--odos-line)] text-[color:var(--odos-muted)] outline-none hover:bg-[var(--odos-surface-2)] hover:text-[color:var(--odos-text)] focus-visible:bg-brand/20 disabled:opacity-45"
        >
          ↕
        </button>
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-label={`${ariaLabel} wheel values`}
        hidden={!open}
        className="absolute z-50 mt-2 w-full min-w-[8rem] max-w-[calc(100vw-2rem)] rounded border border-[color:var(--odos-line-2)] bg-bg-deep shadow-xl"
      >
        {states.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-[color:var(--odos-line)] p-2">
            {states.map((state) => (
              <button
                key={state.value}
                type="button"
                role="option"
                aria-selected={selectedState === state.value}
                disabled={disabled}
                onClick={() => {
                  onStateChange?.(state.value);
                  setOpen(false);
                }}
                className={[
                  "min-h-11 min-w-11 rounded border px-3 text-sm outline-none",
                  selectedState === state.value
                    ? "border-brand bg-brand/20 text-[color:var(--odos-text)]"
                    : "border-[color:var(--odos-line-2)] text-[color:var(--odos-muted)] hover:bg-[var(--odos-surface-2)] focus-visible:border-brand",
                ].join(" ")}
              >
                {state.label}
              </button>
            ))}
          </div>
        )}
        <div
          ref={listRef}
          className="max-h-[min(16rem,calc(100dvh-8rem))] touch-none snap-y snap-mandatory space-y-2 overflow-y-auto p-2"
          onPointerDown={(event) => {
            if (disabled) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              previousY: event.clientY,
              previousTime: event.timeStamp,
              velocity: 0,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.pointerId !== event.pointerId) return;
            const elapsed = Math.max(1, event.timeStamp - current.previousTime);
            const distance = current.previousY - event.clientY;
            if (Math.abs(current.startY - event.clientY) >= 4) current.moved = true;
            event.currentTarget.scrollTop += distance;
            current.velocity = distance / elapsed;
            current.previousY = event.clientY;
            current.previousTime = event.timeStamp;
          }}
          onPointerUp={(event) => {
            const current = drag.current;
            if (!current || current.pointerId !== event.pointerId) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            if (current.moved) {
              event.preventDefault();
              suppressClick.current = true;
              snapFromScroll(event.currentTarget.scrollTop + current.velocity * 120);
              setTimeout(() => {
                suppressClick.current = false;
              }, 0);
            }
            drag.current = undefined;
          }}
          onPointerCancel={() => {
            drag.current = undefined;
          }}
        >
          {values.map((option, index) => (
            <button
              key={option}
              ref={(node) => { optionRefs.current[index] = node; }}
              type="button"
              role="option"
              aria-selected={option === value}
              data-center={index === centerIndex ? "true" : undefined}
              disabled={disabled}
              onClick={() => {
                if (suppressClick.current) return;
                select(option);
              }}
              className={[
                "block min-h-11 w-full snap-center rounded px-3 py-2 text-center text-sm outline-none",
                option === value
                  ? "bg-brand/20 text-[color:var(--odos-text)]"
                  : "text-[color:var(--odos-muted)] hover:bg-[var(--odos-surface-2)] focus-visible:bg-brand/20",
              ].join(" ")}
            >
              {format(option)}{unit ? ` ${unit}` : ""}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function normalizeWheelValue(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const stepped = min + Math.round((clamped - min) / step) * step;
  const precision = Math.max(decimalPlaces(min), decimalPlaces(max), decimalPlaces(step));
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(precision));
}

function wheelValues(min: number, max: number, step: number): number[] {
  if (step <= 0 || max < min) return [];
  const count = Math.floor((max - min) / step + 0.0000001);
  return Array.from({ length: count + 1 }, (_, index) => normalizeWheelValue(min + index * step, min, max, step));
}

function closestIndex(values: readonly number[], target: number): number {
  if (!values.length) return -1;
  return values.reduce((best, value, index) =>
    Math.abs(value - target) < Math.abs(values[best] - target) ? index : best, 0);
}

function decimalPlaces(value: number): number {
  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.split(".")[1]?.length ?? 0;
}
