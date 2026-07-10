import { useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { AssessmentSection } from "../components/charting/AssessmentSection";
import { AutoRefractionSection } from "../components/charting/AutoRefractionSection";
import { CupDiscSection } from "../components/charting/CupDiscSection";
import { DryEyeSection } from "../components/charting/DryEyeSection";
import { EncounterHeader } from "../components/charting/EncounterHeader";
import { IopSection } from "../components/charting/IopSection";
import { MyopiaManagementSection } from "../components/charting/MyopiaManagementSection";
import { OrthoKSection } from "../components/charting/OrthoKSection";
import { RefractionSection } from "../components/charting/RefractionSection";
import { RefractionHistorySection } from "../components/charting/RefractionHistorySection";
import { SoftContactLensSection } from "../components/charting/SoftContactLensSection";
import { SpecialtyContactLensSection } from "../components/charting/SpecialtyContactLensSection";
import { SpineNav } from "../components/charting/SpineNav";
import { VaSection } from "../components/charting/VaSection";
import { WearingSection } from "../components/charting/WearingSection";
import { useRole } from "../lib/role-context";
import type { ChartSectionId, SectionSaveStatus, SectionStatusMap } from "../components/charting/types";

interface Props {
  patient: Patient;
  encounterId: string;
}

const EMPTY_STATUSES: SectionStatusMap = {
  wearing: { completed: false },
  "auto-refraction": { completed: false },
  va: { completed: false },
  refraction: { completed: false },
  "soft-contact-lens": { completed: false },
  "specialty-contact-lens": { completed: false },
  "refraction-history": { completed: false },
  "ortho-k": { completed: false },
  "dry-eye": { completed: false },
  "myopia-management": { completed: false },
  "cup-disc": { completed: false },
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
          {activeSection === "wearing" && (
            <WearingSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("wearing", status)}
            />
          )}
          {activeSection === "auto-refraction" && (
            <AutoRefractionSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("auto-refraction", status)}
            />
          )}
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
          {activeSection === "soft-contact-lens" && (
            <SoftContactLensSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("soft-contact-lens", status)}
            />
          )}
          {activeSection === "specialty-contact-lens" && (
            <SpecialtyContactLensSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("specialty-contact-lens", status)}
            />
          )}
          {activeSection === "refraction-history" && (
            <RefractionHistorySection patientReference={patientReference} />
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
          {activeSection === "cup-disc" && (
            <CupDiscSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("cup-disc", status)}
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
