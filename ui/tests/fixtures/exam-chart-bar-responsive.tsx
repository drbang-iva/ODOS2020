import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { ExamChartBar } from "../../src/components/charting/EncounterHeader";
import type { ClinicalExamCompleteness } from "../../src/components/charting/ExamOverviewBoard";
import type { VisitChargeResponse } from "../../src/lib/clinical-graph-client";
import "../../src/styles/globals.css";
import "../../src/styles/charting.css";

interface ResponsiveChartBarProps {
  patientName: string;
  patientDetail: string;
  completeness: ClinicalExamCompleteness;
  unassignedCount: number;
  visitCharge?: VisitChargeResponse;
  visitControlsOpen: boolean;
  onToggleVisitControls: () => void;
  onBlackout: () => void;
  requestFinishEncounter: () => void;
  signDisabled: boolean;
  signLabel: string;
}

const ResponsiveChartBar = ExamChartBar as unknown as (
  props: ResponsiveChartBarProps,
) => React.ReactNode;

const completeness: ClinicalExamCompleteness = {
  status: "incomplete",
  requiredSectionCount: 12,
  resolvedSectionCount: 8,
  trace: [],
  documentationIssues: [],
};

function Fixture() {
  const worstCase = new URLSearchParams(window.location.search).has("worst");
  const visitCharge: VisitChargeResponse | undefined = worstCase ? {
    options: [{
      procedureConceptKey: "long-visit",
      display: "Comprehensive established patient visit with an intentionally long label",
    }],
    diagnoses: [],
    selectedProcedureConceptKey: "long-visit",
    proposal: {
      id: "responsive-proof",
      procedureConceptKey: "long-visit",
      dxPointers: [],
      state: "accepted",
    },
  } : undefined;

  useLayoutEffect(() => {
    if (!worstCase) return;
    const draftSlot = document.querySelector<HTMLElement>('[data-chart-bar-slot="drafts"]');
    if (draftSlot) {
      draftSlot.textContent = "99999 drafts";
      draftSlot.removeAttribute("aria-hidden");
    }
  }, [worstCase]);

  return (
    <ResponsiveChartBar
      patientName={worstCase ? "Alexandria Montgomery-Smith" : "Alex Morgan"}
      patientDetail={worstCase ? "DOB 01/23/1975 · 51y · they/them" : "DOB 01/23/1975 · 51y"}
      completeness={completeness}
      unassignedCount={worstCase ? 88888 : 0}
      visitCharge={visitCharge}
      visitControlsOpen={false}
      onToggleVisitControls={() => undefined}
      onBlackout={() => undefined}
      requestFinishEncounter={() => undefined}
      signDisabled={false}
      signLabel="Sign encounter"
    />
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
