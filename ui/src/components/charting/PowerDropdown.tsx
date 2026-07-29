import { useMemo } from "react";
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

const defaultFormatOption = (option: string) => option;

export function PowerDropdown({
  value,
  options,
  defaultValue,
  onChange,
  ariaLabel,
  formatOption = defaultFormatOption,
  disabled = false,
}: PowerDropdownProps) {
  const selectOptions = useMemo(
    () => options.map((option) => ({ value: option, label: formatOption(option) })),
    [formatOption, options],
  );

  return (
    <OdosSelect
      value={value}
      options={selectOptions}
      defaultValue={defaultValue}
      onChange={onChange}
      onInputChange={onChange}
      parseInput={(input) => input}
      serializeValue={(option) => option}
      inputMode="decimal"
      ariaLabel={ariaLabel}
      disabled={disabled}
    />
  );
}
