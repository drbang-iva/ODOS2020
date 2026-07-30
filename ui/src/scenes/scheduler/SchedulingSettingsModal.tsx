import type { Schedule } from "@medplum/fhirtypes";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  TimeWindowWeekdayField,
  WeeklyHoursEditor,
} from "../../components/settings/CatalogFields";
import { OdosChips } from "../../components/inputs/OdosChips";
import {
  BLOCKED_TIME_KINDS,
  DEFAULT_SLOT_MINUTES,
  SCHEDULING_SLOT_OPTIONS,
  resourceDisplay,
  scheduleReference,
  type BlockedTime,
  type SchedulingPracticeConfig,
} from "../../lib/scheduling";
import {
  addSchedulingOffice,
  applyBlockScope,
  assignScheduleOffice,
  blockScopeState,
  clone,
  copyWeeklyHoursBetweenSchedules,
  deleteSchedulingBlock,
  removeSchedulingOffice,
  renameSchedulingOffice,
  replaceSchedulingBlock,
  validateSchedulingPracticeSettings,
} from "../../lib/scheduling-settings";
import type {
  SchedulingIntegrityIssue,
  SchedulingResourceDeactivationResult,
} from "../../lib/scheduling-resource-admin";

export function SchedulingSettingsModal({
  config,
  currentDate,
  initialBlockIndex,
  resources,
  canManageResources,
  integrityIssues,
  integrityLoading,
  onClose,
  onDeactivateResource,
  onInspectIntegrity,
  onSave,
}: {
  config: SchedulingPracticeConfig;
  currentDate: string;
  initialBlockIndex?: number;
  resources: Schedule[];
  canManageResources: boolean;
  integrityIssues: SchedulingIntegrityIssue[];
  integrityLoading: boolean;
  onClose: () => void;
  onDeactivateResource: (
    scheduleId: string,
    acknowledgeFutureAppointments: boolean,
  ) => Promise<SchedulingResourceDeactivationResult>;
  onInspectIntegrity: () => Promise<void>;
  onSave: (config: SchedulingPracticeConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SchedulingPracticeConfig>(() => clone(config));
  const [selectedResource, setSelectedResource] = useState("");
  const [selectedBlockIndex, setSelectedBlockIndex] = useState(initialBlockIndex ?? 0);
  const [newOfficeName, setNewOfficeName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockScopeError, setBlockScopeError] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [deactivationGuard, setDeactivationGuard] = useState<{
    scheduleId: string;
    display: string;
    futureAppointmentCount: number;
  } | null>(null);
  const resourceOptions = useMemo(
    () =>
      resources
        .map((resource) => ({ resource, reference: scheduleReference(resource) }))
        .filter((entry): entry is { resource: Schedule; reference: string } => Boolean(entry.reference)),
    [resources],
  );

  useEffect(() => {
    setDraft(clone(config));
    setSelectedBlockIndex(initialBlockIndex ?? 0);
    setBlockScopeError(null);
  }, [config, initialBlockIndex]);

  useEffect(() => {
    if (resourceOptions.some((entry) => entry.reference === selectedResource)) return;
    setSelectedResource(resourceOptions[0]?.reference ?? "");
  }, [resourceOptions, selectedResource]);

  useEffect(() => {
    if (!canManageResources) return;
    void onInspectIntegrity().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [canManageResources, onInspectIntegrity]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      validateSchedulingPracticeSettings(draft);
      await onSave(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const draftValidationError = useMemo(() => {
    try {
      validateSchedulingPracticeSettings(draft);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [draft]);

  function guardedUpdate(update: (current: SchedulingPracticeConfig) => SchedulingPracticeConfig) {
    try {
      setDraft((current) => update(current));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deactivate(scheduleId: string, display: string, acknowledge: boolean) {
    setDeactivating(true);
    setError(null);
    try {
      const result = await onDeactivateResource(scheduleId, acknowledge);
      if (!result.deactivated) {
        setDeactivationGuard({
          scheduleId,
          display,
          futureAppointmentCount: result.futureAppointmentCount,
        });
      } else {
        setDeactivationGuard(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeactivating(false);
    }
  }

  const selectedResourceEntry = resourceOptions.find((entry) => entry.reference === selectedResource);
  const selectedBlock = draft.blocks[selectedBlockIndex];

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <section className="max-h-[92vh] w-full max-w-6xl overflow-y-auto border border-white/15 bg-[#10111c] text-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-xs uppercase text-white/45">Scheduler Settings</div>
            <h2 className="text-lg font-semibold">Hours, Resources, Blocks, Offices</h2>
            <a className="mt-1 inline-block text-xs text-blue-300 hover:text-blue-200" href="/settings/visit-types">
              Manage visit types
            </a>
          </div>
          <button className="scheduler-icon-button" type="button" aria-label="Close" onClick={onClose}>
            x
          </button>
        </header>
        {(error || blockScopeError || draftValidationError) && (
          <div className="border-b border-red-400/40 bg-red-950/50 px-4 py-2 text-sm text-red-100">
            {error ?? blockScopeError ?? draftValidationError}
          </div>
        )}
        <div className="grid gap-4 p-4 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="grid gap-4">
            <Panel title="Practice Hours">
              <WeeklyHoursEditor
                hours={draft.defaultWeeklyHours}
                onChange={(hours) => setDraft((current) => ({ ...current, defaultWeeklyHours: hours }))}
              />
            </Panel>
            <Panel title="Resource Hours">
              <div className="grid gap-3">
                <label className="scheduler-field">
                  <span>Resource</span>
                  <select
                    className="scheduler-input"
                    value={selectedResource}
                    onChange={(event) => setSelectedResource(event.target.value)}
                  >
                    {resourceOptions.map((entry) => (
                      <option key={entry.reference} value={entry.reference}>
                        {resourceDisplay(entry.resource)}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedResourceEntry && (
                  <>
                    <label className="flex items-center gap-2 text-sm text-white/75">
                      <input
                        type="checkbox"
                        checked={draft.weeklyHoursBySchedule[selectedResource] === undefined}
                        onChange={(event) =>
                          setDraft((current) => {
                            const weeklyHoursBySchedule = { ...current.weeklyHoursBySchedule };
                            if (event.target.checked) {
                              delete weeklyHoursBySchedule[selectedResource];
                            } else {
                              weeklyHoursBySchedule[selectedResource] = clone(current.defaultWeeklyHours);
                            }
                            return { ...current, weeklyHoursBySchedule };
                          })
                        }
                      />
                      <span>Use practice default</span>
                    </label>
                    {draft.weeklyHoursBySchedule[selectedResource] !== undefined && (
                      <>
                        <CopyHoursControl
                          resources={resourceOptions}
                          selectedResource={selectedResource}
                          onCopy={(source) =>
                            guardedUpdate((current) =>
                              copyWeeklyHoursBetweenSchedules(current, source, selectedResource),
                            )
                          }
                        />
                        <WeeklyHoursEditor
                          hours={draft.weeklyHoursBySchedule[selectedResource] ?? {}}
                          onChange={(hours) =>
                            setDraft((current) => ({
                              ...current,
                              weeklyHoursBySchedule: {
                                ...current.weeklyHoursBySchedule,
                                [selectedResource]: hours,
                              },
                            }))
                          }
                        />
                      </>
                    )}
                  </>
                )}
              </div>
            </Panel>
            {canManageResources && (
              <Panel title="Scheduler Resources">
                <div className="grid gap-3">
                  {selectedResourceEntry?.resource.id && (
                    <div className="scheduler-subpanel flex flex-wrap items-center justify-between gap-3 rounded border p-3">
                      <div>
                        <div className="scheduler-subpanel-title text-sm font-semibold">
                          {resourceDisplay(selectedResourceEntry.resource)}
                        </div>
                        <div className="scheduler-subpanel-detail text-xs">
                          Deactivation removes this column without deleting its history.
                        </div>
                      </div>
                      <button
                        className="scheduler-button"
                        type="button"
                        disabled={deactivating}
                        onClick={() => void deactivate(
                          selectedResourceEntry.resource.id!,
                          resourceDisplay(selectedResourceEntry.resource),
                          false,
                        )}
                      >
                        Deactivate resource
                      </button>
                    </div>
                  )}
                  {deactivationGuard && (
                    <div className="scheduler-warning-panel rounded border p-3 text-sm">
                      <div className="font-semibold">
                        {deactivationGuard.display} has {deactivationGuard.futureAppointmentCount} future appointment{deactivationGuard.futureAppointmentCount === 1 ? "" : "s"}.
                      </div>
                      <div className="mt-1 opacity-80">
                        Move those appointments first, or explicitly acknowledge that they will retain this inactive resource assignment.
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button
                          className="scheduler-button"
                          type="button"
                          onClick={() => setDeactivationGuard(null)}
                        >
                          Keep active
                        </button>
                        <button
                          className="scheduler-button"
                          type="button"
                          disabled={deactivating}
                          onClick={() => void deactivate(
                            deactivationGuard.scheduleId,
                            deactivationGuard.display,
                            true,
                          )}
                        >
                          Acknowledge and deactivate
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="scheduler-subpanel-deep rounded border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="scheduler-subpanel-title text-sm font-semibold">Resource integrity</div>
                        <div className="scheduler-subpanel-detail text-xs">Read-only check; no records are repaired automatically.</div>
                      </div>
                      <button
                        className="scheduler-button"
                        type="button"
                        disabled={integrityLoading}
                        onClick={() => void onInspectIntegrity()}
                      >
                        {integrityLoading ? "Checking..." : "Refresh check"}
                      </button>
                    </div>
                    {!integrityLoading && integrityIssues.length === 0 && (
                      <div className="scheduler-success-text mt-3 text-sm">No broken Schedule or Appointment actor links found.</div>
                    )}
                    {integrityIssues.length > 0 && (
                      <div className="mt-3 grid gap-2">
                        {integrityIssues.map((issue, index) => (
                          <div
                            className="scheduler-warning-panel flex flex-wrap items-center justify-between gap-3 rounded border p-2"
                            key={`${issue.sourceType}-${issue.sourceId ?? index}-${index}`}
                          >
                            <div>
                              <div className="text-sm">
                                {issue.sourceType}: {issue.actorDisplay ?? issue.display}
                              </div>
                              <div className="text-xs opacity-70">{issue.problem}</div>
                            </div>
                            {issue.sourceType === "Schedule" && issue.sourceId && (
                              <button
                                className="scheduler-button"
                                type="button"
                                disabled={deactivating}
                                onClick={() => void deactivate(
                                  issue.sourceId!,
                                  issue.actorDisplay ?? issue.display,
                                  false,
                                )}
                              >
                                Deactivate
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            )}
          </section>

          <section className="grid content-start gap-4">
            <Panel title="Blocked Time">
              <div className="grid gap-3">
                <div className="flex flex-wrap gap-2">
                  {draft.blocks.map((block, index) => (
                    <button
                      key={`${index}-${block.kind}-${block.date ?? block.weekdays?.join("")}`}
                      className={index === selectedBlockIndex ? "scheduler-segment-active" : "scheduler-segment"}
                      type="button"
                      onClick={() => setSelectedBlockIndex(index)}
                    >
                      {block.description || block.kind}
                    </button>
                  ))}
                  <button
                    className="scheduler-button"
                    type="button"
                    onClick={() =>
                      setDraft((current) => {
                        const next = {
                          ...current,
                          blocks: [
                            ...current.blocks,
                            { kind: "custom", date: currentDate, start: "12:00", end: "13:00" } as BlockedTime,
                          ],
                        };
                        setSelectedBlockIndex(next.blocks.length - 1);
                        return next;
                      })
                    }
                  >
                    Add Block
                  </button>
                </div>
                {selectedBlock && (
                  <BlockEditor
                    block={selectedBlock}
                    resources={resourceOptions}
                    onChange={(block) => {
                      setBlockScopeError(null);
                      guardedUpdate((current) => replaceSchedulingBlock(current, selectedBlockIndex, block));
                    }}
                    onScopeError={setBlockScopeError}
                    onDelete={() =>
                      guardedUpdate((current) => {
                        const next = deleteSchedulingBlock(current, selectedBlockIndex);
                        setSelectedBlockIndex(Math.max(0, selectedBlockIndex - 1));
                        return next;
                      })
                    }
                  />
                )}
              </div>
            </Panel>

            <Panel title="Offices">
              <div className="grid gap-3">
                <label className="scheduler-field">
                  Default booking increment
                  <select
                    className="scheduler-input"
                    value={draft.defaultSlotMinutes ?? DEFAULT_SLOT_MINUTES}
                    onChange={(event) =>
                      guardedUpdate((current) => ({ ...current, defaultSlotMinutes: Number(event.target.value) }))
                    }
                  >
                    {SCHEDULING_SLOT_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option} min
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-2">
                  {draft.offices.map((office) => (
                    <div key={office.id} className="grid grid-cols-[1fr_auto_auto] gap-2">
                      <input
                        className="scheduler-input"
                        value={office.name}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            offices: current.offices.map((candidate) =>
                              candidate.id === office.id ? { ...candidate, name: event.target.value } : candidate,
                            ),
                          }))
                        }
                        onBlur={(event) =>
                          guardedUpdate((current) =>
                            renameSchedulingOffice(current, office.id, event.target.value),
                          )
                        }
                      />
                      <select
                        className="scheduler-input"
                        aria-label={`${office.name || "Office"} booking increment`}
                        value={office.slotMinutes ?? ""}
                        onChange={(event) =>
                          guardedUpdate((current) => ({
                            ...current,
                            offices: current.offices.map((candidate) =>
                              candidate.id === office.id
                                ? {
                                    ...candidate,
                                    slotMinutes: event.target.value ? Number(event.target.value) : undefined,
                                  }
                                : candidate,
                            ),
                          }))
                        }
                      >
                        <option value="">Default ({draft.defaultSlotMinutes ?? DEFAULT_SLOT_MINUTES} min)</option>
                        {SCHEDULING_SLOT_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option} min
                          </option>
                        ))}
                      </select>
                      <button
                        className="scheduler-button"
                        type="button"
                        onClick={() => guardedUpdate((current) => removeSchedulingOffice(current, office.id))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input
                    className="scheduler-input"
                    value={newOfficeName}
                    placeholder="Office name"
                    onChange={(event) => setNewOfficeName(event.target.value)}
                  />
                  <button
                    className="scheduler-button"
                    type="button"
                    onClick={() =>
                      guardedUpdate((current) => {
                        const next = addSchedulingOffice(current, newOfficeName);
                        setNewOfficeName("");
                        return next;
                      })
                    }
                  >
                    Add
                  </button>
                </div>
                <div className="grid gap-2">
                  {resourceOptions.map((entry) => (
                    <label key={entry.reference} className="scheduler-field">
                      <span>{resourceDisplay(entry.resource)}</span>
                      <select
                        className="scheduler-input"
                        value={draft.officeBySchedule[entry.reference] ?? ""}
                        onChange={(event) =>
                          guardedUpdate((current) =>
                            assignScheduleOffice(current, entry.reference, event.target.value),
                          )
                        }
                      >
                        <option value="">Unassigned</option>
                        {draft.offices.map((office) => (
                          <option key={office.id} value={office.id}>
                            {office.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </Panel>
          </section>
        </div>
        <footer className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
          <button className="scheduler-button" type="button" onClick={onClose}>
            Close
          </button>
          <button
            className="scheduler-button"
            type="button"
            disabled={saving || Boolean(blockScopeError || draftValidationError)}
            onClick={() => void save()}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-white/10 bg-black/20 p-3">
      <h3 className="mb-3 text-sm font-semibold uppercase text-white/55">{title}</h3>
      {children}
    </section>
  );
}

function CopyHoursControl({
  resources,
  selectedResource,
  onCopy,
}: {
  resources: Array<{ resource: Schedule; reference: string }>;
  selectedResource: string;
  onCopy: (sourceScheduleReference: string) => void;
}) {
  const [source, setSource] = useState("");
  return (
    <div className="grid grid-cols-[1fr_auto] gap-2">
      <select className="scheduler-input" value={source} onChange={(event) => setSource(event.target.value)}>
        <option value="">Copy hours from...</option>
        {resources
          .filter((entry) => entry.reference !== selectedResource)
          .map((entry) => (
            <option key={entry.reference} value={entry.reference}>
              {resourceDisplay(entry.resource)}
            </option>
          ))}
      </select>
      <button className="scheduler-button" type="button" disabled={!source} onClick={() => source && onCopy(source)}>
        Copy
      </button>
    </div>
  );
}

function BlockEditor({
  block,
  resources,
  onChange,
  onScopeError,
  onDelete,
}: {
  block: BlockedTime;
  resources: Array<{ resource: Schedule; reference: string }>;
  onChange: (block: BlockedTime) => void;
  onScopeError: (message: string | null) => void;
  onDelete: () => void;
}) {
  const [scopeMode, setScopeMode] = useState(blockScopeState(block).mode);
  const [selectedReferences, setSelectedReferences] = useState(blockScopeState(block).scheduleReferences);

  useEffect(() => {
    const scope = blockScopeState(block);
    setScopeMode(scope.mode);
    setSelectedReferences(scope.scheduleReferences);
  }, [block]);

  function applyScope(mode: "all" | "selected", references: string[]) {
    setScopeMode(mode);
    setSelectedReferences(references);
    if (mode === "selected" && references.length === 0) {
      onScopeError("Selected resources scope requires at least one selected resource.");
      return;
    }
    onScopeError(null);
    onChange(applyBlockScope(block, { mode, scheduleReferences: references }));
  }

  return (
    <div className="grid gap-3 border border-white/10 bg-white/[0.03] p-3">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="scheduler-field">
          <span>Kind</span>
          <select
            className="scheduler-input"
            value={block.kind}
            onChange={(event) => onChange({ ...block, kind: event.target.value as BlockedTime["kind"] })}
          >
            {BLOCKED_TIME_KINDS.map((kind) => (
              <option key={kind.code} value={kind.code}>
                {kind.display}
              </option>
            ))}
          </select>
        </label>
        <label className="scheduler-field">
          <span>Description</span>
          <input
            className="scheduler-input"
            value={block.description ?? ""}
            onChange={(event) => onChange({ ...block, description: event.target.value })}
          />
        </label>
      </div>
      <label className="scheduler-field">
        <span>Date</span>
        <input
          className="scheduler-input"
          type="date"
          value={block.date ?? ""}
          onChange={(event) => onChange({ ...block, date: event.target.value || undefined })}
        />
      </label>
      <TimeWindowWeekdayField
        value={{
          weekdays: block.weekdays ?? [],
          ...(block.start ? { start: block.start } : {}),
          ...(block.end ? { end: block.end } : {}),
        }}
        onChange={(value) =>
          onChange({
            ...block,
            weekdays: value.weekdays,
            start: value.start,
            end: value.end,
          })
        }
      />
      <fieldset className="border border-white/10 p-2">
        <legend className="px-1 text-xs uppercase text-white/45">Applies To</legend>
        <div className="mb-2 flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-sm text-white/75">
            <input
              type="radio"
              checked={scopeMode === "all"}
              onChange={() => applyScope("all", [])}
            />
            <span>All resources</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-white/75">
            <input
              type="radio"
              checked={scopeMode === "selected"}
              onChange={() => applyScope("selected", selectedReferences.length > 0 ? selectedReferences : [])}
            />
            <span>Selected resources</span>
          </label>
        </div>
        {scopeMode === "selected" && selectedReferences.length === 0 && (
          <div className="mb-2 text-sm text-red-200">Select at least one resource.</div>
        )}
        <OdosChips
          options={resources.map((entry) => ({
            value: entry.reference,
            label: resourceDisplay(entry.resource),
          }))}
          selected={selectedReferences}
          onChange={(references) => applyScope("selected", references)}
          ariaLabel="Selected scheduling resources"
          disabled={scopeMode !== "selected"}
        />
      </fieldset>
      <div>
        <button className="scheduler-button" type="button" onClick={onDelete}>
          Delete Block
        </button>
      </div>
    </div>
  );
}
