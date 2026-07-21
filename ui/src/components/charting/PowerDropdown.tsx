import { useEffect, useId, useRef, useState } from "react";

interface PowerDropdownProps {
  value: string;
  options: string[];
  defaultValue: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  formatOption?: (value: string) => string;
  disabled?: boolean;
}

export function PowerDropdown({
  value,
  options,
  defaultValue,
  onChange,
  ariaLabel,
  formatOption = (option) => option,
  disabled = false,
}: PowerDropdownProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => defaultIndex(options, defaultValue));
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    const index = defaultIndex(options, defaultValue);
    setActiveIndex(index);
    const frame = requestAnimationFrame(() => {
      optionRefs.current[index]?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [defaultValue, open, options]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function openAtDefault() {
    setActiveIndex(defaultIndex(options, defaultValue));
    setOpen(true);
  }

  function select(option: string) {
    onChange(option);
    setOpen(false);
  }

  function moveActive(delta: number) {
    if (!open) {
      openAtDefault();
      return;
    }
    setActiveIndex((current) => Math.min(options.length - 1, Math.max(0, current + delta)));
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div className="flex h-10 overflow-hidden rounded border border-white/15 bg-bg-deep focus-within:border-brand">
        <input
          type="text"
          inputMode="decimal"
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
          disabled={disabled}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            if (!open) openAtDefault();
          }}
          onClick={() => {
            if (!open) openAtDefault();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveActive(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              select(options[activeIndex]);
            } else if (event.key === "Escape") {
              setOpen(false);
            } else if (event.key === "Home" && open) {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End" && open) {
              event.preventDefault();
              setActiveIndex(options.length - 1);
            }
          }}
          className="min-w-0 flex-1 bg-transparent px-2 text-sm text-white outline-none disabled:opacity-45"
        />
        <button
          type="button"
          aria-label={`${ariaLabel} options`}
          aria-expanded={open}
          aria-controls={listboxId}
          disabled={disabled}
          onClick={() => open ? setOpen(false) : openAtDefault()}
          className="w-8 border-l border-white/10 text-xs text-white/55 hover:bg-white/[0.06] hover:text-white disabled:opacity-45"
        >
          ▾
        </button>
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-label={`${ariaLabel} options`}
        hidden={!open}
        className="absolute z-50 mt-1 max-h-64 w-full min-w-[110px] overflow-y-auto rounded border border-white/15 bg-bg-deep py-1 shadow-xl"
      >
        {options.map((option, index) => (
          <button
            key={option}
            ref={(node) => { optionRefs.current[index] = node; }}
            id={`${listboxId}-option-${index}`}
            type="button"
            role="option"
            aria-selected={value === option}
            data-default={option === defaultValue ? "true" : undefined}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => select(option)}
            className={[
              "block w-full px-3 py-1.5 text-left text-sm",
              index === activeIndex ? "bg-brand/20 text-white" : "text-white/75 hover:bg-white/[0.06]",
            ].join(" ")}
          >
            {formatOption(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function defaultIndex(options: string[], defaultValue: string): number {
  const index = options.indexOf(defaultValue);
  return index === -1 ? 0 : index;
}
