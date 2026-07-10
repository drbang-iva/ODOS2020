import { useEffect, useState } from "react";
import {
  CustomFieldEditor,
  type CustomFieldEditorValue,
} from "../components/charting/CustomFieldEditor";
import {
  CustomSectionEditor,
  type CustomSectionEditorValue,
} from "../components/charting/CustomSectionEditor";

interface CustomField extends CustomFieldEditorValue {
  localCode: string;
  origin: "practice";
  order: number;
  active: boolean;
}

interface FindingDefinition {
  stableKey: string;
  display: string;
  sectionKey?: string;
  active: boolean;
  perEye: boolean;
  fields: Record<string, { type?: string; allowCreate?: boolean }>;
  customFields: CustomField[];
}

interface CatalogResponse {
  canWrite: boolean;
  definitions: FindingDefinition[];
  error?: string;
}

export function ChartFieldsSettings() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [editing, setEditing] = useState<{ definition: FindingDefinition; field?: CustomField } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-definitions`, { headers: authHeaders() })
      .then(async (response) => {
        const body = await response.json() as CatalogResponse;
        if (!response.ok) throw new Error(body.error ?? `Finding-definition catalog failed: ${response.status}`);
        return body;
      })
      .then((body) => {
        setCatalog(body);
        setError(null);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function mutate(stableKey: string, body: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-definitions/${encodeURIComponent(stableKey)}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Finding-definition update failed: ${response.status}`);
      setEditing(null);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function saveEditor(value: CustomFieldEditorValue) {
    if (!editing) return;
    if (!editing.field) {
      await mutate(editing.definition.stableKey, { action: "create-custom-field", ...value });
      return;
    }
    await mutate(editing.definition.stableKey, {
      action: "update-custom-field",
      localCode: editing.field.localCode,
      display: value.display,
      unit: value.valueType === "number" ? value.unit ?? null : null,
      min: value.valueType === "number" ? value.min ?? null : null,
      max: value.valueType === "number" ? value.max ?? null : null,
      step: value.valueType === "number" ? value.step ?? null : null,
      ...(value.valueType === "select" ? { options: value.options } : {}),
    });
  }

  async function createSection(value: CustomSectionEditorValue) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-definitions`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-definition", ...value }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Section creation failed: ${response.status}`);
      setCreatingSection(false);
      load();
    } finally {
      setSaving(false);
    }
  }

  function runMutation(stableKey: string, body: Record<string, unknown>) {
    void mutate(stableKey, body).catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }

  return (
    <main className="min-h-screen bg-bg-deep p-6 text-white">
      <div className="mx-auto max-w-5xl">
        <div className="border-b border-white/10 pb-5">
          <div className="text-xs uppercase tracking-[0.18em] text-brand-light">Practice settings</div>
          <h1 className="mt-2 text-2xl font-semibold">Chart fields &amp; sections</h1>
          <p className="mt-1 text-sm text-white/45">Practice-authored fields use stable local codes. Deactivation hides capture without erasing history.</p>
        </div>
        {loading && <div className="mt-6 text-sm text-white/45">Loading chart definitions…</div>}
        {error && <div className="mt-6 rounded border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-200">{error}</div>}
        {!loading && catalog && (
          <div className="mt-6 space-y-4">
            {!catalog.canWrite && <div className="rounded border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">Read only. Practice-admin field-management grant required.</div>}
            <section className="rounded border border-white/10 bg-bg-panel/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="font-semibold">Sections</h2><p className="mt-1 text-sm text-white/40">Practice-created chart sections and their lifecycle</p></div>
                {catalog.canWrite && <button type="button" onClick={() => setCreatingSection(true)} className="rounded border border-brand/60 px-3 py-2 text-sm text-brand-light hover:bg-brand/10">+ Create section…</button>}
              </div>
              <div className="mt-4 space-y-2">
                {catalog.definitions.filter(isCustomSection).length === 0 && <div className="rounded border border-dashed border-white/10 p-3 text-sm text-white/35">No practice-created sections</div>}
                {catalog.definitions.filter(isCustomSection).map((definition) => (
                  <div key={definition.stableKey} className="flex flex-wrap items-center gap-3 rounded border border-white/10 bg-bg-deep/55 px-3 py-3">
                    <div className="min-w-0 flex-1"><div className={definition.active ? "text-sm text-white/80" : "text-sm text-white/35 line-through"}>{definition.display}</div><div className="mt-1 truncate font-mono text-xs text-white/30">{definition.stableKey}</div></div>
                    <span className="rounded bg-white/5 px-2 py-1 text-xs text-white/45">{definition.customFields.length} {definition.customFields.length === 1 ? "field" : "fields"}</span>
                    <span className="rounded bg-white/5 px-2 py-1 text-xs text-white/45">{definition.perEye ? "Per eye" : "Per record"}</span>
                    <span className={definition.active ? "rounded bg-emerald-400/10 px-2 py-1 text-xs text-emerald-200" : "rounded bg-white/5 px-2 py-1 text-xs text-white/35"}>{definition.active ? "Active" : "Inactive"}</span>
                    {catalog.canWrite && <>
                      <button type="button" onClick={() => {
                        const display = window.prompt("Section title", definition.display)?.trim();
                        if (display && display !== definition.display) runMutation(definition.stableKey, { action: "update-definition", display });
                      }} className="rounded border border-white/15 px-2 py-1 text-xs text-white/65">Rename</button>
                      {definition.active
                        ? <button type="button" onClick={() => runMutation(definition.stableKey, { action: "update-definition", active: false })} className="rounded border border-red-300/20 px-2 py-1 text-xs text-red-200">Deactivate</button>
                        : <button type="button" onClick={() => runMutation(definition.stableKey, { action: "update-definition", active: true })} className="rounded border border-emerald-300/20 px-2 py-1 text-xs text-emerald-200">Reactivate</button>}
                    </>}
                  </div>
                ))}
              </div>
            </section>
            <div className="pt-3 text-xs uppercase tracking-[0.18em] text-white/35">Fields by section</div>
            {catalog.definitions.filter((definition) => definition.active).map((definition) => {
              const picker = definition.fields.additionalFields;
              const canCreate = !picker || picker.allowCreate === true;
              return (
                <section key={definition.stableKey} className="rounded border border-white/10 bg-bg-panel/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><h2 className="font-semibold">{definition.display}</h2><div className="mt-1 font-mono text-xs text-white/35">{definition.stableKey}</div></div>
                    {catalog.canWrite && canCreate && <button type="button" onClick={() => setEditing({ definition })} className="rounded border border-brand/60 px-3 py-2 text-sm text-brand-light hover:bg-brand/10">+ Create field…</button>}
                    {catalog.canWrite && picker && !canCreate && <button type="button" onClick={() => runMutation(definition.stableKey, { action: "set-picker-config", allowCreate: true })} className="rounded border border-brand/60 px-3 py-2 text-sm text-brand-light hover:bg-brand/10">Enable field creation</button>}
                  </div>
                  <div className="mt-4 space-y-2">
                    {definition.customFields.length === 0 && <div className="rounded border border-dashed border-white/10 p-3 text-sm text-white/35">No practice-created fields</div>}
                    {definition.customFields.map((field, index) => (
                      <div key={field.localCode} className="flex flex-wrap items-center gap-3 rounded border border-white/10 bg-bg-deep/55 px-3 py-3">
                        <div className="min-w-0 flex-1"><div className={field.active ? "text-sm text-white/80" : "text-sm text-white/35 line-through"}>{field.display}</div><div className="mt-1 truncate font-mono text-xs text-white/30">{field.localCode}</div></div>
                        <span className="rounded bg-white/5 px-2 py-1 text-xs text-white/45">{field.valueType === "select" ? "Dropdown" : field.unit ?? "Unitless number"}</span>
                        {catalog.canWrite && <>
                          <button type="button" onClick={() => runMutation(definition.stableKey, { action: "update-custom-field", localCode: field.localCode, order: Math.max(0, field.order - 1) })} disabled={index === 0} className="rounded px-2 py-1 text-white/50 disabled:opacity-20">↑</button>
                          <button type="button" onClick={() => runMutation(definition.stableKey, { action: "update-custom-field", localCode: field.localCode, order: field.order + 1 })} disabled={index === definition.customFields.length - 1} className="rounded px-2 py-1 text-white/50 disabled:opacity-20">↓</button>
                          <button type="button" onClick={() => setEditing({ definition, field })} className="rounded border border-white/15 px-2 py-1 text-xs text-white/65">Edit</button>
                          {field.active
                            ? <button type="button" onClick={() => runMutation(definition.stableKey, { action: "update-custom-field", localCode: field.localCode, active: false })} className="rounded border border-red-300/20 px-2 py-1 text-xs text-red-200">Deactivate</button>
                            : <button type="button" onClick={() => runMutation(definition.stableKey, { action: "update-custom-field", localCode: field.localCode, active: true })} className="rounded border border-emerald-300/20 px-2 py-1 text-xs text-emerald-200">Reactivate</button>}
                        </>}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {editing && <CustomFieldEditor title={editing.field ? `Edit ${editing.field.display}` : `Create field in ${editing.definition.display}`} initial={editing.field} saving={saving} onCancel={() => setEditing(null)} onSave={saveEditor} />}
      {creatingSection && <CustomSectionEditor saving={saving} onCancel={() => setCreatingSection(false)} onSave={createSection} />}
    </main>
  );
}

function isCustomSection(definition: FindingDefinition): boolean {
  return definition.stableKey.startsWith("custom:") && definition.sectionKey === definition.stableKey;
}

function clinicalGraphApiBase(): string {
  return (import.meta.env.VITE_MCP_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:8103";
}

function authHeaders(): Record<string, string> {
  const token = window.localStorage.getItem("osod_access_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
