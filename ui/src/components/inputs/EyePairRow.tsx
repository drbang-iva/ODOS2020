import { useEffect, useRef } from "react";

export interface EyePairControlProps<T> {
  eye: "OD" | "OS";
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
}

export interface EyePairRowProps<T> {
  label?: string;
  odValue: T;
  osValue: T;
  onOdChange: (value: T) => void;
  onOsChange: (value: T) => void;
  renderControl: (props: EyePairControlProps<T>) => React.ReactNode;
  recordedOn: string;
  onRecordedOnChange: (value: string) => void;
  disabled?: boolean;
}

export function EyePairRow<T>({
  label,
  odValue,
  osValue,
  onOdChange,
  onOsChange,
  renderControl,
  recordedOn,
  onRecordedOnChange,
  disabled = false,
}: EyePairRowProps<T>) {
  const initialRecordedOn = useRef(recordedOn || currentLocalDateTime());
  const publishedInitial = useRef(Boolean(recordedOn));
  const displayedRecordedOn = recordedOn || initialRecordedOn.current;

  useEffect(() => {
    if (recordedOn) {
      publishedInitial.current = true;
      return;
    }
    if (disabled) return;
    if (publishedInitial.current) return;
    publishedInitial.current = true;
    onRecordedOnChange(initialRecordedOn.current);
  }, [disabled, onRecordedOnChange, recordedOn]);

  return (
    <fieldset disabled={disabled} className="min-w-0 rounded border border-[color:var(--odos-line)] p-3">
      {label && <legend className="px-1 text-xs font-semibold text-[color:var(--odos-muted)]">{label}</legend>}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-end">
        <div className="min-w-0">
          <p className="mb-2 text-xs font-semibold text-[color:var(--odos-muted)]">OD</p>
          {renderControl({ eye: "OD", value: odValue, onChange: onOdChange, disabled })}
        </div>
        <div className="flex gap-2 lg:flex-col">
          <button
            type="button"
            aria-label="Copy OD to OS"
            disabled={disabled}
            onClick={() => onOsChange(odValue)}
            className="min-h-11 min-w-11 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm text-[color:var(--odos-muted)] outline-none hover:bg-[var(--odos-surface-2)] focus-visible:border-brand disabled:opacity-45"
          >
            OD→OS
          </button>
          <button
            type="button"
            aria-label="Copy OS to OD"
            disabled={disabled}
            onClick={() => onOdChange(osValue)}
            className="min-h-11 min-w-11 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm text-[color:var(--odos-muted)] outline-none hover:bg-[var(--odos-surface-2)] focus-visible:border-brand disabled:opacity-45"
          >
            OS→OD
          </button>
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-xs font-semibold text-[color:var(--odos-muted)]">OS</p>
          {renderControl({ eye: "OS", value: osValue, onChange: onOsChange, disabled })}
        </div>
      </div>
      <label className="mt-3 block text-xs font-semibold text-[color:var(--odos-muted)]">
        Recorded On
        <input
          type="datetime-local"
          value={displayedRecordedOn}
          disabled={disabled}
          onChange={(event) => onRecordedOnChange(event.target.value)}
          className="mt-2 min-h-11 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-brand disabled:opacity-45"
        />
      </label>
    </fieldset>
  );
}

function currentLocalDateTime(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
