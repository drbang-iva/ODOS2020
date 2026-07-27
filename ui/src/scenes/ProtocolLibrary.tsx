import { useEffect, useRef, useState } from "react";
import { ProtocolStagingList } from "../components/charting/ProtocolStagingList";
import {
  APPEARANCE_ACCENTS,
  APPEARANCE_SURFACES,
  applyAppearance,
  type AppearanceAccent,
  type AppearanceSurface,
} from "../lib/appearance";
import { DIAGNOSIS_VISIT_STATUSES } from "../lib/clinical-graph-client";
import {
  createProtocolDraft,
  editableProtocolDraft,
  forkProtocol,
  loadProtocolLibrary,
  publishProtocol,
  retireProtocol,
  saveProtocolDraft,
  type LateralityMode,
  type ProtocolDefinition,
  type ProtocolDraft,
  type ProtocolItem,
  type ProtocolItemType,
  type ProtocolLibraryResponse,
  type ProtocolValidationIssue,
} from "../lib/protocol-authoring";

const FIELD_CLASS =
  "h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)] disabled:opacity-50";
const TEXTAREA_CLASS =
  "w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] p-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)] disabled:opacity-50";
const BUTTON_CLASS =
  "rounded border border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-hi)] px-3 py-2 text-sm font-semibold text-[color:var(--odos-text)] transition hover:bg-[color:var(--odos-accent-tint-lo)] disabled:cursor-not-allowed disabled:opacity-45";

export function ProtocolLibrary() {
  const [library, setLibrary] = useState<ProtocolLibraryResponse>();
  const [error, setError] = useState<string>();
  const [, setNavigationVersion] = useState(0);
  const selectedId = new URLSearchParams(window.location.search).get("protocol");

  async function load() {
    setLibrary(await loadProtocolLibrary());
  }

  useEffect(() => {
    void load().catch((reason) => setError(message(reason)));
  }, []);

  useEffect(() => {
    const refresh = () => {
      setNavigationVersion((current) => current + 1);
      void load().catch((reason) => setError(message(reason)));
    };
    window.addEventListener("odos:protocol-navigation", refresh);
    return () => window.removeEventListener("odos:protocol-navigation", refresh);
  }, []);

  async function createBlank() {
    setError(undefined);
    try {
      const result = await createProtocolDraft({ title: "Untitled protocol" });
      setLibrary((current) => current ? {
        ...current,
        protocols: [...current.protocols, result.protocol],
      } : current);
      openProtocol(result.protocol.id);
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function copy(protocol: ProtocolDefinition) {
    setError(undefined);
    try {
      const result = await forkProtocol(protocol.id, `Copy of ${protocol.title}`);
      setLibrary((current) => current ? {
        ...current,
        protocols: [...current.protocols, result.protocol],
      } : current);
      openProtocol(result.protocol.id);
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function retire(protocol: ProtocolDefinition) {
    setError(undefined);
    try {
      await retireProtocol(protocol.id);
      await load();
    } catch (reason) {
      setError(message(reason));
    }
  }

  if (!library) return <ProtocolState error={error} />;
  const selected = selectedId ? library.protocols.find((row) => row.id === selectedId) : undefined;
  if (selectedId && !selected) return <ProtocolState error="Protocol definition not found." />;
  if (selected) {
    return (
      <ProtocolBuilder
        protocol={selected}
        catalogs={library.catalogs}
        onPublished={() => void load()}
      />
    );
  }

  const groups = groupProtocols(library.protocols);
  return (
    <main className="min-h-full bg-[color:var(--odos-ground)] px-5 py-6 text-[color:var(--odos-text)] md:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[color:var(--odos-line)] pb-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--odos-accent)]">
              Clinical authoring
            </div>
            <h1 className="mt-1 text-3xl font-semibold">Protocol Library</h1>
            <p className="mt-2 max-w-2xl text-sm text-[color:var(--odos-muted)]">
              Build diagnosis-triggered chart, plan, order, education, follow-up, and charge defaults.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ProtocolThemeToggle />
            <button type="button" className={BUTTON_CLASS} onClick={() => void createBlank()}>
              New Protocol
            </button>
          </div>
        </header>

        {error && <ProtocolError>{error}</ProtocolError>}
        {groups.length === 0 ? (
          <div className="mt-6 rounded border border-dashed border-[color:var(--odos-line-2)] p-8 text-sm text-[color:var(--odos-muted)]">
            No protocols are visible yet.
          </div>
        ) : (
          <div className="mt-6 space-y-7">
            {groups.map(([family, protocols]) => (
              <section key={family}>
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-[color:var(--odos-muted)]">
                    {family}
                  </h2>
                  <span className="h-px flex-1 bg-[color:var(--odos-line)]" />
                </div>
                <div className="grid gap-3">
                  {protocols.map((protocol) => (
                    <ProtocolLibraryRow
                      key={protocol.id}
                      protocol={protocol}
                      onCopy={() => void copy(protocol)}
                      onRetire={() => void retire(protocol)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function ProtocolLibraryRow({
  protocol,
  onCopy,
  onRetire,
}: {
  protocol: ProtocolDefinition;
  onCopy: () => void;
  onRetire: () => void;
}) {
  const draft = protocol.draft;
  const display = draft ?? protocol;
  const tally = itemTally(display.items);
  const followUp = display.items.find((row) => row.itemType === "follow-up");
  return (
    <article className="grid gap-4 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4 shadow-[var(--odos-shadow-card)] lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-base font-semibold">{display.title}</h3>
          <StatusChip status={protocol.status} hasDraft={Boolean(draft)} />
          <span className="text-xs text-[color:var(--odos-muted)]">v{protocol.version}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-[color:var(--odos-muted)]">
          <span>{statusScopeLabel(display.trigger)}</span>
          <span>Owner: {display.ownership.ownerId}</span>
          <span>{display.ownership.sharing}</span>
          <span>{protocol.authoring?.origin ?? "legacy import"}</span>
        </div>
      </div>
      <div className="text-xs text-[color:var(--odos-muted)]">
        <div>{tally}</div>
        <div className="mt-1">{followUp ? followUpLabel(followUp) : "No follow-up interval"}</div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={BUTTON_CLASS} onClick={() => openProtocol(protocol.id)}>Open</button>
        <button type="button" className={BUTTON_CLASS} onClick={onCopy}>Copy</button>
        {protocol.status !== "retired" && (
          <button type="button" className={BUTTON_CLASS} onClick={onRetire}>Retire</button>
        )}
      </div>
    </article>
  );
}

export function ProtocolBuilder({
  protocol,
  catalogs,
  onPublished,
}: {
  protocol: ProtocolDefinition;
  catalogs: ProtocolLibraryResponse["catalogs"];
  onPublished: () => void;
}) {
  const [draft, setDraft] = useState(() => editableProtocolDraft(protocol));
  const [validation, setValidation] = useState<ProtocolValidationIssue[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState<string>();
  const [newItemType, setNewItemType] = useState<ProtocolItemType>("finding-seed");
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lastSaveError = useRef<unknown>();
  const initialized = useRef(false);

  function updateDraft(next: ProtocolDraft) {
    setDraft(next);
    setSaveState("saving");
    lastSaveError.current = undefined;
    queue.current = queue.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await saveProtocolDraft(protocol.id, next);
        lastSaveError.current = undefined;
        setValidation(saved.validation);
        setSaveState("saved");
      })
      .catch((reason) => {
        lastSaveError.current = reason;
        setSaveState("error");
        setError(message(reason));
      });
  }

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (!protocol.draft) updateDraft(editableProtocolDraft(protocol));
  }, []);

  function updateItem(index: number, item: ProtocolItem) {
    updateDraft({ ...draft, items: draft.items.map((row, rowIndex) => rowIndex === index ? item : row) });
  }

  function addItem() {
    updateDraft({ ...draft, items: [...draft.items, blankItem(newItemType, draft.items)] });
  }

  function removeItem(index: number) {
    updateDraft({ ...draft, items: draft.items.filter((_, rowIndex) => rowIndex !== index) });
  }

  function moveItem(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= draft.items.length) return;
    const items = [...draft.items];
    [items[index], items[target]] = [items[target]!, items[index]!];
    updateDraft({ ...draft, items });
  }

  async function publish() {
    setError(undefined);
    try {
      await queue.current;
      if (lastSaveError.current) throw lastSaveError.current;
      await publishProtocol(protocol.id);
      onPublished();
      closeProtocol();
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function leave() {
    setError(undefined);
    await queue.current;
    if (lastSaveError.current) {
      setError(message(lastSaveError.current));
      return;
    }
    closeProtocol();
  }

  return (
    <main className="min-h-full bg-[color:var(--odos-ground)] p-4 text-[color:var(--odos-text)] md:p-6">
      <div className="mx-auto max-w-[1500px]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--odos-line)] pb-4">
          <div className="flex items-center gap-3">
            <button type="button" className={BUTTON_CLASS} onClick={() => void leave()}>← Library</button>
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--odos-accent)]">Protocol builder</div>
              <h1 className="text-xl font-semibold">{draft.title}</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              role="status"
              className={saveState === "error" ? "text-xs text-[color:var(--odos-alert)]" : "text-xs text-[color:var(--odos-muted)]"}
            >
              {saveState === "saving" ? "Autosaving…" : saveState === "saved" ? "All edits saved" : "Autosave failed"}
            </span>
            <ProtocolThemeToggle />
            <button type="button" className={BUTTON_CLASS} onClick={() => void publish()}>
              Publish v{protocol.version + 1}
            </button>
          </div>
        </header>

        {error && <ProtocolError>{error}</ProtocolError>}
        {validation.length > 0 && (
          <div className="mt-4 rounded border border-[color:var(--odos-amber)] bg-[color:var(--odos-surface)] p-3 text-sm text-[color:var(--odos-amber)]">
            <div className="font-semibold">Publish checks</div>
            <ul className="mt-1 list-disc pl-5">
              {validation.map((issue, index) => <li key={`${issue.reason}-${issue.itemKey ?? index}`}>{issue.message}</li>)}
            </ul>
          </div>
        )}

        <div className="mt-5 grid gap-5 xl:grid-cols-[330px_minmax(480px,1fr)_390px]">
          <MetadataPanel draft={draft} onChange={updateDraft} />
          <section className="min-w-0 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Protocol sections</h2>
                <p className="text-xs text-[color:var(--odos-muted)]">Add, remove, reorder, and define every staged row.</p>
              </div>
              <div className="flex gap-2">
                <select
                  aria-label="New item type"
                  className={FIELD_CLASS}
                  value={newItemType}
                  onChange={(event) => setNewItemType(event.target.value as ProtocolItemType)}
                >
                  {ITEM_TYPES.map((type) => <option key={type} value={type}>{itemTypeLabel(type)}</option>)}
                </select>
                <button type="button" className={BUTTON_CLASS} onClick={addItem}>Add item</button>
              </div>
            </div>
            <div className="mt-4 space-y-4">
              {draft.items.length === 0 ? (
                <div className="rounded border border-dashed border-[color:var(--odos-line-2)] p-6 text-sm text-[color:var(--odos-muted)]">
                  Add at least one item before publishing.
                </div>
              ) : draft.items.map((item, index) => (
                <ItemEditor
                  key={`${item.itemKey}-${index}`}
                  item={item}
                  index={index}
                  count={draft.items.length}
                  catalogs={catalogs}
                  onChange={(next) => updateItem(index, next)}
                  onMove={(offset) => moveItem(index, offset)}
                  onRemove={() => removeItem(index)}
                />
              ))}
            </div>
          </section>
          <aside className="self-start rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-4 xl:sticky xl:top-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--odos-accent)]">Live apply preview</div>
            <h2 className="mt-1 font-semibold">{draft.title}</h2>
            <p className="mt-1 text-xs text-[color:var(--odos-muted)]">The same staged-row renderer clinicians see at apply time.</p>
            <div className="mt-4">
              <ProtocolStagingList
                items={draft.items}
                selections={Object.fromEntries(draft.items.map((item) => [item.itemKey, item.defaultSelected]))}
                preview
              />
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function MetadataPanel({ draft, onChange }: { draft: ProtocolDraft; onChange: (draft: ProtocolDraft) => void }) {
  const diagnosisTrigger = draft.trigger.kind === "diagnosis" ? draft.trigger : { kind: "diagnosis" as const, dxKeys: [] };
  return (
    <aside className="self-start rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4 xl:sticky xl:top-4">
      <h2 className="font-semibold">Metadata</h2>
      <div className="mt-4 space-y-4">
        <Field label="Title">
          <input className={FIELD_CLASS} value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
        </Field>
        <Field label="Trigger">
          <select
            className={FIELD_CLASS}
            value={draft.trigger.kind}
            onChange={(event) => onChange({
              ...draft,
              trigger: event.target.value === "visit-type"
                ? { kind: "visit-type", visitTypes: [] }
                : { kind: "diagnosis", dxKeys: [] },
            })}
          >
            <option value="diagnosis">Diagnosis</option>
            <option value="visit-type">Visit type (authoring only)</option>
          </select>
        </Field>
        {draft.trigger.kind === "diagnosis" ? (
          <>
            <Field label="Diagnosis family patterns">
              <input
                className={FIELD_CLASS}
                placeholder="H04.12*"
                value={diagnosisTrigger.dxKeys.join(", ")}
                onChange={(event) => onChange({
                  ...draft,
                  trigger: {
                    ...diagnosisTrigger,
                    dxKeys: commaValues(event.target.value),
                  },
                })}
              />
            </Field>
            <Field label="StatusScope">
              <div className="flex flex-wrap gap-2">
                {DIAGNOSIS_VISIT_STATUSES.map((status) => {
                  const checked = diagnosisTrigger.statusScope?.includes(status) ?? false;
                  return (
                    <label
                      key={status}
                      className="flex items-center gap-2 rounded-full border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-3 py-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onChange({
                          ...draft,
                          trigger: {
                            ...diagnosisTrigger,
                            statusScope: toggleValue(diagnosisTrigger.statusScope ?? [], status),
                          },
                        })}
                      />
                      {status}
                    </label>
                  );
                })}
              </div>
            </Field>
          </>
        ) : (
          <Field label="Visit types">
            <input
              className={FIELD_CLASS}
              value={draft.trigger.visitTypes.join(", ")}
              onChange={(event) => onChange({
                ...draft,
                trigger: { kind: "visit-type", visitTypes: commaValues(event.target.value) },
              })}
            />
          </Field>
        )}
        <Field label="Categories">
          <input
            className={FIELD_CLASS}
            value={draft.categories.join(", ")}
            onChange={(event) => onChange({ ...draft, categories: commaValues(event.target.value) })}
          />
        </Field>
        <Field label="Owner">
          <input
            className={FIELD_CLASS}
            value={draft.ownership.ownerId}
            onChange={(event) => onChange({
              ...draft,
              ownership: { ...draft.ownership, ownerId: event.target.value },
            })}
          />
        </Field>
        <Field label="Sharing">
          <select
            className={FIELD_CLASS}
            value={draft.ownership.sharing}
            onChange={(event) => onChange({
              ...draft,
              ownership: { ...draft.ownership, sharing: event.target.value },
            })}
          >
            <option value="private">Private</option>
            <option value="practice">Practice</option>
            <option value="named">Named clinicians</option>
          </select>
        </Field>
      </div>
    </aside>
  );
}

function ItemEditor({
  item,
  index,
  count,
  catalogs,
  onChange,
  onMove,
  onRemove,
}: {
  item: ProtocolItem;
  index: number;
  count: number;
  catalogs: ProtocolLibraryResponse["catalogs"];
  onChange: (item: ProtocolItem) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  function payload(patch: Record<string, unknown>, freshNarrative = false) {
    onChange({
      ...item,
      payload: compactPayload({ ...item.payload, ...patch }),
      ...(freshNarrative ? { capture: undefined } : {}),
    });
  }
  return (
    <article className="rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--odos-accent)]">
            {itemTypeLabel(item.itemType)}
          </div>
          {item.capture && <div className="mt-1 text-xs text-[color:var(--odos-muted)]">{item.capture.source}</div>}
        </div>
        <div className="flex gap-2">
          <button type="button" className={BUTTON_CLASS} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
          <button type="button" className={BUTTON_CLASS} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
          <button type="button" className={BUTTON_CLASS} onClick={onRemove}>Remove</button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="Item key">
          <input className={FIELD_CLASS} value={item.itemKey} onChange={(event) => onChange({ ...item, itemKey: event.target.value })} />
        </Field>
        <Field label="Laterality">
          <select
            className={FIELD_CLASS}
            value={lateralityValue(item.lateralityMode)}
            onChange={(event) => onChange({ ...item, lateralityMode: parseLaterality(event.target.value) })}
          >
            <option value="inherit-dx">Inherit diagnosis</option>
            <option value="OU-always">OU always</option>
            <option value="fixed-OD">Fixed OD</option>
            <option value="fixed-OS">Fixed OS</option>
            <option value="fixed-OU">Fixed OU</option>
          </select>
        </Field>
        <Field label="Merge key">
          <input className={FIELD_CLASS} value={item.mergeKey ?? ""} onChange={(event) => onChange({ ...item, mergeKey: event.target.value || undefined })} />
        </Field>
        <label className="flex h-10 items-center gap-2 self-end rounded border border-[color:var(--odos-line-2)] px-3 text-sm">
          <input
            type="checkbox"
            checked={item.defaultSelected}
            onChange={(event) => onChange({ ...item, defaultSelected: event.target.checked })}
          />
          Selected by default
        </label>
      </div>
      <div className="mt-3">
        <PayloadEditor item={item} catalogs={catalogs} onPayload={payload} />
      </div>
    </article>
  );
}

function PayloadEditor({
  item,
  catalogs,
  onPayload,
}: {
  item: ProtocolItem;
  catalogs: ProtocolLibraryResponse["catalogs"];
  onPayload: (patch: Record<string, unknown>, freshNarrative?: boolean) => void;
}) {
  switch (item.itemType) {
    case "finding-seed": {
      const promptOnly = item.payload.mode !== "seedValue";
      return (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Finding">
            <CatalogSelect
              value={string(item.payload.findingDefKey)}
              options={catalogs.findingKeys}
              onChange={(findingDefKey) => onPayload({ findingDefKey })}
            />
          </Field>
          <Field label="Capture mode">
            <select
              className={FIELD_CLASS}
              value={promptOnly ? "promptOnly" : "seedValue"}
              disabled={item.capture?.source === "device-measured"}
              onChange={(event) => onPayload(event.target.value === "seedValue"
                ? { mode: "seedValue", defaultValue: item.payload.defaultValue ?? "" }
                : { mode: "promptOnly", defaultValue: undefined })}
            >
              <option value="promptOnly">Prompt only</option>
              <option value="seedValue">Keep seed value</option>
            </select>
          </Field>
          {!promptOnly && (
            <Field label="Seed value">
              <input
                className={FIELD_CLASS}
                value={primitiveInput(item.payload.defaultValue)}
                onChange={(event) => onPayload({ defaultValue: parsePrimitive(event.target.value) })}
              />
            </Field>
          )}
        </div>
      );
    }
    case "order":
      return (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Orderable">
            <CatalogSelect value={string(item.payload.orderableKey)} options={catalogs.procedureKeys} onChange={(orderableKey) => onPayload({ orderableKey })} />
          </Field>
          <Field label="Perform context">
            <select className={FIELD_CLASS} value={string(item.payload.performContext) || "schedule"} onChange={(event) => onPayload({ performContext: event.target.value })}>
              <option value="in-office-today">In office today</option>
              <option value="schedule">Schedule</option>
              <option value="external">External</option>
            </select>
          </Field>
        </div>
      );
    case "medication":
      return (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Medication catalog key">
            <input className={FIELD_CLASS} value={string(item.payload.medicationKey)} onChange={(event) => onPayload({ medicationKey: event.target.value })} />
          </Field>
          <Field label="Route">
            <select className={FIELD_CLASS} value={string(item.payload.route) || "ophthalmic"} onChange={(event) => onPayload({ route: event.target.value })}>
              <option value="ophthalmic">Ophthalmic</option>
              <option value="oral">Oral</option>
              <option value="topical">Topical</option>
            </select>
          </Field>
        </div>
      );
    case "counseling":
      return (
        <div className="grid gap-3">
          <Field label="Topic key">
            <input className={FIELD_CLASS} value={string(item.payload.topicKey)} onChange={(event) => onPayload({ topicKey: event.target.value })} />
          </Field>
          <Field label="Fresh narrative">
            <textarea className={TEXTAREA_CLASS} rows={3} value={string(item.payload.narrativeTemplate)} onChange={(event) => onPayload({ narrativeTemplate: event.target.value }, true)} />
          </Field>
        </div>
      );
    case "education":
      return (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Education asset">
            <input className={FIELD_CLASS} value={string(item.payload.assetRef)} onChange={(event) => onPayload({ assetRef: event.target.value })} />
          </Field>
          <Field label="Delivery">
            <select className={FIELD_CLASS} value={string(item.payload.deliveryMode) || "print"} onChange={(event) => onPayload({ deliveryMode: event.target.value })}>
              <option value="print">Print</option>
              <option value="portal">Portal</option>
              <option value="review">Review in room</option>
            </select>
          </Field>
        </div>
      );
    case "instruction":
      return (
        <div className="grid gap-3">
          <Field label="Instruction key">
            <input className={FIELD_CLASS} value={string(item.payload.instructionKey)} onChange={(event) => onPayload({ instructionKey: event.target.value })} />
          </Field>
          <Field label="Fresh instruction">
            <textarea className={TEXTAREA_CLASS} rows={3} value={string(item.payload.instructionText)} onChange={(event) => onPayload({ instructionText: event.target.value }, true)} />
          </Field>
        </div>
      );
    case "follow-up":
      return (
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Interval">
            <input type="number" min="1" className={FIELD_CLASS} value={number(item.payload.interval)} onChange={(event) => onPayload({ interval: Number(event.target.value) })} />
          </Field>
          <Field label="Unit">
            <select className={FIELD_CLASS} value={string(item.payload.unit) || "months"} onChange={(event) => onPayload({ unit: event.target.value })}>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
              <option value="years">Years</option>
            </select>
          </Field>
          <label className="flex h-10 items-center gap-2 self-end rounded border border-[color:var(--odos-line-2)] px-3 text-sm">
            <input type="checkbox" checked={Boolean(item.payload.schedulingOrder)} onChange={(event) => onPayload({ schedulingOrder: event.target.checked })} />
            Scheduling order
          </label>
          <div className="md:col-span-3">
            <Field label="Fresh reason">
              <textarea className={TEXTAREA_CLASS} rows={2} value={string(item.payload.reason)} onChange={(event) => onPayload({ reason: event.target.value }, true)} />
            </Field>
          </div>
        </div>
      );
    case "charge-seed":
      return (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Procedure concept">
            <CatalogSelect value={string(item.payload.procedureConceptKey)} options={catalogs.procedureKeys} onChange={(procedureConceptKey) => onPayload({ procedureConceptKey })} />
          </Field>
          <Field label="Charge rule references">
            <input
              className={FIELD_CLASS}
              value={array(item.payload.chargeRuleRefs).join(", ")}
              onChange={(event) => onPayload({ chargeRuleRefs: commaValues(event.target.value) })}
            />
          </Field>
        </div>
      );
  }
}

function CatalogSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <select className={FIELD_CLASS} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose a catalog key</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--odos-muted)]">{label}</span>
      {children}
    </label>
  );
}

function ProtocolThemeToggle() {
  const initial = (
    typeof document === "undefined"
      ? "midnight"
      : document.documentElement.dataset.surface ?? "midnight"
  ) as AppearanceSurface;
  const [surface, setSurface] = useState<AppearanceSurface>(APPEARANCE_SURFACES.includes(initial) ? initial : "midnight");
  function choose(next: AppearanceSurface) {
    const candidate = document.documentElement.dataset.accent as AppearanceAccent | undefined;
    const accent = candidate && APPEARANCE_ACCENTS.includes(candidate) ? candidate : "gold";
    applyAppearance({ surface: next, accent });
    setSurface(next);
  }
  return (
    <div className="flex rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface)] p-1" aria-label="Protocol theme">
      {APPEARANCE_SURFACES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={surface === option}
          className={surface === option
            ? "rounded bg-[color:var(--odos-accent-tint-hi)] px-2 py-1 text-xs font-semibold text-[color:var(--odos-text)]"
            : "rounded px-2 py-1 text-xs text-[color:var(--odos-muted)]"}
          onClick={() => choose(option)}
        >
          {option === "space-black" ? "Black" : option[0]?.toUpperCase() + option.slice(1)}
        </button>
      ))}
    </div>
  );
}

function ProtocolState({ error }: { error?: string }) {
  return (
    <main className="min-h-full bg-[color:var(--odos-ground)] p-8 text-[color:var(--odos-text)]">
      <div className="mx-auto max-w-5xl">
        <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--odos-accent)]">Clinical authoring</div>
        <h1 className="mt-1 text-3xl font-semibold">Protocol Library</h1>
        <p className="mt-3 text-sm text-[color:var(--odos-muted)]" {...(error ? { role: "alert" } : {})}>
          {error ?? "Loading protocols…"}
        </p>
      </div>
    </main>
  );
}

function ProtocolError({ children }: { children: string }) {
  return <div className="mt-4 rounded border border-[color:var(--odos-alert)] bg-[color:var(--odos-surface)] p-3 text-sm text-[color:var(--odos-alert)]" role="alert">{children}</div>;
}

function StatusChip({ status, hasDraft }: { status: ProtocolDefinition["status"]; hasDraft: boolean }) {
  return (
    <span className="rounded-full border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface-2)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[color:var(--odos-muted)]">
      {status}{hasDraft && status === "active" ? " · draft edits" : ""}
    </span>
  );
}

const ITEM_TYPES: ProtocolItemType[] = [
  "finding-seed",
  "order",
  "medication",
  "counseling",
  "education",
  "instruction",
  "follow-up",
  "charge-seed",
];

function blankItem(type: ProtocolItemType, existing: ProtocolItem[]): ProtocolItem {
  const number = existing.filter((row) => row.itemType === type).length + 1;
  const itemKey = `${type}-${number}`;
  const payload: Record<ProtocolItemType, Record<string, unknown>> = {
    "finding-seed": { findingDefKey: "", mode: "promptOnly" },
    order: { orderableKey: "", performContext: "schedule" },
    medication: { medicationKey: "", route: "ophthalmic" },
    counseling: { topicKey: "" },
    education: { assetRef: "", deliveryMode: "print" },
    instruction: { instructionKey: "" },
    "follow-up": { interval: 6, unit: "months", schedulingOrder: true },
    "charge-seed": { procedureConceptKey: "", chargeRuleRefs: [] },
  };
  return {
    itemKey,
    itemType: type,
    defaultSelected: true,
    lateralityMode: "inherit-dx",
    payload: payload[type],
  };
}

function groupProtocols(protocols: ProtocolDefinition[]): Array<[string, ProtocolDefinition[]]> {
  const groups = new Map<string, ProtocolDefinition[]>();
  for (const protocol of protocols) {
    const trigger = protocol.draft?.trigger ?? protocol.trigger;
    const family = trigger.kind === "diagnosis"
      ? trigger.dxKeys[0]?.replace(/\*+$/, "") || "Unassigned diagnosis"
      : "Visit type";
    groups.set(family, [...(groups.get(family) ?? []), protocol]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, rows]) => [family, rows.sort((left, right) => left.title.localeCompare(right.title))]);
}

function itemTally(items: ProtocolItem[]): string {
  const counts = new Map<ProtocolItemType, number>();
  for (const item of items) counts.set(item.itemType, (counts.get(item.itemType) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => `${count} ${itemTypeLabel(type)}`).join(" · ") || "No items";
}

function itemTypeLabel(type: ProtocolItemType): string {
  return type.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusScopeLabel(trigger: ProtocolDraft["trigger"]): string {
  if (trigger.kind !== "diagnosis") return "Visit-type trigger";
  return trigger.statusScope?.length ? `Scope: ${trigger.statusScope.join(", ")}` : "All visit statuses";
}

function followUpLabel(item: ProtocolItem): string {
  return `Follow-up: ${String(item.payload.interval ?? "—")} ${String(item.payload.unit ?? "")}`.trim();
}

function openProtocol(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("protocol", id);
  window.history.pushState({}, "", `${url.pathname}${url.search}`);
  window.dispatchEvent(new Event("odos:protocol-navigation"));
}

function closeProtocol() {
  const url = new URL(window.location.href);
  url.searchParams.delete("protocol");
  window.history.pushState({}, "", `${url.pathname}${url.search}`);
  window.dispatchEvent(new Event("odos:protocol-navigation"));
}

function lateralityValue(value: LateralityMode): string {
  return typeof value === "string" ? value : `fixed-${value.fixed}`;
}

function parseLaterality(value: string): LateralityMode {
  if (value === "inherit-dx" || value === "OU-always") return value;
  return { fixed: value.replace(/^fixed-/, "") as "OD" | "OS" | "OU" };
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((row) => row !== value) : [...values, value];
}

function commaValues(value: string): string[] {
  return value.split(",").map((row) => row.trim()).filter(Boolean);
}

function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function primitiveInput(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function parsePrimitive(value: string): string | number {
  const numberValue = Number(value);
  return value.trim() && Number.isFinite(numberValue) ? numberValue : value;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | "" {
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

function array(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((row): row is string => typeof row === "string") : [];
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
