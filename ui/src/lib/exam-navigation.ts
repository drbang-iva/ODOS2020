export const EXAM_DESTINATIONS = [
  ["overview", "Overview"], ["history", "History"], ["entrance", "Entrance"],
  ["pretest", "Pretest"], ["refraction", "Refraction"], ["ocular-health", "Ocular health"],
  ["diagnoses", "Diagnoses"], ["plan-rx", "Plan & Rx"], ["tests", "Tests for today"],
  ["results", "Results"], ["billing", "Billing"], ["review", "Review"],
] as const;
export type ExamDestination = typeof EXAM_DESTINATIONS[number][0];

export function resolveExamDestination(search: string, role: string): ExamDestination {
  const key = new URLSearchParams(search).get("exam");
  const destination = EXAM_DESTINATIONS.find(([value]) => value === key);
  return destination?.[0] ?? (role === "tech" ? "pretest" : "overview");
}

export function writeExamDestination(destination: ExamDestination): void {
  if (typeof window === "undefined" || !window.location?.href || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  url.searchParams.set("exam", destination);
  window.history.replaceState(window.history.state, "", url);
}
