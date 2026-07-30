export interface NumericDefinitionField {
  minimum?: number;
  maximum?: number;
  step?: number;
}

export function numericOptions(
  field: NumericDefinitionField | undefined,
  fallbackMinimum: number,
  fallbackMaximum: number,
  fallbackStep: number,
): string[] {
  const minimum = field?.minimum ?? fallbackMinimum;
  const maximum = field?.maximum ?? fallbackMaximum;
  const step = field?.step ?? fallbackStep;
  const count = Math.round((maximum - minimum) / step);
  return Array.from({ length: count + 1 }, (_, index) => {
    const value = minimum + index * step;
    return (Math.abs(value) < 1e-9 ? 0 : value).toFixed(step < 1 ? 2 : 0);
  });
}

export function formatPowerOption(value: number): string {
  if (value === 0) return "Plano";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function formatSpherePower(value: number): string {
  if (value === 0) return "pl";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}`;
}
