import type { ReactNode } from "react";
import { OdosSelect, type OdosSelectOption } from "./OdosSelect";

export interface MethodFieldProps<T> {
  label?: string;
  valueControl: ReactNode;
  methodValue: T;
  methodOptions: readonly OdosSelectOption<T>[];
  onMethodChange: (method: T) => void;
  methodAriaLabel: string;
  defaultMethod?: T;
  disabled?: boolean;
}

export function MethodField<T>({
  label,
  valueControl,
  methodValue,
  methodOptions,
  onMethodChange,
  methodAriaLabel,
  defaultMethod,
  disabled = false,
}: MethodFieldProps<T>) {
  return (
    <fieldset className="min-w-0 rounded border border-[color:var(--odos-line)] p-3">
      {label && <legend className="px-1 text-xs font-semibold text-[color:var(--odos-muted)]">{label}</legend>}
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <div className="min-w-0">{valueControl}</div>
        <div className="min-w-0">
          <OdosSelect
            value={methodValue}
            options={methodOptions}
            defaultValue={defaultMethod}
            onChange={onMethodChange}
            ariaLabel={methodAriaLabel}
            disabled={disabled}
          />
        </div>
      </div>
    </fieldset>
  );
}
