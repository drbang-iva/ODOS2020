import type { Basic } from "@medplum/fhirtypes";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { CatalogFieldKit, type CatalogFieldDescriptor } from "../../components/settings/CatalogFields";
import { ConfirmDelete, ListHeader, RequiredGate } from "../../components/settings";
import {
  CatalogFieldValidationError,
  buildCatalogFields,
  parseCatalogFields,
} from "../../lib/catalog-field-kernel";
import type {
  CatalogAdapter,
  CatalogDraftTransaction,
  CatalogItemBase,
} from "../../lib/catalog-adapter";

export type CatalogDescriptor<Item extends CatalogItemBase> = {
  title: string;
  singularLabel: string;
  adapter: CatalogAdapter<Item>;
  fields: readonly CatalogFieldDescriptor[];
  createItem: () => Item;
  canCreate?: boolean;
  validateItem?: (item: Item, items: Item[]) => void;
  label: (item: Item) => string;
  facts?: (item: Item) => readonly string[];
  chips?: (item: Item) => readonly string[];
  color?: (item: Item) => string | undefined;
  readOnlyFacts?: (item: Item) => readonly { label: string; value: string }[];
  groupBy?: {
    label: string;
    value: (item: Item) => string;
    order?: (group: string) => number;
  };
  presetSeedOffer?: ReactNode;
  transaction?: CatalogDraftTransaction;
  immediateCommit?: boolean;
  listGrammar?: {
    searchPlaceholder?: string;
    searchText?: (item: Item) => string;
    deactivateConsequence: (item: Item) => string;
  };
};

export type CatalogInitialState<Item> = {
  items?: Item[];
  loading?: boolean;
  error?: string;
  selectedId?: string;
};

type CatalogSceneContextValue = {
  transaction?: CatalogDraftTransaction;
  revision: number;
  touch(): void;
};

const CatalogSceneContext = createContext<CatalogSceneContextValue | undefined>(undefined);

export function CatalogEditor<Item extends CatalogItemBase>({
  descriptor,
  canWrite,
  initialState,
}: {
  descriptor: CatalogDescriptor<Item>;
  canWrite: boolean;
  initialState?: CatalogInitialState<Item>;
}) {
  return (
    <CatalogScene title={descriptor.title} canWrite={canWrite} transaction={descriptor.transaction}>
      <CatalogSection descriptor={descriptor} canWrite={canWrite} initialState={initialState} hideTitle />
    </CatalogScene>
  );
}

export function CatalogScene({
  title,
  canWrite,
  transaction,
  children,
  onCommitted,
  onChanged,
}: {
  title: string;
  canWrite: boolean;
  transaction?: CatalogDraftTransaction;
  children: ReactNode;
  onCommitted?: (resource: Basic) => void;
  onChanged?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  function touch() {
    setRevision((current) => current + 1);
    onChanged?.();
  }

  async function commitTransaction() {
    if (!transaction) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await transaction.commit();
      touch();
      onCommitted?.(saved);
      setToast("Settings saved successfully.");
    } catch (commitError) {
      setError(errorMessage(commitError));
    } finally {
      setSaving(false);
    }
  }

  function discardTransaction() {
    if (!transaction) return;
    transaction.discard();
    touch();
    setToast("Draft changes discarded.");
  }

  return (
    <CatalogSceneContext.Provider value={{ transaction, revision, touch }}>
      <main className="min-h-screen bg-[#060610] p-6 pb-24 text-white">
        <div className="mx-auto max-w-5xl">
          <header className="mb-5">
            <div className="text-xs uppercase tracking-wide text-white/45">Practice Settings</div>
            <h1 className="text-2xl font-semibold">{title}</h1>
          </header>
          {error && (
            <div role="alert" className="mb-4 border border-red-400/40 bg-red-950/50 px-4 py-3 text-sm text-red-100">
              {error}
            </div>
          )}
          <div className="grid gap-8">{children}</div>
        </div>

        {transaction?.dirty && canWrite && (
          <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-end gap-2 border-t border-white/15 bg-[#10111c] px-6 py-3 shadow-2xl">
            <span className="mr-auto text-sm text-white/55">Unsaved settings changes</span>
            <button className="scheduler-button" type="button" disabled={saving} onClick={discardTransaction}>
              Discard
            </button>
            <button className="scheduler-button" type="button" disabled={saving} onClick={() => void commitTransaction()}>
              Save
            </button>
          </div>
        )}

        {toast && (
          <div role="status" className="fixed bottom-5 right-5 z-50 border border-emerald-300/30 bg-emerald-950 px-4 py-3 text-sm text-emerald-100 shadow-2xl">
            {toast}
          </div>
        )}
      </main>
    </CatalogSceneContext.Provider>
  );
}

export function CatalogSection<Item extends CatalogItemBase>({
  descriptor,
  canWrite,
  initialState,
  hideTitle = false,
}: {
  descriptor: CatalogDescriptor<Item>;
  canWrite: boolean;
  initialState?: CatalogInitialState<Item>;
  hideTitle?: boolean;
}) {
  const scene = useContext(CatalogSceneContext);
  const transaction = descriptor.immediateCommit
    ? undefined
    : scene?.transaction ?? descriptor.transaction;
  const [items, setItems] = useState<Item[]>(() => initialState?.items ?? []);
  const [loading, setLoading] = useState(initialState?.loading ?? initialState?.items === undefined);
  const [loadError, setLoadError] = useState<string | null>(initialState?.error ?? null);
  const [selected, setSelected] = useState<Item | null>(() =>
    initialState?.selectedId
      ? initialState.items?.find((item) => item.id === initialState.selectedId) ?? null
      : null,
  );
  const [draftFields, setDraftFields] = useState<Record<string, unknown>>(() =>
    selected ? parseCatalogFields(toRecord(selected), descriptor.fields) : {},
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedInactiveGroups, setExpandedInactiveGroups] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    setLoading(true);
    Promise.resolve(descriptor.adapter.list())
      .then((loaded) => {
        if (!cancelled) {
          setItems(loaded);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [descriptor, initialState, scene?.revision]);

  useEffect(() => {
    if (!initialState?.items) return;
    setItems(initialState.items);
    setLoading(initialState.loading ?? false);
    setLoadError(initialState.error ?? null);
  }, [initialState?.error, initialState?.items, initialState?.loading]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized || !descriptor.listGrammar) return items;
    return items.filter((item) => {
      const searchText = descriptor.listGrammar?.searchText?.(item)
        ?? [
          descriptor.label(item),
          ...(descriptor.facts?.(item) ?? []),
          ...(descriptor.chips?.(item) ?? []),
        ].join(" ");
      return searchText.toLocaleLowerCase().includes(normalized);
    });
  }, [descriptor, items, query]);
  const groups = useMemo(() => groupItems(visibleItems, descriptor), [descriptor, visibleItems]);

  function openEditor(item: Item) {
    setSelected(item);
    setDraftFields(parseCatalogFields(toRecord(item), descriptor.fields));
    setFieldErrors({});
  }

  function closeEditor() {
    setSelected(null);
    setDraftFields({});
    setFieldErrors({});
  }

  async function saveItem() {
    if (!selected) return;
    setSaving(true);
    setFieldErrors({});
    try {
      const built = buildCatalogFields(
        draftFields,
        descriptor.fields,
        items.map(toRecord),
        selected.id,
      );
      const next = { ...selected, ...built } as Item;
      descriptor.validateItem?.(next, items);
      const saved = await descriptor.adapter.save(next);
      setItems((current) => {
        const index = current.findIndex((item) => item.id === saved.id);
        return index === -1
          ? [...current, saved]
          : current.map((item) => (item.id === saved.id ? saved : item));
      });
      scene?.touch();
      closeEditor();
      setToast(transaction ? "Draft updated. Save all changes to commit." : "Saved successfully.");
    } catch (error) {
      if (error instanceof CatalogFieldValidationError) {
        setFieldErrors({ [error.fieldKey]: error.message });
      } else {
        setLoadError(errorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  }

  async function deactivateSelected() {
    if (!selected) return;
    setSaving(true);
    try {
      const saved = await descriptor.adapter.deactivate(selected);
      setItems((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      scene?.touch();
      closeEditor();
      setToast(transaction ? "Item deactivated in draft." : "Item deactivated.");
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function reorder(targetId: string) {
    if (!draggedId || draggedId === targetId || !descriptor.adapter.reorder) return;
    const next = [...items];
    const from = next.findIndex((item) => item.id === draggedId);
    const to = next.findIndex((item) => item.id === targetId);
    if (from === -1 || to === -1) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await descriptor.adapter.reorder(next.map((item) => item.id));
    setItems(next);
    setDraggedId(null);
    scene?.touch();
  }

  return (
    <section aria-label={`${descriptor.title} section`}>
      {descriptor.listGrammar ? (
        <ListHeader
          title={descriptor.title}
          searchValue={query}
          searchPlaceholder={descriptor.listGrammar.searchPlaceholder}
          newActionLabel={canWrite && descriptor.canCreate !== false ? `New ${descriptor.singularLabel}` : undefined}
          onSearchChange={setQuery}
          onNew={canWrite && descriptor.canCreate !== false ? () => openEditor(descriptor.createItem()) : undefined}
        />
      ) : (
        <header className="mb-3 flex items-center justify-between">
          {!hideTitle && <h2 className="text-lg font-semibold text-white/90">{descriptor.title}</h2>}
          {canWrite && descriptor.canCreate !== false && (
            <button className="scheduler-button" type="button" onClick={() => openEditor(descriptor.createItem())}>
              + Add {descriptor.singularLabel}
            </button>
          )}
        </header>
      )}

        {loadError && (
          <div role="alert" className="mb-4 border border-red-400/40 bg-red-950/50 px-4 py-3 text-sm text-red-100">
            {loadError}
          </div>
        )}

        {loading ? (
          <CatalogLoadingSkeleton />
        ) : items.length === 0 ? (
          <CatalogEmptyState
            title={`No ${descriptor.title.toLocaleLowerCase()} yet`}
            presetSeedOffer={descriptor.adapter.capabilities.presetSeed ? descriptor.presetSeedOffer : undefined}
          />
        ) : visibleItems.length === 0 ? (
          <div className="settings-list-no-results">No matches for “{query.trim()}”.</div>
        ) : (
          <div className="grid gap-4">
            {groups.map((group) => (
              <section key={group.name}>
                {descriptor.groupBy && group.hasActive && (
                  <h2 className="sticky top-0 z-10 border-b border-white/10 bg-[#060610]/95 px-2 py-2 text-xs font-semibold uppercase tracking-wide text-white/55 backdrop-blur">
                    {group.name}
                  </h2>
                )}
                {descriptor.groupBy && !group.hasActive && (
                  <button
                    type="button"
                    className="sticky top-0 z-10 flex w-full items-center justify-between border-b border-white/10 bg-[#060610]/95 px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-white/55 backdrop-blur"
                    aria-expanded={Boolean(query.trim()) || expandedInactiveGroups.has(group.name)}
                    onClick={() =>
                      setExpandedInactiveGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.name)) next.delete(group.name);
                        else next.add(group.name);
                        return next;
                      })
                    }
                  >
                    <span>{group.name}</span>
                    <span>{query.trim() || expandedInactiveGroups.has(group.name) ? "Collapse" : "Inactive · expand"}</span>
                  </button>
                )}
                {(group.hasActive || Boolean(query.trim()) || expandedInactiveGroups.has(group.name)) && (
                  <div className="grid gap-2 pt-2">
                  {group.items.map((item) => (
                    <CatalogRow
                      key={item.id}
                      item={item}
                      descriptor={descriptor}
                      canWrite={canWrite}
                      onOpen={() => openEditor(item)}
                      onDragStart={() => setDraggedId(item.id)}
                      onDrop={() => void reorder(item.id)}
                    />
                  ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      {canWrite && selected && (
        <CatalogEditorDrawer
          descriptor={descriptor}
          item={selected}
          values={draftFields}
          errors={fieldErrors}
          saving={saving}
          saveLabel={transaction ? "Apply to draft" : "Save"}
          useListGrammar={Boolean(descriptor.listGrammar)}
          onChange={(key, value) => setDraftFields((current) => ({ ...current, [key]: value }))}
          onSave={() => void saveItem()}
          onDeactivate={() => void deactivateSelected()}
          onClose={closeEditor}
        />
      )}

      {toast && (
        <div role="status" className="fixed bottom-5 right-5 z-50 border border-emerald-300/30 bg-emerald-950 px-4 py-3 text-sm text-emerald-100 shadow-2xl">
          {toast}
        </div>
      )}
    </section>
  );
}

function CatalogRow<Item extends CatalogItemBase>({
  item,
  descriptor,
  canWrite,
  onOpen,
  onDragStart,
  onDrop,
}: {
  item: Item;
  descriptor: CatalogDescriptor<Item>;
  canWrite: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const content = (
    <>
      <span className="h-full w-1 shrink-0" style={{ backgroundColor: descriptor.color?.(item) ?? "#666678" }} />
      {descriptor.adapter.capabilities.reorder && canWrite && (
        <span className="cursor-grab px-2 text-white/35" aria-label={`Reorder ${descriptor.label(item)}`}>
          ⋮⋮
        </span>
      )}
      <span className="min-w-0 flex-1 px-3 py-2">
        <span className="block truncate text-sm font-semibold text-white/90">{descriptor.label(item)}</span>
        {(descriptor.facts?.(item) ?? []).length > 0 && (
          <span className="mt-1 block text-xs text-white/45">{descriptor.facts?.(item).join(" · ")}</span>
        )}
        {(descriptor.chips?.(item) ?? []).length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {descriptor.chips?.(item).map((chip) => (
              <span key={chip} className="rounded-full bg-blue-400/10 px-2 py-0.5 text-[11px] text-blue-200">
                {chip}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className={`mr-3 rounded-full px-2 py-1 text-[11px] font-semibold uppercase ${
        item.active ? "bg-emerald-400/15 text-emerald-200" : "bg-white/10 text-white/45"
      }`}>
        {item.active ? "Active" : "Inactive"}
      </span>
    </>
  );

  const className = "flex min-h-14 items-stretch overflow-hidden border border-white/10 bg-white/[0.035] text-left";
  if (!canWrite) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      className={`${className} hover:border-white/25 hover:bg-white/[0.06]`}
      draggable={descriptor.adapter.capabilities.reorder}
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onClick={onOpen}
    >
      {content}
    </button>
  );
}

function CatalogEditorDrawer<Item extends CatalogItemBase>({
  descriptor,
  item,
  values,
  errors,
  saving,
  saveLabel,
  useListGrammar,
  onChange,
  onSave,
  onDeactivate,
  onClose,
}: {
  descriptor: CatalogDescriptor<Item>;
  item: Item;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  saving: boolean;
  saveLabel: string;
  useListGrammar: boolean;
  onChange: (key: string, value: unknown) => void;
  onSave: () => void;
  onDeactivate: () => void;
  onClose: () => void;
}) {
  const fieldId = (key: string) => `catalog-${slug(descriptor.title)}-${key}`;
  const requiredFields = descriptor.fields
    .filter((field) => field.required)
    .map((field) => ({ key: field.key, label: field.label }));

  return (
    <aside
      role="dialog"
      aria-label={`Edit ${descriptor.singularLabel}`}
      aria-modal="true"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md translate-x-0 flex-col border-l border-white/15 bg-[#0c0c18] shadow-2xl transition-transform duration-200"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <div className="text-xs uppercase text-white/45">{descriptor.singularLabel}</div>
          <span className="text-sm font-bold text-white">{descriptor.label(item) || `New ${descriptor.singularLabel}`}</span>
        </div>
        <button type="button" aria-label="Close editor" onClick={onClose} className="text-white/60 hover:text-white">
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {(descriptor.readOnlyFacts?.(item) ?? []).map((fact) => (
          <div key={fact.label} className="mb-4 grid gap-1">
            <div className="text-sm font-medium text-white/75">{fact.label}</div>
            <div className="scheduler-input bg-white/[0.03] text-white/45" aria-readonly="true">
              {fact.value}
            </div>
          </div>
        ))}
        <CatalogFieldKit
          fields={descriptor.fields}
          values={values}
          errors={errors}
          fieldId={useListGrammar ? fieldId : undefined}
          showRequired={useListGrammar}
          onChange={onChange}
        />
      </div>
      <footer className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
        {item.active && descriptor.adapter.capabilities.deactivate && (
          useListGrammar && descriptor.listGrammar ? (
            <ConfirmDelete
              actionLabel="Deactivate"
              confirmLabel="Deactivate"
              title={`Deactivate ${descriptor.label(item) || descriptor.singularLabel}?`}
              consequence={descriptor.listGrammar.deactivateConsequence(item)}
              disabled={saving}
              onConfirm={onDeactivate}
            />
          ) : (
            <button className="scheduler-button" type="button" disabled={saving} onClick={onDeactivate}>
              Deactivate
            </button>
          )
        )}
        {useListGrammar ? (
          <RequiredGate
            fields={requiredFields}
            values={values}
            fieldId={fieldId}
            saveLabel={saveLabel}
            saving={saving}
            onSave={onSave}
          />
        ) : (
          <button className="scheduler-button ml-auto" type="button" disabled={saving} onClick={onSave}>
            {saveLabel}
          </button>
        )}
      </footer>
    </aside>
  );
}

function CatalogLoadingSkeleton() {
  return (
    <div aria-label="Loading catalog" className="grid animate-pulse gap-2">
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-14 border border-white/10 bg-white/[0.05]" />
      ))}
    </div>
  );
}

function CatalogEmptyState({ title, presetSeedOffer }: { title: string; presetSeedOffer?: ReactNode }) {
  return (
    <section className="grid min-h-48 place-items-center border border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
      <div>
        <h2 className="font-semibold text-white/75">{title}</h2>
        <p className="mt-1 text-sm text-white/45">Add a custom item to start this catalog.</p>
        {presetSeedOffer && <div className="mt-4">{presetSeedOffer}</div>}
      </div>
    </section>
  );
}

function groupItems<Item extends CatalogItemBase>(items: Item[], descriptor: CatalogDescriptor<Item>) {
  if (!descriptor.groupBy) return [{ name: "All", items, hasActive: true }];
  const grouped = new Map<string, Item[]>();
  for (const item of items) {
    const group = descriptor.groupBy.value(item) || "Other";
    grouped.set(group, [...(grouped.get(group) ?? []), item]);
  }
  return [...grouped.entries()]
    .map(([name, groupItems]) => ({
      name,
      items: groupItems,
      hasActive: groupItems.some((item) => item.active),
    }))
    .sort((a, b) => {
      const byOrder =
        (descriptor.groupBy?.order?.(a.name) ?? Number.MAX_SAFE_INTEGER) -
        (descriptor.groupBy?.order?.(b.name) ?? Number.MAX_SAFE_INTEGER);
      return byOrder || a.name.localeCompare(b.name);
    });
}

function toRecord<Item extends CatalogItemBase>(item: Item): Record<string, unknown> {
  return item as unknown as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
