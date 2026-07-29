import { OdosSelect } from "../inputs/OdosSelect";

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
  return (
    <OdosSelect
      value={value}
      options={options.map((option) => ({ value: option, label: formatOption(option) }))}
      defaultValue={defaultValue}
      onChange={onChange}
      onInputChange={onChange}
      inputMode="decimal"
      ariaLabel={ariaLabel}
      disabled={disabled}
    />
  );
}
