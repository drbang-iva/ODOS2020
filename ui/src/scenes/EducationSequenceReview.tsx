import { useEffect, useState } from "react";
import { CommunicationsResponseError, listEducationSequenceWork, reviewEducationSequenceStep, type EducationSequenceReviewAction, type EducationSequenceWorkItem } from "../lib/communications-client";

const reasonLabels: Record<string, string> = {
  "patient-seen": "Patient had a visit — clinician review needed",
  "patient-opt-out": "Patient opted out of this channel",
  "content-unavailable": "Education content is unavailable",
  "no-recipient-channel": "Recipient channel is unavailable",
  "needs-acknowledgement": "Outcome needs clinician acknowledgement",
  "latest-useful-time-exceeded": "The useful delivery time has passed",
  "print-handout-due": "Staff handout task",
  "predecessor-anchor-unavailable": "An earlier step needs review before pacing can continue",
  "business-calendar-unavailable": "The pinned business calendar is unavailable",
  "provider-outcome-unknown": "Earlier send outcome needs acknowledgement",
  "attempt-limit": "This step has reached its attempt limit",
};

export function EducationSequenceReview({ canReview }: { canReview: boolean }) {
  const [items, setItems] = useState<EducationSequenceWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    listEducationSequenceWork().then(next => { if (active) setItems(next); })
      .catch(cause => { if (active) { setItems([]); setError(errorText(cause)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  async function review(item: EducationSequenceWorkItem, action: EducationSequenceReviewAction, reason: string, reviewedEncounter: boolean) {
    if (busy || loading || error || !canReview || !reason.trim() || item.state !== "open" || !item.rowId || !item.expectedVersion || !item.allowedActions?.includes(action)) return;
    if (action === "resume" && item.holdReason === "patient-seen" && (!item.encounterReference || !reviewedEncounter)) return;
    setBusy(true);
    setStatus(undefined);
    try {
      await reviewEducationSequenceStep(item.enrollmentId, item.rowId, {
        action, reason: reason.trim(), expectedVersion: item.expectedVersion,
        ...(action === "resume" && item.holdReason === "patient-seen" ? { reviewedEncounterReference: item.encounterReference } : {}),
      });
      setStatus(action === "skip" ? "Review recorded. Step skipped; this does not confirm delivery." : "Review recorded. The step will be checked again before any send.");
      setRevision(value => value + 1);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto grid max-w-5xl gap-5 p-6" aria-labelledby="education-review-title">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 id="education-review-title" className="text-2xl font-semibold">Education sequence review</h1>
        <p className="mt-2 text-sm text-white/70">Review held education steps and staff handout tasks.</p></div>
      <button className="odos-pill" type="button" disabled={loading || busy} onClick={() => { setStatus(undefined); setRevision(value => value + 1); }}>Refresh review list</button>
    </header>
    {!canReview && <p className="text-sm text-white/70">Staff can view this list. A clinician must record a skip or resume decision.</p>}
    {error && <div role="alert" className="rounded border border-red-400/50 p-4 text-red-200">{error} Refresh the review list before taking another action.</div>}
    {status && <p role="status" className="rounded border border-emerald-400/40 p-4">{status}</p>}
    {loading ? <p role="status">Loading education review…</p> : items.length === 0 && !error ? <p>No education steps need review.</p> :
      items.map(item => <ReviewItem key={`${revision}:${item.id}`} item={item} canReview={canReview} disabled={busy || Boolean(error)} onReview={review} />)}
  </main>;
}

function ReviewItem({ item, canReview, disabled, onReview }: {
  item: EducationSequenceWorkItem;
  canReview: boolean;
  disabled: boolean;
  onReview(item: EducationSequenceWorkItem, action: EducationSequenceReviewAction, reason: string, reviewedEncounter: boolean): Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [reviewedEncounter, setReviewedEncounter] = useState(false);
  const actions = canReview && item.state === "open" && item.rowId && item.expectedVersion ? item.allowedActions ?? [] : [];
  const seen = item.holdReason === "patient-seen";
  return <article className="grid gap-3 rounded-xl border border-white/20 bg-white/5 p-5" aria-label={`Education review ${item.id}`}>
    <div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">{item.channel === "print" ? "Staff handout task" : seen ? reasonLabels["patient-seen"] : reasonLabels[item.reason] ?? item.reason.replaceAll("-", " ")}</h2><span className="text-sm text-white/60">{item.state === "settled" ? "Review settled" : "Needs review"}</span></div>
    <dl className="grid gap-1 text-sm text-white/70">
      {item.patientReference && <div><dt className="inline">Patient: </dt><dd className="inline">{item.patientReference}</dd></div>}
      <div><dt className="inline">Enrollment: </dt><dd className="inline">{item.enrollmentId}</dd></div>
      <div><dt className="inline">Recorded: </dt><dd className="inline"><time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time></dd></div>
      {item.channel && <div><dt className="inline">Channel: </dt><dd className="inline">{item.channel === "print" ? "Staff handout" : item.channel.toUpperCase()}</dd></div>}
    </dl>
    {item.channel === "print" && <p className="text-sm">Prepare the handout for staff delivery. This page does not send it electronically or mark it delivered.</p>}
    {["provider-outcome-unknown", "deferral-proof-unavailable", "acceptance-time-unavailable"].includes(item.reason) && <p className="text-sm text-amber-200">An earlier attempt may have reached the patient. Acknowledgement or skipping does not confirm delivery.</p>}
    {actions.length > 0 ? <div className="grid gap-3 border-t border-white/15 pt-3">
      <label className="grid gap-1 text-sm">Clinician reason<textarea aria-label="Clinician reason" className="rounded border border-white/30 bg-black/20 p-2" value={reason} onChange={event => setReason(event.target.value)} disabled={disabled} rows={2} /></label>
      {seen && actions.includes("resume") && (item.encounterReference ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewedEncounter} disabled={disabled} onChange={event => setReviewedEncounter(event.target.checked)} />I reviewed {item.encounterReference} before resuming this step.</label> : <p className="text-sm">The visit reference is unavailable. Refresh the list before resuming.</p>)}
      <p className="text-sm text-white/60">Skipping ends this step and records a pacing anchor. Resuming allows the worker to check it again.</p>
      <div className="flex flex-wrap gap-3">{actions.map(action => <button key={action} type="button" className="odos-pill" disabled={disabled || !reason.trim() || (action === "resume" && seen && (!item.encounterReference || !reviewedEncounter))} onClick={() => void onReview(item, action, reason, reviewedEncounter)}>{action === "skip" ? "Skip sequence step" : "Resume sequence step"}</button>)}</div>
    </div> : item.state === "open" && <p className="text-sm text-white/60">{canReview ? "No review action is currently available for this item." : "Awaiting clinician review."}</p>}
  </article>;
}

function errorText(cause: unknown): string {
  return cause instanceof CommunicationsResponseError ? `Request failed (${cause.status}): ${cause.message}` : cause instanceof Error ? cause.message : "Education review failed.";
}
