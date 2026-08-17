import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EXAM_ENTRY_SHEET_CONFIG,
  ExamEntrySheet,
  type ExamEntrySheetSectionId,
} from "../../src/components/charting/ExamEntrySheet";
import "../../src/styles/globals.css";

function Fixture() {
  const [active, setActive] = useState<ExamEntrySheetSectionId>();
  return (
    <main className="min-h-screen bg-bg-deep text-white">
      <div className="flex min-h-14 items-center gap-3 border-b border-white/10 px-4" data-testid="fixture-exam-context">
        {(Object.keys(EXAM_ENTRY_SHEET_CONFIG) as ExamEntrySheetSectionId[]).map((sectionId) => (
          <button key={sectionId} type="button" onClick={() => setActive(sectionId)}>
            Open {sectionId === "iop" ? "IOP" : EXAM_ENTRY_SHEET_CONFIG[sectionId].title}
          </button>
        ))}
      </div>
      <div className="odos-exam-overview-stage" data-entry-sheet-open={active ? "true" : "false"}>
        <section className="min-h-[700px] border-r border-white/10 p-6" data-testid="fixture-exam-column">
          <h1>Exam overview</h1>
          <button type="button">Exam source row</button>
        </section>
        {active && (
          <ExamEntrySheet sectionId={active} onCancel={() => setActive(undefined)}>
            <div className="p-6">
              <button type="button" className="min-h-11 min-w-11">Fixture save</button>
            </div>
          </ExamEntrySheet>
        )}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
