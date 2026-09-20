import { useEffect, useState } from "react";
import { loadFollowUpProfiles, writeFollowUpProfile, type FollowUpProfile, type FollowUpProfileRecord, type FollowUpProfileCatalog, type ProfileReference, type ProfileTest } from "../../lib/follow-up-profiles";

const buttonClass = "rounded border border-[color:var(--odos-line-2)] px-3 py-2 text-sm disabled:opacity-40";
const referenceKey = (row: ProfileReference) => row.key;
const referenceLabel = (row: ProfileReference) => row.label ?? row.key;
const testKey = (row: ProfileTest) => `${row.orderable}|${row.focus ?? ""}`;
const testLabel = (row: ProfileTest) => `${row.label}${row.focus ? ` · ${row.focus}` : ""}`;
const stringKey = (row: string) => row;

export function FollowUpProfilesSettings() {
  const [catalog, setCatalog] = useState<FollowUpProfileCatalog | null>(null);
  const [editing, setEditing] = useState<{ original?: FollowUpProfileRecord; draft: FollowUpProfile } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void loadFollowUpProfiles().then(value => { if (active) setCatalog(value); }).catch(caught => { if (active) setError(message(caught)); }); return () => { active = false; }; }, []);

  function open(profile: FollowUpProfileRecord) {
    const { versionId: _versionId, ...draft } = profile;
    setEditing({ original: profile, draft: structuredClone(draft) });
    setError(null);
  }
  function copy() {
    const source = editing?.draft ?? catalog?.profiles[0];
    if (!source || !catalog?.canWrite) return;
    const { versionId: _versionId, ...draft } = source as FollowUpProfileRecord;
    setEditing({ draft: { ...structuredClone(draft), profileKey: `profile-${crypto.randomUUID()}`, label: `${source.label} copy` } });
    setError(null);
  }
  async function persist(original: FollowUpProfileRecord | undefined, draft: FollowUpProfile, reset = false) {
    if (!catalog?.canWrite || saving) return;
    setSaving(true); setError(null);
    try {
      await writeFollowUpProfile(original?.profileKey, reset
        ? { action: "reset", expectedVersion: original?.versionId ?? null }
        : { profile: draft, expectedVersion: original?.versionId ?? null });
      setCatalog(await loadFollowUpProfiles());
      setEditing(null);
    } catch (caught) { setError(message(caught)); }
    finally { setSaving(false); }
  }
  function change<K extends keyof FollowUpProfile>(key: K, value: FollowUpProfile[K]) {
    if (editing && catalog?.canWrite && !saving) setEditing({ ...editing, draft: { ...editing.draft, [key]: value } });
  }
  const disabled = !catalog?.canWrite || saving;
  return <section aria-label="Follow-up profiles" className="rounded border border-[color:var(--odos-line)] bg-bg-panel/70 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">Follow-up profiles</h2><p className="mt-1 text-sm text-[color:var(--odos-muted)]">Practice defaults for followed problems. Profiles are a catalogue; they do not change today's chart.</p></div>
      {catalog?.canWrite && <button type="button" disabled={saving} onClick={copy} className={buttonClass}>New profile · copy {editing ? "selected" : "first"}</button>}
    </div>
    {error && <p role="alert" className="mt-3 rounded border border-[color:var(--odos-line-2)] p-3 text-sm text-[color:var(--odos-text)]">{error}</p>}
    {!catalog && !error && <p className="mt-3 text-sm text-[color:var(--odos-muted)]">Loading profiles…</p>}
    {catalog && <>
      {!catalog.canWrite && <p className="mt-3 text-sm text-[color:var(--odos-accent)]">Read only. Profile changes require the field-management grant.</p>}
      <ul className="mt-4 space-y-2">
        {catalog.profiles.map(profile => <li key={profile.profileKey} className="flex flex-wrap items-center gap-2 rounded border border-[color:var(--odos-line)] p-3">
          <button type="button" disabled={saving} aria-label={`Open profile ${profile.label}`} onClick={() => open(profile)} className="min-w-0 flex-1 break-words text-left text-sm underline decoration-[color:var(--odos-line-2)] underline-offset-4">{profile.label}</button>
          <span className="text-xs text-[color:var(--odos-muted)]">{profile.versionId ? "Practice copy" : "Shipped"}</span>
          {catalog.canWrite ? <button type="button" disabled={saving} aria-label={`${profile.active ? "Turn off" : "Turn on"} ${profile.label}`} onClick={() => { const { versionId: _versionId, ...draft } = profile; void persist(profile, { ...draft, active: !profile.active }); }} className={buttonClass}>{profile.active ? "On" : "Off"}</button> : <span className="text-xs">{profile.active ? "On" : "Off"}</span>}
        </li>)}
      </ul>
      {editing && <form aria-label="Edit follow-up profile" onSubmit={event => { event.preventDefault(); void persist(editing.original, editing.draft); }} className="mt-5 border-t border-[color:var(--odos-line)] pt-5">
        <h3 className="text-lg font-semibold">{editing.original ? editing.draft.label : "New profile"}</h3>
        <label className="mt-3 block text-sm">Profile name<input required disabled={disabled} value={editing.draft.label} onChange={event => change("label", event.target.value)} className="mt-1 block w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-2" /></label>
        <div className="mt-3 text-xs text-[color:var(--odos-muted)]">History template: {editing.draft.historyTemplate.label ?? editing.draft.historyTemplate.key}{editing.draft.historyTemplate.unavailableReason && ` · Unavailable: ${editing.draft.historyTemplate.unavailableReason}`}</div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <ChoiceList title="Opens" items={editing.draft.sectionsOpen} options={catalog.choices.sectionsOpen} getKey={referenceKey} getLabel={referenceLabel} disabled={disabled} fixed={row => row.key === "hpi" || row.key === "assessment"} onChange={value => change("sectionsOpen", value)} />
          <ChoiceList title="Tests" items={editing.draft.testsQueuedByDefault} options={catalog.choices.testsQueuedByDefault} getKey={testKey} getLabel={testLabel} disabled={disabled} onChange={value => change("testsQueuedByDefault", value)} />
          <ChoiceList title="Prior values" items={editing.draft.priorValuesShown} options={catalog.choices.priorValuesShown} getKey={referenceKey} getLabel={referenceLabel} disabled={disabled} onChange={value => change("priorValuesShown", value)} />
          <ChoiceList title="History questions" items={editing.draft.historyItems} options={catalog.choices.historyItems} getKey={stringKey} getLabel={row => row === "core" ? "Core interval questions" : row} disabled={disabled} onChange={value => change("historyItems", value)} />
          <ChoiceList title="Diagnoses that select it" items={editing.draft.matchesDiagnosisFamilies} options={catalog.choices.matchesDiagnosisFamilies} getKey={stringKey} getLabel={stringKey} disabled={disabled} onChange={value => change("matchesDiagnosisFamilies", value)} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" disabled={saving} onClick={() => setEditing(null)} className={buttonClass}>Close</button>
          {catalog.canWrite && <>
            {editing.original && catalog.shipped.some(row => row.profileKey === editing.original!.profileKey) && <button type="button" aria-label="Reset to shipped" disabled={saving} onClick={() => void persist(editing.original, editing.draft, true)} className={buttonClass}>Reset to shipped</button>}
            <button type="submit" disabled={saving} className="rounded bg-brand px-4 py-2 text-sm disabled:opacity-40">{saving ? "Saving…" : "Save profile"}</button>
          </>}
        </div>
      </form>}
    </>}
  </section>;
}

function ChoiceList<T>({ title, items, options, getKey, getLabel, disabled, fixed, onChange }: {
  title: string; items: T[]; options: T[]; getKey(row: T): string; getLabel(row: T): string;
  disabled: boolean; fixed?(row: T): boolean; onChange(rows: T[]): void;
}) {
  const selected = new Set(items.map(getKey));
  function move(index: number, direction: number) {
    const next = [...items]; const target = index + direction;
    [next[index], next[target]] = [next[target]!, next[index]!]; onChange(next);
  }
  return <fieldset disabled={disabled} className="min-w-0 rounded border border-[color:var(--odos-line-2)] p-3">
    <legend className="px-1 text-sm font-semibold">{title}</legend>
    <ol className="space-y-3">{items.map((item, index) => {
      const reason = typeof item === "object" && item !== null && "unavailableReason" in item ? String(item.unavailableReason) : undefined;
      return <li key={getKey(item)} className="min-w-0 border-b border-[color:var(--odos-line)] pb-2">
        <div className="break-words text-sm">{getLabel(item)}</div>
        {reason && <p className="mt-1 break-words text-xs text-[color:var(--odos-accent)]">Unavailable: {reason}</p>}
        <div className="mt-1 flex flex-wrap gap-1">
          <button type="button" aria-label={`Move up ${getLabel(item)}`} disabled={disabled || index === 0} onClick={() => move(index, -1)} className={buttonClass}>↑</button>
          <button type="button" aria-label={`Move down ${getLabel(item)}`} disabled={disabled || index === items.length - 1} onClick={() => move(index, 1)} className={buttonClass}>↓</button>
          <button type="button" aria-label={`Remove ${getLabel(item)}`} disabled={disabled || fixed?.(item)} onClick={() => onChange(items.filter((_, i) => i !== index))} className={buttonClass}>Remove</button>
        </div>
      </li>;
    })}</ol>
    {!items.length && <p className="text-sm text-[color:var(--odos-faint)]">None selected</p>}
    <label className="mt-3 block text-xs">Add from catalogue<select aria-label={`Add ${title}`} disabled={disabled} value="" onChange={event => { const option = options.find(row => getKey(row) === event.target.value); if (option !== undefined) onChange([...items, structuredClone(option)]); }} className="mt-1 w-full min-w-0 rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-2 text-sm">
      <option value="">Choose…</option>
      {options.filter(row => !selected.has(getKey(row))).map(row => <option key={getKey(row)} value={getKey(row)}>{getLabel(row)}</option>)}
    </select></label>
  </fieldset>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
