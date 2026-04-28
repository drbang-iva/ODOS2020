import { useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { AssessmentSection } from "../components/charting/AssessmentSection";
import { DryEyeSection } from "../components/charting/DryEyeSection";
import { EncounterHeader } from "../components/charting/EncounterHeader";
import { IopSection } from "../components/charting/IopSection";
import { MyopiaManagementSection } from "../components/charting/MyopiaManagementSection";
import { OrthoKSection } from "../components/charting/OrthoKSection";
import { RefractionSection } from "../components/charting/RefractionSection";
import { SpineNav } from "../components/charting/SpineNav";
import { VaSection } from "../components/charting/VaSection";
import { useRole } from "../lib/role-context";
import type { ChartSectionId, SectionSaveStatus, SectionStatusMap } from "../components/charting/types";

interface Props {
  patient: Patient;
  encounterId: string;
}

const EMPTY_STATUSES: SectionStatusMap = {
  va: { completed: false },
  refraction: { completed: false },
  "ortho-k": { completed: false },
  "dry-eye": { completed: false },
  "myopia-management": { completed: false },
  iop: { completed: false },
  assessment: { completed: false },
};

export function EncounterCharting({ patient, encounterId }: Props) {
  const { config } = useRole();
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
    <div className={["flex h-screen w-screen flex-col bg-bg-deep text-white", config.encounterDensity === "compact" ? "text-[0.95rem]" : ""].join(" ")}>
      <EncounterHeader patient={patient} encounterId={encounterId} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <SpineNav active={activeSection} statuses={statuses} onSelect={setActiveSection} />
        <main className="min-w-0 flex-1 bg-bg-deep">
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
          {activeSection === "ortho-k" && (
            <OrthoKSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("ortho-k", status)}
            />
          )}
          {activeSection === "dry-eye" && (
            <DryEyeSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("dry-eye", status)}
            />
          )}
          {activeSection === "myopia-management" && (
            <MyopiaManagementSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("myopia-management", status)}
            />
          )}
          {activeSection === "assessment" && (
            <AssessmentSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("assessment", status)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
