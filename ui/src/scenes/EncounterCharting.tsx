import { useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { EncounterHeader } from "../components/charting/EncounterHeader";
import { IopSection } from "../components/charting/IopSection";
import { RefractionSection } from "../components/charting/RefractionSection";
import { SpineNav } from "../components/charting/SpineNav";
import { VaSection } from "../components/charting/VaSection";
import type { ChartSectionId, SectionSaveStatus, SectionStatusMap } from "../components/charting/types";

interface Props {
  patient: Patient;
  encounterId: string;
}

const EMPTY_STATUSES: SectionStatusMap = {
  va: { completed: false },
  iop: { completed: false },
  refraction: { completed: false },
};

export function EncounterCharting({ patient, encounterId }: Props) {
  const [activeSection, setActiveSection] = useState<ChartSectionId>("va");
  const [statuses, setStatuses] = useState<SectionStatusMap>(EMPTY_STATUSES);

  function markSaved(section: ChartSectionId, status: SectionSaveStatus) {
    setStatuses((current) => ({
      ...current,
      [section]: status,
    }));
  }

  const patientReference = `Patient/${patient.id}`;
  const encounterReference = `Encounter/${encounterId}`;

  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-white">
      <EncounterHeader patient={patient} encounterId={encounterId} />
      <div className="flex min-h-0 flex-1">
        <SpineNav active={activeSection} statuses={statuses} onSelect={setActiveSection} />
        <main className="min-w-0 flex-1 bg-bg">
          {activeSection === "va" && (
            <VaSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("va", status)}
            />
          )}
          {activeSection === "iop" && (
            <IopSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("iop", status)}
            />
          )}
          {activeSection === "refraction" && (
            <RefractionSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("refraction", status)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
