import { EXAM_DESTINATIONS, type ExamDestination } from "../../lib/exam-navigation";

export function ExamNavigation({ active, onSelect }: {
  active: ExamDestination;
  onSelect: (destination: ExamDestination) => void;
}) {
  return <nav className="odos-exam-navigation" aria-label="Exam sections">
    {EXAM_DESTINATIONS.map(([key, label]) => <button key={key} type="button"
      aria-current={active === key ? "page" : undefined} onClick={() => onSelect(key)}>{label}</button>)}
  </nav>;
}
