import type { ReactNode } from "react";

export type RequiredField = {
  key: string;
  label: string;
};

export function RequiredGate({
  fields,
  values,
  fieldId,
  saveLabel = "Save",
  saving = false,
  onSave,
}: {
  fields: readonly RequiredField[];
  values: Record<string, unknown>;
  fieldId: (key: string) => string;
  saveLabel?: string;
  saving?: boolean;
  onSave: () => void;
}) {
  const missing = fields.filter((field) => !hasRequiredValue(values[field.key]));

  function jumpToFirstMissing() {
    const first = missing[0];
    if (!first || typeof document === "undefined") return;
    document.getElementById(fieldId(first.key))?.focus();
  }

  return (
    <div className="settings-required-gate">
      {missing.length > 0 && (
        <button type="button" className="settings-required-jump" onClick={jumpToFirstMissing}>
          {missing.length} required {missing.length === 1 ? "field remains" : "fields remain"} — jump to it
        </button>
      )}
      <button
        className="scheduler-button settings-primary-action"
        type="button"
        disabled={saving || missing.length > 0}
        onClick={onSave}
      >
        {saveLabel}
      </button>
    </div>
  );
}

export function RequiredFieldLabel({
  required,
  children,
}: {
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {children}
      {required && (
        <>
          <span className="settings-required-dot" aria-hidden="true" />
          <span className="sr-only"> (required)</span>
        </>
      )}
    </>
  );
}

export function hasRequiredValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined && value !== null;
}
