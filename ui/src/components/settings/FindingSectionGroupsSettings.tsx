import { useEffect, useState } from "react";
import {
  type FindingSectionGroup,
  type FindingSectionGroupCatalog,
} from "../../lib/finding-section-groups";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";

type Draft = {
  groupKey: string;
  label: string;
  prefixes: string;
  defaultForVisitTypeCategories: string[];
  active: boolean;
};

export function FindingSectionGroupsSettings() {
  const [catalog, setCatalog] = useState<FindingSectionGroupCatalog | null>(null);
  const [editing, setEditing] = useState<{ original?: FindingSectionGroup; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-section-groups`, {
      headers: authHeaders(),
    })
      .then(async (response) => {
        const body = await response.json() as FindingSectionGroupCatalog;
        if (!response.ok) throw new Error(body.error ?? `Section-group catalog failed: ${response.status}`);
        return body;
      })
      .then((body) => {
        setCatalog(body);
        setError(null);
      })
      .catch((caught) => setError(errorMessage(caught)));
  }

  useEffect(load, []);

  function edit(group: FindingSectionGroup) {
    setEditing({
      original: group,
      draft: {
        groupKey: group.groupKey,
        label: group.label,
        prefixes: group.sectionKeyPrefixes.join("\n"),
        defaultForVisitTypeCategories: group.defaultForVisitTypeCategories,
        active: group.active,
      },
    });
  }

  function create() {
    setEditing({
      draft: {
        groupKey: "",
        label: "",
        prefixes: "",
        defaultForVisitTypeCategories: [],
        active: true,
      },
    });
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        ...editing.draft,
        sectionKeyPrefixes: editing.draft.prefixes
          .split(/[\n,]+/)
          .map((prefix) => prefix.trim())
          .filter(Boolean),
      };
      const endpoint = editing.original
        ? `${clinicalGraphApiBase()}/clinical-graph/finding-section-groups/${encodeURIComponent(editing.original.groupKey)}`
        : `${clinicalGraphApiBase()}/clinical-graph/finding-section-groups`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(editing.original
          ? {
              label: body.label,
              sectionKeyPrefixes: body.sectionKeyPrefixes,
              defaultForVisitTypeCategories: body.defaultForVisitTypeCategories,
              active: body.active,
            }
          : {
              groupKey: body.groupKey,
              label: body.label,
              sectionKeyPrefixes: body.sectionKeyPrefixes,
              defaultForVisitTypeCategories: body.defaultForVisitTypeCategories,
              active: body.active,
            }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Section-group save failed: ${response.status}`);
      setEditing(null);
      load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function setActive(group: FindingSectionGroup, active: boolean) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/finding-section-groups/${encodeURIComponent(group.groupKey)}`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ active }),
        },
      );
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Section-group update failed: ${response.status}`);
      load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="rounded border border-[color:var(--odos-line)] bg-bg-panel/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Visit-type section groups</h2>
            <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Gate specialty section prefixes by visit-type category while leaving ungrouped sections unchanged.</p>
          </div>
          {catalog?.canWrite && (
            <button
              type="button"
              onClick={create}
              className="rounded border border-brand/60 px-3 py-2 text-sm text-brand-light hover:bg-brand/10"
            >
              + Create group…
            </button>
          )}
        </div>
        {error && (
          <div role="alert" className="mt-4 rounded border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">
            {error}
          </div>
        )}
        {!catalog && !error && <div className="mt-4 text-sm text-[color:var(--odos-faint)]">Loading section groups…</div>}
        {catalog && (
          <div className="mt-4 space-y-2">
            {!catalog.canWrite && (
              <div className="rounded border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-100">
                Read only. Practice-admin field-management grant required.
              </div>
            )}
            {catalog.groups.length === 0 && (
              <div className="rounded border border-dashed border-[color:var(--odos-line)] p-3 text-sm text-[color:var(--odos-faint)]">
                No visit-type section groups
              </div>
            )}
            {catalog.groups.map((group) => (
              <div
                key={group.groupKey}
                className="flex flex-wrap items-center gap-3 rounded border border-[color:var(--odos-line)] bg-bg-deep/55 px-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className={group.active ? "text-sm text-[color:var(--odos-text)]" : "text-sm text-[color:var(--odos-faint)] line-through"}>
                    {group.label}
                  </div>
                  <div className="mt-1 font-mono text-xs text-[color:var(--odos-faint)]">{group.groupKey}</div>
                  <div className="mt-1 text-xs text-[color:var(--odos-muted)]">{group.sectionKeyPrefixes.join(", ")}</div>
                </div>
                <span className="rounded bg-[color:var(--odos-surface-2)] px-2 py-1 text-xs text-[color:var(--odos-muted)]">
                  {group.defaultForVisitTypeCategories.length > 0
                    ? group.defaultForVisitTypeCategories.join(", ")
                    : "No defaults"}
                </span>
                <span className={group.active
                  ? "rounded bg-emerald-400/10 px-2 py-1 text-xs text-emerald-200"
                  : "rounded bg-[color:var(--odos-surface-2)] px-2 py-1 text-xs text-[color:var(--odos-faint)]"}
                >
                  {group.active ? "Active" : "Inactive"}
                </span>
                {catalog.canWrite && (
                  <>
                    <button
                      type="button"
                      onClick={() => edit(group)}
                      className="rounded border border-[color:var(--odos-line-2)] px-2 py-1 text-xs text-[color:var(--odos-muted)]"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void setActive(group, !group.active)}
                      className={group.active
                        ? "rounded border border-red-300/20 px-2 py-1 text-xs text-red-200"
                        : "rounded border border-emerald-300/20 px-2 py-1 text-xs text-emerald-200"}
                    >
                      {group.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color:color-mix(in_srgb,var(--odos-ground)_70%,transparent)] p-4">
          <form
            aria-label={editing.original ? "Edit section group" : "Create section group"}
            className="w-full max-w-xl rounded border border-[color:var(--odos-line-2)] bg-bg-panel p-5 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="text-xs uppercase tracking-[0.18em] text-brand-light">Section visibility</div>
            <h2 className="mt-2 text-xl font-semibold">{editing.original ? `Edit ${editing.original.label}` : "Create section group"}</h2>
            <label className="mt-5 block text-sm text-[color:var(--odos-muted)]">
              Group key
              <input
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                disabled={Boolean(editing.original)}
                value={editing.draft.groupKey}
                onChange={(event) => setEditing({
                  ...editing,
                  draft: { ...editing.draft, groupKey: event.target.value },
                })}
                className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 py-2 font-mono text-sm disabled:text-[color:var(--odos-faint)]"
              />
            </label>
            <label className="mt-4 block text-sm text-[color:var(--odos-muted)]">
              Label
              <input
                required
                value={editing.draft.label}
                onChange={(event) => setEditing({
                  ...editing,
                  draft: { ...editing.draft, label: event.target.value },
                })}
                className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 py-2 text-sm"
              />
            </label>
            <label className="mt-4 block text-sm text-[color:var(--odos-muted)]">
              Section-key prefixes
              <textarea
                required
                rows={3}
                value={editing.draft.prefixes}
                onChange={(event) => setEditing({
                  ...editing,
                  draft: { ...editing.draft, prefixes: event.target.value },
                })}
                placeholder="dry-eye:"
                className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 py-2 font-mono text-sm"
              />
              <span className="mt-1 block text-xs text-[color:var(--odos-faint)]">One per line or comma-separated.</span>
            </label>
            <fieldset className="mt-4">
              <legend className="text-sm text-[color:var(--odos-muted)]">Default visit-type categories</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(catalog?.visitTypeCategories ?? []).filter((category) => category.active !== false).map((category) => (
                  <label key={category.id} className="flex items-center gap-2 rounded border border-[color:var(--odos-line)] px-3 py-2 text-sm text-[color:var(--odos-muted)]">
                    <input
                      type="checkbox"
                      checked={editing.draft.defaultForVisitTypeCategories.includes(category.id)}
                      onChange={(event) => setEditing({
                        ...editing,
                        draft: {
                          ...editing.draft,
                          defaultForVisitTypeCategories: event.target.checked
                            ? [...editing.draft.defaultForVisitTypeCategories, category.id]
                            : editing.draft.defaultForVisitTypeCategories.filter((id) => id !== category.id),
                        },
                      })}
                    />
                    {category.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="mt-4 flex items-center gap-2 text-sm text-[color:var(--odos-muted)]">
              <input
                type="checkbox"
                checked={editing.draft.active}
                onChange={(event) => setEditing({
                  ...editing,
                  draft: { ...editing.draft, active: event.target.checked },
                })}
              />
              Active
            </label>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditing(null)}
                className="rounded border border-[color:var(--odos-line-2)] px-3 py-2 text-sm text-[color:var(--odos-muted)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded bg-brand px-4 py-2 text-sm font-medium text-[color:var(--odos-accent-ink)] disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save group"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
