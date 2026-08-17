import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ExamEntrySheet,
  isExamEntrySheetSectionId,
} from "../../src/components/charting/ExamEntrySheet";
import { RefractionSection } from "../../src/components/charting/RefractionSection";
import { VaSection } from "../../src/components/charting/VaSection";
import "../../src/styles/globals.css";

type FixtureSectionId = "pupils" | "iop" | "va" | "refraction";

window.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/clinical-graph/refraction/definition")) {
    return Response.json({
      definition: {
        fields: {
          type: { options: [{ code: "MANIFEST", display: "Manifest" }] },
          sourceType: { options: [{ code: "manual", display: "Manual" }] },
          sphere: { minimum: -20, maximum: 20, step: 0.25 },
          axis: { minimum: 0, maximum: 180, step: 1 },
        },
      },
      diagnosisOptions: [],
      refractiveThreshold: 0,
    });
  }
  if (url.includes("/clinical-graph/refraction/history")) {
    return Response.json({ glasses: [], softCl: [], specialtyCl: [] });
  }
  return Response.json({});
};

function Fixture() {
  const [active, setActive] = useState<FixtureSectionId>();
  const mapped = active ? isExamEntrySheetSectionId(active) : false;
  const editor = active ? renderEditor(active) : null;
  return (
    <main className="min-h-screen bg-bg-deep text-white">
      <div className="flex min-h-14 items-center gap-3 border-b border-white/10 px-4" data-testid="fixture-exam-context">
        {(["pupils", "iop", "va", "refraction"] as const).map((sectionId) => (
          <button key={sectionId} type="button" onClick={() => setActive(sectionId)}>
            Open {sectionId === "iop" ? "IOP" : sectionId === "va" ? "Visual Acuity" : sectionId === "refraction" ? "Refraction" : "Pupils"}
          </button>
        ))}
      </div>
      {active === "refraction" && !mapped ? (
        <div className="h-[calc(100vh-56px)]" data-testid="fixture-full-page-refraction">
          {editor}
        </div>
      ) : (
        <div className="odos-exam-overview-stage" data-entry-sheet-open={mapped ? "true" : "false"}>
          <section className="min-h-[700px] border-r border-white/10 p-6" data-testid="fixture-exam-column">
            <h1>Exam overview</h1>
            <button type="button">Exam source row</button>
          </section>
          {active && isExamEntrySheetSectionId(active) && (
          <ExamEntrySheet sectionId={active} onCancel={() => setActive(undefined)}>
              {editor}
          </ExamEntrySheet>
          )}
        </div>
      )}
    </main>
  );
}

function renderEditor(sectionId: FixtureSectionId) {
  if (sectionId === "va") {
    return <VaSection patientReference="Patient/test" encounterReference="Encounter/test" onSaved={() => undefined} />;
  }
  if (sectionId === "refraction") {
    return <RefractionSection patientReference="Patient/test" encounterReference="Encounter/test" onSaved={() => undefined} />;
  }
  return (
    <div className="p-6">
      <button type="button" className="min-h-11 min-w-11">Fixture save</button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
