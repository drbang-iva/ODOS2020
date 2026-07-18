import type { ReactNode } from "react";

export function PatientProgramPanels({
  packageStatus,
  seriesStatus,
}: {
  packageStatus?: ReactNode;
  seriesStatus?: ReactNode;
}) {
  return (
    <div className="mt-3 grid gap-3" data-testid="independent-patient-programs">
      {packageStatus}
      {seriesStatus}
    </div>
  );
}
