interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}

const DISTANCE_VALUES = [
  "20/10", "20/12.5", "20/15", "20/16", "20/20", "20/25", "20/30", "20/32",
  "20/40", "20/50", "20/60", "20/63", "20/70", "20/80", "20/100", "20/125",
  "20/160", "20/200", "20/250", "20/320", "20/400", "20/500", "20/630", "20/800",
] as const;

const MODIFIERS = ["-3", "-2", "-1", "+1", "+2", "+3"] as const;

const LOW_VISION_VALUES = [
  "Counting Fingers 10ft", "Counting Fingers 9ft", "Counting Fingers 8ft",
  "Counting Fingers 7ft", "Counting Fingers 6ft", "Counting Fingers 5ft",
  "Counting Fingers 4ft", "Counting Fingers 3ft", "Counting Fingers 2ft",
  "Counting Fingers 1ft", "Hand Motion", "Light Perception", "No Light Perception",
  "Not Available", "No Improvement",
] as const;

const NEAR_VALUES = [
  "J1+ (20/20) 3pt 0.40M",
  "J1 (20/25) 4pt 0.50M",
  "J2 (20/30) 5pt 0.60M",
  "J3 (20/40) 6pt 0.80M",
  "J4 (20/50) 8pt 1.00M",
  "J5 (20/60) 10pt 1.20M",
  "J6 (20/70) 12pt 1.40M",
  "J7 (20/80) 14pt 1.60M",
  "J8 (20/100) 16pt 2.00M",
  "J9 (20/125) 20pt 2.50M",
] as const;

// VaSection can adopt this curated selector in a later slice without changing this refraction contract.
export function VaValueSelect({ value, onChange, disabled = false, ariaLabel }: Props) {
  const distanceBase = DISTANCE_VALUES.find((candidate) =>
    value === candidate || value.startsWith(`${candidate} `));
  const baseValue = distanceBase ?? value;
  const modifier = distanceBase && value !== distanceBase
    ? value.slice(distanceBase.length + 1)
    : "";

  function selectBase(nextBase: string) {
    if (!nextBase) {
      onChange("");
      return;
    }
    onChange(isDistanceValue(nextBase) && modifier ? `${nextBase} ${modifier}` : nextBase);
  }

  function selectModifier(nextModifier: string) {
    onChange(distanceBase ? `${distanceBase}${nextModifier ? ` ${nextModifier}` : ""}` : value);
  }

  return (
    <div className="flex min-w-[190px] gap-1">
      <select
        value={baseValue}
        onChange={(event) => selectBase(event.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        className="h-10 min-w-0 flex-1 rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none focus:border-brand disabled:opacity-45"
      >
        <option value="">Select</option>
        <optgroup label="Distance Snellen">
          {DISTANCE_VALUES.map((option) => <option key={option} value={option}>{option}</option>)}
        </optgroup>
        <optgroup label="Low vision">
          {LOW_VISION_VALUES.map((option) => <option key={option} value={option}>{option}</option>)}
        </optgroup>
        <optgroup label="Near (Jaeger)">
          {NEAR_VALUES.map((option) => <option key={option} value={option}>{option}</option>)}
        </optgroup>
      </select>
      <select
        value={modifier}
        onChange={(event) => selectModifier(event.target.value)}
        disabled={disabled || !distanceBase}
        aria-label={`${ariaLabel} modifier`}
        className="h-10 w-[62px] rounded border border-white/15 bg-bg-deep px-1 text-sm text-white outline-none focus:border-brand disabled:opacity-45"
      >
        <option value="">±</option>
        {MODIFIERS.map((option) => (
          <option key={option} value={option}>{option.replace("-", "−")}</option>
        ))}
      </select>
    </div>
  );
}

function isDistanceValue(value: string): boolean {
  return DISTANCE_VALUES.some((candidate) => candidate === value);
}
