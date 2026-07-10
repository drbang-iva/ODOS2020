import { useState } from "react";

export interface CustomFieldEditorValue {
  display: string;
  valueType: "number" | "select";
  unit?: "[diop]" | "mm" | "um" | "ms" | "%" | "deg" | "mJ" | "nm";
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ code: string; display: string; active: boolean }>;
}

export function CustomFieldEditor({ title = "Create field", initial, saving, onSave, onCancel }: {
  title?: string;
  initial?: CustomFieldEditorValue;
  saving?: boolean;
  onSave(value: CustomFieldEditorValue): Promise<void> | void;
  onCancel(): void;
}) {
  const [display, setDisplay] = useState(initial?.display ?? "");
  const [valueType, setValueType] = useState<"number" | "select">(initial?.valueType ?? "number");
  const [unit, setUnit] = useState<CustomFieldEditorValue["unit"] | "">(initial?.unit ?? "");
  const [min, setMin] = useState(initial?.min?.toString() ?? "");
  const [max, setMax] = useState(initial?.max?.toString() ?? "");
  const [step, setStep] = useState(initial?.step?.toString() ?? "");
  const [options, setOptions] = useState(initial?.options?.map((option) => `${option.code} | ${option.display}`).join("\n") ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    try {
      if (!display.trim()) throw new Error("Field label is required.");
      const value: CustomFieldEditorValue = {
        display: display.trim(),
        valueType,
        ...(valueType === "number" && unit ? { unit } : {}),
        ...(valueType === "number" && min ? { min: finiteNumber(min, "Minimum") } : {}),
        ...(valueType === "number" && max ? { max: finiteNumber(max, "Maximum") } : {}),
        ...(valueType === "number" && step ? { step: positiveNumber(step, "Step") } : {}),
        ...(valueType === "select" ? { options: parseOptions(options) } : {}),
      };
      setError(null);
      await onSave(value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" role="dialog" aria-modal="true" aria-label={title}>
      <div className="h-full w-full max-w-lg overflow-y-auto border-l border-white/15 bg-bg-panel p-6 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-white/55 hover:bg-white/10">Close</button>
        </div>
        <div className="mt-6 space-y-4">
          <EditorInput label="Label" value={display} onChange={setDisplay} />
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-white/40">Type</span>
            <select value={valueType} disabled={Boolean(initial)} onChange={(event) => setValueType(event.target.value as "number" | "select")} className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-white disabled:opacity-50">
              <option value="number">Number</option>
              <option value="select">Dropdown</option>
            </select>
          </label>
          {valueType === "number" ? (
            <>
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-wide text-white/40">Unit</span>
                <select value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)} className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-white">
                  <option value="">Unitless</option>
                  {["[diop]", "mm", "um", "ms", "%", "deg", "mJ", "nm"].map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-3 gap-3">
                <EditorInput label="Minimum" value={min} onChange={setMin} inputMode="decimal" />
                <EditorInput label="Maximum" value={max} onChange={setMax} inputMode="decimal" />
                <EditorInput label="Step" value={step} onChange={setStep} inputMode="decimal" />
              </div>
            </>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-white/40">Options, one per line</span>
              <textarea value={options} onChange={(event) => setOptions(event.target.value)} rows={8} placeholder={'Low\nMedium\nHigh'} className="w-full rounded border border-white/15 bg-bg-deep p-3 text-white" />
              {initial && <span className="mt-1 block text-xs text-white/35">Keep each code before the | unchanged; edit the label after it.</span>}
            </label>
          )}
        </div>
        {error && <div className="mt-4 rounded border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{error}</div>}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded border border-white/15 px-4 py-2 text-sm text-white/65">Cancel</button>
          <button type="button" onClick={submit} disabled={saving} className="rounded bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save field"}</button>
        </div>
      </div>
    </div>
  );
}

function EditorInput({ label, value, onChange, inputMode }: {
  label: string;
  value: string;
  onChange(value: string): void;
  inputMode?: "decimal";
}) {
  return <label className="block"><span className="mb-1 block text-xs uppercase tracking-wide text-white/40">{label}</span><input value={value} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-white" /></label>;
}

function parseOptions(value: string): Array<{ code: string; display: string; active: boolean }> {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("Dropdown fields require at least one option.");
  const options = lines.map((line) => {
    const separator = line.indexOf("|");
    const code = separator >= 0 ? line.slice(0, separator).trim() : slug(line);
    const display = separator >= 0 ? line.slice(separator + 1).trim() : line;
    if (!code || !display) throw new Error("Each dropdown option needs both a code and label.");
    return { code, display, active: true };
  });
  if (new Set(options.map((option) => option.code)).size !== options.length) {
    throw new Error("Dropdown option labels must produce distinct codes.");
  }
  return options;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "option";
}

function finiteNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
  return parsed;
}

function positiveNumber(value: string, label: string): number {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be greater than zero.`);
  return parsed;
}
