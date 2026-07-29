import { useEffect, useId, useRef, useState } from "react";

export interface OdosSearchPickerOption<T> {
  value: string;
  label: string;
  description?: string;
  item: T;
}

export interface OdosSearchPickerProps<T> {
  label: string;
  value: string;
  selectedLabel?: string;
  placeholder: string;
  search: (query: string) => Promise<OdosSearchPickerOption<T>[]>;
  onSelect: (option: OdosSearchPickerOption<T>) => void;
  onClear: () => void;
  onCreate?: (name: string) => Promise<OdosSearchPickerOption<T>>;
  createLabel?: string;
  searchDelayMs?: number;
  validationMessage?: string;
  disabled?: boolean;
}

export function OdosSearchPicker<T>({
  label,
  value,
  selectedLabel,
  placeholder,
  search,
  onSelect,
  onClear,
  onCreate,
  createLabel = "Create",
  searchDelayMs = 250,
  validationMessage,
  disabled = false,
}: OdosSearchPickerProps<T>) {
  const inputId = useId();
  const listboxId = useId();
  const [query, setQuery] = useState(selectedLabel ?? "");
  const [editing, setEditing] = useState(false);
  const [options, setOptions] = useState<OdosSearchPickerOption<T>[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!editing || value) {
      setQuery(selectedLabel ?? "");
      setEditing(false);
    }
  }, [editing, selectedLabel, value]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!editing || trimmed.length < 2 || (value && trimmed === selectedLabel)) {
      setOptions([]);
      setActiveIndex(0);
      setLoading(false);
      setError(undefined);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(undefined);
      search(trimmed)
        .then((results) => {
          if (!cancelled) {
            setOptions(results);
            setActiveIndex(0);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setOptions([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, searchDelayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [editing, query, search, searchDelayMs, selectedLabel, value]);

  function choose(option: OdosSearchPickerOption<T>) {
    setEditing(false);
    setQuery(option.label);
    setOptions([]);
    setError(undefined);
    onSelect(option);
  }

  async function create() {
    if (!onCreate || !query.trim() || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const option = await onCreate(query.trim());
      if (mounted.current) choose(option);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setCreating(false);
    }
  }

  const showResults = editing
    && (loading || Boolean(error) || options.length > 0 || Boolean(onCreate && query.trim().length >= 2 && !value));

  return (
    <div
      className="relative"
      onFocus={() => setEditing(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false);
      }}
    >
      <label htmlFor={inputId} className="block text-xs font-semibold text-white/75">{label}</label>
      <input
        id={inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showResults}
        aria-controls={listboxId}
        aria-activedescendant={showResults && options.length ? `${listboxId}-option-${activeIndex}` : undefined}
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={validationMessage ? true : undefined}
        disabled={disabled}
        onChange={(event) => {
          setEditing(true);
          setQuery(event.target.value);
          if (value) onClear();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && options.length) {
            event.preventDefault();
            setActiveIndex((current) => Math.min(options.length - 1, current + 1));
          } else if (event.key === "ArrowUp" && options.length) {
            event.preventDefault();
            setActiveIndex((current) => Math.max(0, current - 1));
          } else if (event.key === "Home" && options.length) {
            event.preventDefault();
            setActiveIndex(0);
          } else if (event.key === "End" && options.length) {
            event.preventDefault();
            setActiveIndex(options.length - 1);
          } else if (event.key === "Enter" && options[activeIndex]) {
            event.preventDefault();
            choose(options[activeIndex]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
        className="mt-2 min-h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-brand disabled:opacity-45"
      />
      {value && <p className="mt-2 text-xs text-emerald-300">Selected: {selectedLabel}</p>}
      {validationMessage && <p className="mt-2 text-xs font-normal text-red-300">{validationMessage}</p>}
      <div
        id={listboxId}
        role="listbox"
        aria-label={`${label} results`}
        hidden={!showResults}
        className="absolute z-50 mt-2 max-h-[min(20rem,calc(100dvh-8rem))] w-full space-y-2 overflow-y-auto rounded border border-white/15 bg-bg-deep p-2 shadow-xl"
      >
        {loading && <p className="min-h-11 px-3 py-3 text-sm text-white/55">Searching…</p>}
        {error && <p role="alert" className="min-h-11 px-3 py-3 text-sm text-red-300">{error}</p>}
        {!loading && options.map((option, index) => (
          <button
            id={`${listboxId}-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            key={option.value}
            onPointerEnter={() => setActiveIndex(index)}
            onFocus={() => setActiveIndex(index)}
            onClick={() => choose(option)}
            className={[
              "block min-h-11 w-full rounded px-3 py-2 text-left text-sm outline-none",
              index === activeIndex
                ? "bg-brand/20 text-white"
                : "text-white/75 hover:bg-white/[0.06] focus-visible:bg-brand/20",
            ].join(" ")}
          >
            <span className="block font-semibold">{option.label}</span>
            {option.description && <span className="mt-1 block text-xs text-white/45">{option.description}</span>}
          </button>
        ))}
        {onCreate && query.trim().length >= 2 && !value && (
          <button
            type="button"
            disabled={creating}
            onClick={() => void create()}
            className="block min-h-11 w-full rounded border border-emerald-400/30 px-3 py-2 text-left text-sm font-semibold text-emerald-200 outline-none hover:bg-emerald-400/10 focus-visible:border-emerald-300 disabled:opacity-50"
          >
            {creating ? "Creating…" : `${createLabel} “${query.trim()}”`}
          </button>
        )}
      </div>
    </div>
  );
}
