import { useState } from "react";
import {
  CustomFieldEditor,
  type CustomFieldEditorValue,
} from "./CustomFieldEditor";

export interface CustomSectionEditorValue {
  display: string;
  perEye: boolean;
  fields: CustomFieldEditorValue[];
}

export function CustomSectionEditor({ saving, onSave, onCancel }: {
  saving?: boolean;
  onSave(value: CustomSectionEditorValue): Promise<void> | void;
  onCancel(): void;
}) {
  const [display, setDisplay] = useState("");
  const [perEye, setPerEye] = useState(false);
  const [fields, setFields] = useState<CustomFieldEditorValue[]>([]);
  const [editingField, setEditingField] = useState<number | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    try {
      if (!display.trim()) throw new Error("Section title is required.");
      if (fields.length === 0) throw new Error("Add at least one field.");
      setError(null);
      await onSave({ display: display.trim(), perEye, fields });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function saveField(value: CustomFieldEditorValue) {
    setFields((current) => editingField === "new"
      ? [...current, value]
      : current.map((field, index) => index === editingField ? value : field));
    setEditingField(null);
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" role="dialog" aria-modal="true" aria-label="Create chart section">
      <div className="h-full w-full max-w-xl overflow-y-auto border-l border-white/15 bg-bg-panel p-6 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Create chart section</h2>
          <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-white/55 hover:bg-white/10">Close</button>
        </div>
        <div className="mt-6 space-y-5">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-white/40">Section title</span>
            <input value={display} onChange={(event) => setDisplay(event.target.value)} className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-white" />
          </label>
          <label className="flex items-center gap-3 rounded border border-white/10 bg-bg-deep/55 p-3 text-sm text-white/75">
            <input type="checkbox" checked={perEye} onChange={(event) => setPerEye(event.target.checked)} className="h-4 w-4 accent-brand" />
            Chart OD and OS independently
          </label>
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-wide text-white/40">Fields</div>
              <button type="button" onClick={() => setEditingField("new")} className="rounded border border-brand/60 px-3 py-2 text-sm text-brand-light hover:bg-brand/10">+ Add field</button>
            </div>
            <div className="mt-3 space-y-2">
              {fields.length === 0 && <div className="rounded border border-dashed border-white/10 p-4 text-sm text-white/35">No fields yet</div>}
              {fields.map((field, index) => (
                <div key={`${field.display}-${index}`} className="flex items-center gap-3 rounded border border-white/10 bg-bg-deep/55 px-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white/80">{field.display}</div>
                    <div className="mt-1 text-xs text-white/35">{field.valueType === "select" ? "Dropdown" : field.valueType === "multi-select" ? "Checkbox list" : field.unit ?? "Unitless number"}</div>
                  </div>
                  <button type="button" onClick={() => setEditingField(index)} className="rounded border border-white/15 px-2 py-1 text-xs text-white/65">Edit</button>
                  <button type="button" onClick={() => setFields((current) => current.filter((_, candidate) => candidate !== index))} className="rounded border border-red-300/20 px-2 py-1 text-xs text-red-200">Remove</button>
                </div>
              ))}
            </div>
          </div>
        </div>
        {error && <div className="mt-4 rounded border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{error}</div>}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded border border-white/15 px-4 py-2 text-sm text-white/65">Cancel</button>
          <button type="button" onClick={submit} disabled={saving} className="rounded bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Creating…" : "Create section"}</button>
        </div>
      </div>
      {editingField !== null && (
        <CustomFieldEditor
          title={editingField === "new" ? "Add section field" : `Edit ${fields[editingField]?.display ?? "field"}`}
          initial={editingField === "new" ? undefined : fields[editingField]}
          onCancel={() => setEditingField(null)}
          onSave={saveField}
        />
      )}
    </div>
  );
}
