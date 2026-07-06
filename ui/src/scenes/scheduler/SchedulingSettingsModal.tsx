import type { Schedule } from "@medplum/fhirtypes";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  BLOCKED_TIME_KINDS,
  resourceDisplay,
  scheduleReference,
  type BlockedTime,
  type SchedulingPracticeConfig,
  type Weekday,
  type WeeklyHours,
} from "../../lib/scheduling";
import {
  addSchedulingOffice,
  assignScheduleOffice,
  copyWeeklyHoursBetweenSchedules,
  deleteSchedulingBlock,
  removeSchedulingOffice,
} from "../../lib/scheduling-settings";

const WEEKDAYS: Array<{ code: Weekday; display: string }> = [
  { code: "mon", display: "Mon" },
  { code: "tue", display: "Tue" },
  { code: "wed", display: "Wed" },
  { code: "thu", display: "Thu" },
  { code: "fri", display: "Fri" },
  { code: "sat", display: "Sat" },
  { code: "sun", display: "Sun" },
];

export function SchedulingSettingsModal({
  config,
  currentDate,
  initialBlockIndex,
  resources,
  onClose,
  onSave,
}: {
  config: SchedulingPracticeConfig;
  currentDate: string;
  initialBlockIndex?: number;
  resources: Schedule[];
  onClose: () => void;
  onSave: (config: SchedulingPracticeConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SchedulingPracticeConfig>(() => clone(config));
  const [selectedResource, setSelectedResource] = useState("");
  const [selectedBlockIndex, setSelectedBlockIndex] = useState(initialBlockIndex ?? 0);
  const [newOfficeName, setNewOfficeName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  }, [config, initialBlockIndex]);

  useEffect(() => {
    if (!selectedResource && resourceOptions[0]) {
      setSelectedResource(resourceOptions[0].reference);
    }
  }, [resourceOptions, selectedResource]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function guardedUpdate(update: (current: SchedulingPracticeConfig) => SchedulingPracticeConfig) {
    try {
      setDraft((current) => update(current));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
            <h2 className="text-lg font-semibold">Hours, Blocks, Offices</h2>
          </div>
          <button className="scheduler-icon-button" type="button" aria-label="Close" onClick={onClose}>
            x
          </button>
        </header>
        {error && (
          <div className="border-b border-red-400/40 bg-red-950/50 px-4 py-2 text-sm text-red-100">
            {error}
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
                    onChange={(block) =>
                      setDraft((current) => ({
                        ...current,
                        blocks: current.blocks.map((candidate, index) => (index === selectedBlockIndex ? block : candidate)),
                      }))
                    }
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
                <div className="grid gap-2">
                  {draft.offices.map((office) => (
                    <div key={office.id} className="grid grid-cols-[1fr_auto] gap-2">
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
                      />
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
          <button className="scheduler-button" type="button" disabled={saving} onClick={() => void save()}>
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

function WeeklyHoursEditor({
  hours,
  onChange,
}: {
  hours: WeeklyHours;
  onChange: (hours: WeeklyHours) => void;
}) {
  function updateDay(day: Weekday, windows: Array<{ start: string; end: string }>) {
    onChange({ ...hours, [day]: windows });
  }
  return (
    <div className="grid gap-2">
      {WEEKDAYS.map((day) => {
        const windows = hours[day.code] ?? [];
        const closed = windows.length === 0;
        return (
          <div key={day.code} className="grid gap-2 border border-white/10 bg-white/[0.03] p-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-10 text-sm font-semibold text-white/75">{day.display}</div>
              <label className="flex items-center gap-2 text-sm text-white/70">
                <input
                  type="checkbox"
                  checked={closed}
                  onChange={(event) =>
                    updateDay(day.code, event.target.checked ? [] : [{ start: "09:00", end: "17:00" }])
                  }
                />
                <span>Closed</span>
              </label>
              {!closed && (
                <button
                  className="scheduler-button"
                  type="button"
                  onClick={() => updateDay(day.code, [...windows, { start: "13:00", end: "17:00" }])}
                >
                  Add Window
                </button>
              )}
            </div>
            {!closed &&
              windows.map((window, index) => (
                <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input
                    className="scheduler-input"
                    type="time"
                    value={window.start}
                    onChange={(event) =>
                      updateDay(
                        day.code,
                        windows.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, start: event.target.value } : candidate,
                        ),
                      )
                    }
                  />
                  <input
                    className="scheduler-input"
                    type="time"
                    value={window.end}
                    onChange={(event) =>
                      updateDay(
                        day.code,
                        windows.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, end: event.target.value } : candidate,
                        ),
                      )
                    }
                  />
                  <button
                    className="scheduler-button"
                    type="button"
                    onClick={() => updateDay(day.code, windows.filter((_, candidateIndex) => candidateIndex !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))}
          </div>
        );
      })}
    </div>
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
  onDelete,
}: {
  block: BlockedTime;
  resources: Array<{ resource: Schedule; reference: string }>;
  onChange: (block: BlockedTime) => void;
  onDelete: () => void;
}) {
  const allDay = !block.start && !block.end;
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
      <fieldset className="border border-white/10 p-2">
        <legend className="px-1 text-xs uppercase text-white/45">Weekdays</legend>
        <div className="flex flex-wrap gap-3">
          {WEEKDAYS.map((weekday) => (
            <label key={weekday.code} className="flex items-center gap-1 text-sm text-white/75">
              <input
                type="checkbox"
                checked={block.weekdays?.includes(weekday.code) ?? false}
                onChange={(event) => {
                  const current = new Set(block.weekdays ?? []);
                  if (event.target.checked) {
                    current.add(weekday.code);
                  } else {
                    current.delete(weekday.code);
                  }
                  onChange({ ...block, weekdays: [...current] });
                }}
              />
              <span>{weekday.display}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-white/75">
        <input
          type="checkbox"
          checked={allDay}
          onChange={(event) =>
            onChange(event.target.checked ? withoutTimes(block) : { ...block, start: "09:00", end: "17:00" })
          }
        />
        <span>All Day</span>
      </label>
      {!allDay && (
        <div className="grid gap-2 md:grid-cols-2">
          <label className="scheduler-field">
            <span>Start</span>
            <input
              className="scheduler-input"
              type="time"
              value={block.start ?? ""}
              onChange={(event) => onChange({ ...block, start: event.target.value || undefined })}
            />
          </label>
          <label className="scheduler-field">
            <span>End</span>
            <input
              className="scheduler-input"
              type="time"
              value={block.end ?? ""}
              onChange={(event) => onChange({ ...block, end: event.target.value || undefined })}
            />
          </label>
        </div>
      )}
      <fieldset className="border border-white/10 p-2">
        <legend className="px-1 text-xs uppercase text-white/45">Resources</legend>
        <div className="grid gap-2 md:grid-cols-2">
          {resources.map((entry) => {
            const scoped = block.scheduleReferences?.includes(entry.reference) ?? false;
            return (
              <label key={entry.reference} className="flex items-center gap-2 text-sm text-white/75">
                <input
                  type="checkbox"
                  checked={scoped}
                  onChange={(event) => {
                    const current = new Set(block.scheduleReferences ?? []);
                    if (event.target.checked) {
                      current.add(entry.reference);
                    } else {
                      current.delete(entry.reference);
                    }
                    onChange({ ...block, scheduleReferences: [...current] });
                  }}
                />
                <span>{resourceDisplay(entry.resource)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div>
        <button className="scheduler-button" type="button" onClick={onDelete}>
          Delete Block
        </button>
      </div>
    </div>
  );
}

function withoutTimes(block: BlockedTime): BlockedTime {
  const { start, end, ...rest } = block;
  void start;
  void end;
  return rest;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
