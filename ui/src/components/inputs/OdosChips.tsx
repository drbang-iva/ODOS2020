export interface OdosChipOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface OdosChipsProps<T> {
  options: readonly OdosChipOption<T>[];
  selected: readonly T[];
  onChange: (selected: T[]) => void;
  ariaLabel: string;
  disabled?: boolean;
  isEqual?: (left: T, right: T) => boolean;
}

export function OdosChips<T>({
  options,
  selected,
  onChange,
  ariaLabel,
  disabled = false,
  isEqual = Object.is,
}: OdosChipsProps<T>) {
  function toggle(value: T) {
    const isSelected = selected.some((item) => isEqual(item, value));
    onChange(isSelected
      ? selected.filter((item) => !isEqual(item, value))
      : [...selected, value]);
  }

  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const isSelected = selected.some((item) => isEqual(item, option.value));
        return (
          <button
            key={option.label}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled || option.disabled}
            onClick={() => toggle(option.value)}
            className={[
              "min-h-11 min-w-11 rounded border px-3 py-2 text-sm outline-none",
              isSelected
                ? "border-brand bg-brand/20 text-white"
                : "border-white/15 bg-bg-deep text-white/75 hover:bg-white/[0.06] focus-visible:border-brand",
              "disabled:opacity-45",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
