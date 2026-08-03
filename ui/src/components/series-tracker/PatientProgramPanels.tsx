import type { ReactNode } from "react";

export function PatientProgramPanels({
  packageStatus,
  seriesStatus,
  compact = false,
}: {
  packageStatus?: ReactNode;
  seriesStatus?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "grid gap-2" : "mt-3 grid gap-3"} data-testid="independent-patient-programs">
      {packageStatus}
      {seriesStatus}
    </div>
  );
}
