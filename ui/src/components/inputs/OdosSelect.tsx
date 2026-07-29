import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface OdosSelectOption<T> {
  value: T;
  label: string;
  group?: string;
  disabled?: boolean;
}

export interface OdosSelectProps<T> {
  value: T;
  options: readonly OdosSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  defaultValue?: T;
  states?: readonly OdosSelectOption<T>[];
  disabled?: boolean;
  loading?: boolean;
  onInputChange?: (value: string) => void;
  inputMode?: "text" | "decimal" | "numeric";
  isEqual?: (left: T, right: T) => boolean;
}

export function OdosSelect<T>({
  value,
  options,
  onChange,
  ariaLabel,
  defaultValue,
  states = [],
  disabled = false,
  loading = false,
  onInputChange,
  inputMode = "text",
  isEqual = Object.is,
}: OdosSelectProps<T>) {
  const selectableOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const centerValue = options.some((option) => isEqual(option.value, value))
    ? value
    : defaultValue ?? value;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => defaultIndex(selectableOptions, centerValue, isEqual));
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeAhead = useRef("");
  const typeAheadTimer = useRef<ReturnType<typeof setTimeout>>();
  const listboxId = useId();
  const selectedOption = options.find((option) => isEqual(option.value, value));

  useEffect(() => {
    if (!open) return;
    const index = defaultIndex(selectableOptions, centerValue, isEqual);
    setActiveIndex(index);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => {
      optionRefs.current[index]?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [centerValue, isEqual, open, selectableOptions]);

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

  useEffect(() => () => {
    if (typeAheadTimer.current) clearTimeout(typeAheadTimer.current);
  }, []);

  function openAtCenter() {
    setActiveIndex(defaultIndex(selectableOptions, centerValue, isEqual));
    setOpen(true);
  }

  function select(option: OdosSelectOption<T>) {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  function moveActive(delta: number) {
    if (!open) {
      openAtCenter();
      return;
    }
    setActiveIndex((current) => Math.min(selectableOptions.length - 1, Math.max(0, current + delta)));
  }

  function jumpByLabel(character: string) {
    typeAhead.current += character.toLocaleLowerCase();
    if (typeAheadTimer.current) clearTimeout(typeAheadTimer.current);
    typeAheadTimer.current = setTimeout(() => {
      typeAhead.current = "";
    }, 700);
    const start = Math.max(0, activeIndex + 1);
    const ordered = [...selectableOptions.slice(start), ...selectableOptions.slice(0, start)];
    const match = ordered.find((option) => option.label.toLocaleLowerCase().startsWith(typeAhead.current));
    if (match) setActiveIndex(selectableOptions.indexOf(match));
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      select(selectableOptions[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveIndex(selectableOptions.length ? 0 : -1);
    } else if (event.key === "End" && open) {
      event.preventDefault();
      setActiveIndex(selectableOptions.length - 1);
    } else if (!onInputChange && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (!open) openAtCenter();
      jumpByLabel(event.key);
    }
  }

  let lastGroup: string | undefined;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div className="flex min-h-11 overflow-hidden rounded border border-[color:var(--odos-line-2)] bg-bg-deep focus-within:border-brand">
        {onInputChange ? (
          <input
            type="text"
            inputMode={inputMode}
            role="combobox"
            aria-label={ariaLabel}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
            disabled={disabled}
            value={String(value ?? "")}
            onChange={(event) => {
              onInputChange(event.target.value);
              if (!open) openAtCenter();
            }}
            onClick={() => {
              if (!open) openAtCenter();
            }}
            onKeyDown={handleKeyDown}
            className="min-h-11 min-w-0 flex-1 bg-transparent px-3 text-sm text-[color:var(--odos-text)] outline-none disabled:opacity-45"
          />
        ) : (
          <button
            type="button"
            role="combobox"
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
            disabled={disabled}
            onClick={() => open ? setOpen(false) : openAtCenter()}
            onKeyDown={handleKeyDown}
            className="min-h-11 min-w-0 flex-1 px-3 text-left text-sm text-[color:var(--odos-text)] outline-none disabled:opacity-45"
          >
            {selectedOption?.label ?? ""}
          </button>
        )}
        <button
          type="button"
          aria-label={`${ariaLabel} options`}
          aria-expanded={open}
          aria-controls={listboxId}
          disabled={disabled}
          onClick={() => open ? setOpen(false) : openAtCenter()}
          className="min-h-11 min-w-11 border-l border-[color:var(--odos-line)] text-xs text-[color:var(--odos-muted)] outline-none hover:bg-[var(--odos-surface-2)] hover:text-[color:var(--odos-text)] focus-visible:bg-brand/20 disabled:opacity-45"
        >
          ▾
        </button>
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-label={`${ariaLabel} options`}
        hidden={!open}
        aria-busy={loading || undefined}
        className="absolute z-50 mt-2 w-full min-w-[11rem] max-w-[calc(100vw-2rem)] rounded border border-[color:var(--odos-line-2)] bg-bg-deep shadow-xl"
      >
        {states.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-[color:var(--odos-line)] p-2">
            {states.map((state) => (
              <button
                key={state.label}
                type="button"
                role="option"
                aria-selected={isEqual(value, state.value)}
                disabled={disabled || state.disabled}
                onClick={() => select(state)}
                className={[
                  "min-h-11 min-w-11 rounded border px-3 text-sm outline-none",
                  isEqual(value, state.value)
                    ? "border-brand bg-brand/20 text-[color:var(--odos-text)]"
                    : "border-[color:var(--odos-line-2)] text-[color:var(--odos-muted)] hover:bg-[var(--odos-surface-2)] focus-visible:border-brand",
                ].join(" ")}
              >
                {state.label}
              </button>
            ))}
          </div>
        )}
        <div className="max-h-[min(16rem,calc(100dvh-8rem))] space-y-2 overflow-y-auto p-2">
          {loading && <p className="min-h-11 px-3 py-3 text-sm text-[color:var(--odos-muted)]">Loading…</p>}
          {!loading && selectableOptions.map((option, index) => {
            const group = option.group;
            const showGroup = Boolean(group && group !== lastGroup);
            lastGroup = group;
            return (
              <div key={`${group ?? ""}-${option.label}`}>
                {showGroup && (
                  <div role="separator" aria-hidden="true" className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-faint)]">
                    {group}
                  </div>
                )}
                <button
                  ref={(node) => { optionRefs.current[index] = node; }}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={isEqual(value, option.value)}
                  data-default={defaultValue !== undefined && isEqual(option.value, defaultValue) ? "true" : undefined}
                  disabled={disabled}
                  onPointerEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => select(option)}
                  className={[
                    "block min-h-11 w-full rounded px-3 py-2 text-left text-sm outline-none",
                    index === activeIndex
                      ? "bg-brand/20 text-[color:var(--odos-text)]"
                      : "text-[color:var(--odos-muted)] hover:bg-[var(--odos-surface-2)] focus-visible:bg-brand/20",
                  ].join(" ")}
                >
                  {option.label}
                </button>
              </div>
            );
          })}
          {!loading && selectableOptions.length === 0 && (
            <p className="min-h-11 px-3 py-3 text-sm text-[color:var(--odos-muted)]">No options available</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function defaultIndex<T>(
  options: readonly OdosSelectOption<T>[],
  centerValue: T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): number {
  const index = options.findIndex((option) => isEqual(option.value, centerValue));
  return index === -1 ? (options.length ? 0 : -1) : index;
}
