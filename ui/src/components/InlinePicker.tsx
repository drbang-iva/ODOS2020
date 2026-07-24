import { useEffect, useId, useRef, useState } from "react";

export interface InlinePickerOption<T> {
  value: string;
  label: string;
  description?: string;
  item: T;
}

export function InlinePicker<T>({
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
}: {
  label: string;
  value: string;
  selectedLabel?: string;
  placeholder: string;
  search: (query: string) => Promise<InlinePickerOption<T>[]>;
  onSelect: (option: InlinePickerOption<T>) => void;
  onClear: () => void;
  onCreate?: (name: string) => Promise<InlinePickerOption<T>>;
  createLabel?: string;
  searchDelayMs?: number;
  validationMessage?: string;
}) {
  const inputId = useId();
  const [query, setQuery] = useState(selectedLabel ?? "");
  const [editing, setEditing] = useState(false);
  const [options, setOptions] = useState<InlinePickerOption<T>[]>([]);
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
    if (trimmed.length < 2 || (value && trimmed === selectedLabel)) {
      setOptions([]);
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
          if (!cancelled) setOptions(results);
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
  }, [query, search, searchDelayMs, selectedLabel, value]);

  const choose = (option: InlinePickerOption<T>) => {
    setEditing(false);
    setQuery(option.label);
    setOptions([]);
    setError(undefined);
    onSelect(option);
  };

  const create = async () => {
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
  };

  return (
    <div
      className="relative"
      onFocus={() => setEditing(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false);
      }}
    >
      <label htmlFor={inputId} className="block text-xs font-semibold text-[color:var(--odos-muted)]">{label}</label>
      <input
        id={inputId}
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={validationMessage ? true : undefined}
        onChange={(event) => {
          setEditing(true);
          setQuery(event.target.value);
          if (value) onClear();
        }}
        className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-3 py-2 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)]"
      />
      {value && <p className="mt-1 text-xs text-emerald-300">Selected: {selectedLabel}</p>}
      {validationMessage && <p className="mt-1 text-xs font-normal text-red-300">{validationMessage}</p>}
      {editing && (loading || error || options.length > 0 || (onCreate && query.trim().length >= 2 && !value)) && (
        <div className="absolute z-20 mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] p-2 shadow-xl">
          {loading && <p className="px-2 py-1 text-xs text-[color:var(--odos-faint)]">Searching…</p>}
          {error && <p role="alert" className="px-2 py-1 text-xs text-red-300">{error}</p>}
          {!loading && options.map((option) => (
            <button
              type="button"
              key={option.value}
              onClick={() => choose(option)}
              className="block w-full rounded px-2 py-2 text-left text-sm text-[color:var(--odos-text)] hover:bg-[color:var(--odos-accent-tint-lo)]"
            >
              <span className="block font-semibold">{option.label}</span>
              {option.description && <span className="mt-0.5 block text-xs text-[color:var(--odos-faint)]">{option.description}</span>}
            </button>
          ))}
          {onCreate && query.trim().length >= 2 && !value && (
            <button
              type="button"
              disabled={creating}
              onClick={() => void create()}
              className="mt-1 block w-full rounded border border-emerald-400/30 px-2 py-2 text-left text-sm font-semibold text-emerald-200 disabled:opacity-50"
            >
              {creating ? "Creating…" : `${createLabel} “${query.trim()}”`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
