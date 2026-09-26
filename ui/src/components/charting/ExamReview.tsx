import { sectionStateLabel, type ClinicalExamCompleteness } from "./ExamOverviewBoard";

export interface ReviewSignAction {
  encounterId: string;
  onSignAndFinish: () => void | Promise<void>;
  disabled: boolean;
  unavailableReason?: string;
  signLabel: string;
}

export function ExamReview({ completeness, loading, onSignAndFinish, disabled, unavailableReason, signLabel }: {
  completeness?: ClinicalExamCompleteness;
  loading: boolean;
  onSignAndFinish: () => void | Promise<void>;
  disabled: boolean;
  unavailableReason?: string;
  signLabel: string;
}) {
  const open = completeness?.trace.filter(row => !row.resolved);
  return <section className="odos-exam-review" aria-labelledby="exam-review-title">
    <h2 id="exam-review-title">Review</h2>
    {loading ? <p>Loading completeness…</p> : !completeness ? <p>Status unavailable</p> : completeness.status === "unconfigured" ? <p>Not tracked — no exam scope set</p> : open!.length === 0 ? <p>Nothing open</p> :
      <ul>{open!.map(row => <li key={row.sectionKey}><strong>{row.label}</strong><span>{sectionStateLabel(row.state)}</span></li>)}</ul>}
    <button type="button" onClick={onSignAndFinish} disabled={disabled} title={unavailableReason}>{signLabel}</button>
  </section>;
}
