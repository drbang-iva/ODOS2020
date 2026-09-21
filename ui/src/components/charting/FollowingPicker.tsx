import { useEffect, useState } from "react";
import { appendPreviousExamsPage, formatDiagnosisHistoryDate, loadPreviousExamsPage, type PreviousExamGroup } from "../../lib/diagnosis-carry-forward";

export interface FollowingChoice {
  examScope: "comprehensive" | "office-visit";
  following: { sourceEncounterReference: string; sourceConditionReference: string } | null;
}

export function FollowingPicker({ encounterReference, source, busy, onPick }: {
  encounterReference: string;
  source?: "derived" | "explicit";
  busy: boolean;
  onPick: (choice: FollowingChoice) => Promise<boolean>;
}) {
  const [changing, setChanging] = useState(false);
  const [template, setTemplate] = useState<FollowingChoice["examScope"]>("office-visit");
  const [exams, setExams] = useState<PreviousExamGroup[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const shown = source !== "explicit" || changing;
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    setLoading(true); setError(undefined); setExams([]); setCursor(undefined);
    void loadPreviousExamsPage(encounterReference, undefined).then(page => {
      if (!cancelled) { setExams(page.encounters); setCursor(page.nextCursor); }
    }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [encounterReference, shown, retry]);
  async function more() {
    setLoading(true); setError(undefined);
    try {
      const page = await loadPreviousExamsPage(encounterReference, cursor);
      setExams(current => appendPreviousExamsPage(current, page)); setCursor(page.nextCursor);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }
  async function choose(choice: FollowingChoice) {
    if (busy) return;
    if (await onPick(choice)) setChanging(false);
  }
  if (!shown) return <button type="button" data-testid="change-following" className="scheduler-button" disabled={busy} onClick={() => setChanging(true)}>Change what we're following</button>;
  return <section aria-label="What are we following?" className="rounded border border-[var(--odos-overlay-line-2)] p-3" style={{ marginTop: 12 }}>
    <h2 className="text-base font-semibold">What are we following?</h2>
    <p className="my-2 text-sm text-[color:var(--odos-muted)]">Choose a previous diagnosis to shape this visit. Findings and diagnoses are not copied.</p>
    <label className="flex flex-wrap items-center gap-2 text-sm">Template
      <select aria-label="Follow-up template" value={template} disabled={busy} onChange={event => setTemplate(event.target.value as FollowingChoice["examScope"])} className="rounded border border-[var(--odos-overlay-line-2)] bg-bg-deep px-2 py-2">
        <option value="comprehensive">Comprehensive</option><option value="office-visit">Office visit</option>
      </select>
    </label>
    <div className="my-3 grid gap-3">
      {[...exams].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map(exam => <div key={exam.encounterReference}>
        <h3 className="text-sm text-[color:var(--odos-muted)]">{formatDiagnosisHistoryDate(exam.date)}</h3>
        {exam.diagnoses.length === 0 && <p className="text-sm text-[color:var(--odos-muted)]">No diagnoses recorded</p>}
        {exam.diagnoses.map(diagnosis => <div key={diagnosis.conditionReference} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--odos-overlay-line-2)] py-2">
          <span className="text-sm">{diagnosis.display} · {diagnosis.identity.laterality}</span>
          <button type="button" className="scheduler-button" disabled={busy} onClick={() => choose({ examScope: template, following: { sourceEncounterReference: exam.encounterReference, sourceConditionReference: diagnosis.conditionReference } })}>Follow this</button>
        </div>)}
      </div>)}
    </div>
    {loading && <p role="status">Loading previous exams…</p>}
    {!loading && !error && exams.length === 0 && <p className="my-2 text-sm">No previous exams.</p>}
    {error && <p role="status">Previous exams could not be loaded. Patient history is unavailable here. You can still choose a template or Nothing to follow. <button type="button" className="scheduler-button" disabled={busy || loading} onClick={() => cursor ? void more() : setRetry(value => value + 1)}>Retry</button></p>}
    <div className="flex flex-wrap gap-2">
      {cursor && <button type="button" className="scheduler-button" disabled={busy || loading} onClick={() => void more()}>Earlier exams</button>}
      <button type="button" data-testid="nothing-to-follow" className="scheduler-button" disabled={busy} onClick={() => choose({ examScope: "office-visit", following: null })}>Nothing to follow · Office visit</button>
      {changing && <button type="button" className="scheduler-button" disabled={busy} onClick={() => setChanging(false)}>Cancel</button>}
    </div>
  </section>;
}
