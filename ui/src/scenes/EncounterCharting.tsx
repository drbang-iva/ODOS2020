import { useEffect, useState } from "react";
import type { Encounter, Patient } from "@medplum/fhirtypes";
import { ChartSidebar } from "../components/ChartSidebar";
import { ReferralCompose } from "../components/referral/ReferralCompose";
import { AestheticsConsentSection } from "../components/charting/AestheticsConsentSection";
import { AssessmentSection } from "../components/charting/AssessmentSection";
import { AutoRefractionSection } from "../components/charting/AutoRefractionSection";
import { EntranceStateSection } from "../components/charting/EntranceStateSection";
import { EntranceMeasurementSection } from "../components/charting/EntranceMeasurementSection";
import { DilationSection } from "../components/charting/DilationSection";
import { EomSection } from "../components/charting/EomSection";
import { CoverTestSection } from "../components/charting/CoverTestSection";
import { CvfSection } from "../components/charting/CvfSection";
import { CupDiscSection } from "../components/charting/CupDiscSection";
import { GonioscopySection } from "../components/charting/GonioscopySection";
import { CustomFindingSection, type CustomFindingDefinition } from "../components/charting/CustomFindingSection";
import { CustomSectionEditor, type CustomSectionEditorValue } from "../components/charting/CustomSectionEditor";
import { DryEyeSection } from "../components/charting/DryEyeSection";
import { EncounterHeader } from "../components/charting/EncounterHeader";
import { EyeGrowthSection } from "../components/charting/EyeGrowthSection";
import { IopSection } from "../components/charting/IopSection";
import { ImagingSection } from "../components/charting/ImagingSection";
import { HpiSection } from "../components/charting/HpiSection";
import { MyopiaManagementSection } from "../components/charting/MyopiaManagementSection";
import { OcularHealthSection } from "../components/charting/OcularHealthSection";
import { PrescriptionSection } from "../components/charting/PrescriptionSection";
import { OrthoKSection } from "../components/charting/OrthoKSection";
import { RefractionSection } from "../components/charting/RefractionSection";
import { RefractionHistorySection } from "../components/charting/RefractionHistorySection";
import { SoftContactLensSection } from "../components/charting/SoftContactLensSection";
import { SpecialtyContactLensSection } from "../components/charting/SpecialtyContactLensSection";
import { SpineNav } from "../components/charting/SpineNav";
import { VaSection } from "../components/charting/VaSection";
import { WearingSection } from "../components/charting/WearingSection";
import { authHeaders, clinicalGraphApiBase } from "../lib/clinical-graph-client";
import { fhir } from "../lib/fhir";
import {
  filterDefinitionsForSectionGroups,
  type FindingSectionGroupCatalog,
} from "../lib/finding-section-groups";
import { useRole } from "../lib/role-context";
import { ODOS_DISCIPLINE_SYSTEM, type SchedulingDiscipline } from "../lib/scheduling";
import type { ChartSectionId, SectionSaveStatus, SectionStatusMap } from "../components/charting/types";

interface Props {
  patient: Patient;
  encounterId: string;
}

interface CatalogResponse {
  canWrite: boolean;
  definitions: CustomFindingDefinition[];
  error?: string;
}

interface ProcedureCatalogResponse {
  definitions: CustomFindingDefinition[];
  error?: string;
}

let sidebarExpandedForSession = false;

export function EncounterCharting({ patient, encounterId }: Props) {
  const { config } = useRole();
  const [activeSection, setActiveSection] = useState<ChartSectionId>("va");
  const [statuses, setStatuses] = useState<SectionStatusMap>({});
  const [catalog, setCatalog] = useState<CatalogResponse>({ canWrite: false, definitions: [] });
  const [sectionGroupCatalog, setSectionGroupCatalog] = useState<FindingSectionGroupCatalog>({
    canWrite: false,
    groups: [],
    visitTypeCategories: [],
    effectiveGroupKeys: [],
  });
  const [procedureCatalog, setProcedureCatalog] = useState<ProcedureCatalogResponse>({ definitions: [] });
  const [discipline, setDiscipline] = useState<SchedulingDiscipline>();
  const [creatingSection, setCreatingSection] = useState(false);
  const [savingSection, setSavingSection] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(sidebarExpandedForSession);
  const [referralComposeOpen, setReferralComposeOpen] = useState(false);
  const [eyeGrowthDefaultVisible, setEyeGrowthDefaultVisible] = useState(false);
  const [addingSectionGroup, setAddingSectionGroup] = useState(false);
  const [sectionGroupError, setSectionGroupError] = useState<string | null>(null);

  function setSidebarOpen(expanded: boolean) {
    sidebarExpandedForSession = expanded;
    setSidebarExpanded(expanded);
  }

  async function loadCatalog() {
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-definitions`, { headers: authHeaders() });
      const body = await response.json() as CatalogResponse;
      if (!response.ok) throw new Error(body.error ?? `Finding-definition catalog failed: ${response.status}`);
      setCatalog(body);
    } catch (caught) {
      console.error("Custom section catalog unavailable; charting built-ins only.", caught);
      setCatalog({ canWrite: false, definitions: [] });
    }
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ encounterId });
    fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-section-groups?${query}`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as FindingSectionGroupCatalog;
        if (!response.ok) {
          throw new Error(body.error ?? `Finding section groups failed: ${response.status}`);
        }
        return body;
      })
      .then((body) => {
        setSectionGroupCatalog({
          ...body,
          canWrite: body.canWrite === true,
          groups: Array.isArray(body.groups) ? body.groups : [],
          visitTypeCategories: Array.isArray(body.visitTypeCategories) ? body.visitTypeCategories : [],
          effectiveGroupKeys: Array.isArray(body.effectiveGroupKeys) ? body.effectiveGroupKeys : [],
        });
        setSectionGroupError(null);
      })
      .catch((caught) => {
        if ((caught as Error).name === "AbortError") return;
        console.error("Finding section groups unavailable; definitions remain ungated.", caught);
        setSectionGroupCatalog({
          canWrite: false,
          groups: [],
          visitTypeCategories: [],
          effectiveGroupKeys: [],
        });
        setSectionGroupError("Section-group visibility could not be loaded.");
      });
    return () => controller.abort();
  }, [encounterId]);

  async function loadEyeGrowthVisibility(signal?: { cancelled: boolean }) {
    try {
      const patientReference = `Patient/${patient.id}`;
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/eye-growth/visibility?${new URLSearchParams({ patient: patientReference })}`,
        { headers: authHeaders() },
      );
      const body = await response.json() as { defaultVisible?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Eye-growth visibility failed: ${response.status}`);
      if (signal?.cancelled) return;
      setEyeGrowthDefaultVisible(body.defaultVisible === true);
    } catch (caught) {
      if (signal?.cancelled) return;
      console.error("Eye-growth visibility unavailable; section remains available on demand.", caught);
      setEyeGrowthDefaultVisible(false);
    }
  }

  useEffect(() => {
    const signal = { cancelled: false };
    void loadEyeGrowthVisibility(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [patient.id]);

  useEffect(() => {
    let cancelled = false;
    fhir.read<Encounter>("Encounter", encounterId)
      .then((encounter) => {
        const code = encounter.serviceType?.coding?.find((coding) =>
          coding.system === ODOS_DISCIPLINE_SYSTEM
        )?.code;
        if (cancelled) return;
        if (code === "eyecare" || code === "aesthetics") {
          setDiscipline(code);
          if (code === "aesthetics") {
            setActiveSection((current) => current === "va" ? "aesthetics-consent" : current);
          }
        }
      })
      .catch((caught) => {
        if (!cancelled) console.error("Encounter discipline unavailable.", caught);
      });
    return () => {
      cancelled = true;
    };
  }, [encounterId]);

  useEffect(() => {
    if (discipline !== "aesthetics") {
      setProcedureCatalog({ definitions: [] });
      return;
    }
    const controller = new AbortController();
    fetch(`${clinicalGraphApiBase()}/clinical-graph/procedure-definitions`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as ProcedureCatalogResponse;
        if (!response.ok) {
          throw new Error(body.error ?? `Procedure-definition catalog failed: ${response.status}`);
        }
        return body;
      })
      .then(setProcedureCatalog)
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") {
          console.error("Procedure definition catalog unavailable.", caught);
          setProcedureCatalog({ definitions: [] });
        }
      });
    return () => controller.abort();
  }, [discipline]);

  useEffect(() => {
    if (!sidebarExpanded) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSidebarOpen(false);
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [sidebarExpanded]);

  async function createSection(value: CustomSectionEditorValue) {
    setSavingSection(true);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-definitions`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-definition", ...value }),
      });
      const body = await response.json() as { definition?: CustomFindingDefinition; error?: string };
      if (!response.ok || !body.definition) throw new Error(body.error ?? `Section creation failed: ${response.status}`);
      setCreatingSection(false);
      await loadCatalog();
      setActiveSection(body.definition.stableKey as ChartSectionId);
    } finally {
      setSavingSection(false);
    }
  }

  async function addSectionGroup(groupKey: string) {
    setAddingSectionGroup(true);
    setSectionGroupError(null);
    try {
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/section-groups`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ action: "add", groupKey }),
        },
      );
      const body = await response.json() as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `Section-group pull-in failed: ${response.status}`);
      }
      setSectionGroupCatalog((current) => ({
        ...current,
        pulledInGroupKeys: [...new Set([...(current.pulledInGroupKeys ?? []), groupKey])],
        effectiveGroupKeys: [...new Set([...(current.effectiveGroupKeys ?? []), groupKey])],
      }));
    } catch (caught) {
      setSectionGroupError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAddingSectionGroup(false);
    }
  }

  function markSaved(section: ChartSectionId, status: SectionSaveStatus) {
    setStatuses((current) => ({
      ...current,
      [section]: status,
    }));
  }

  const patientReference = `Patient/${patient.id}`;
  const encounterReference = `Encounter/${encounterId}`;
  const visibleDefinitions = filterDefinitionsForSectionGroups(
    catalog.definitions,
    sectionGroupCatalog.groups,
    sectionGroupCatalog.effectiveGroupKeys ?? [],
  );
  const customDefinitions = visibleDefinitions.filter((definition) =>
    definition.sectionKey?.startsWith("custom:")
  );
  const entranceDefinitions = visibleDefinitions.filter((definition) =>
    definition.sectionKey?.startsWith("entrance:")
  );
  const pupilsDefinition = entranceDefinitions.find((definition) => definition.stableKey === "entrance:pupils");
  const stereopsisDefinition = entranceDefinitions.find((definition) => definition.stableKey === "entrance:stereo");
  const colorDefinition = entranceDefinitions.find((definition) => definition.stableKey === "entrance:color");
  const eomDefinition = entranceDefinitions.find((definition) => definition.stableKey === "entrance:eom");
  const cvfDefinition = entranceDefinitions.find((definition) => definition.stableKey === "entrance:cvf");
  const pachymetryDefinition = entranceDefinitions.find((definition) => definition.stableKey === "pachymetry_um");
  const manualKDefinition = entranceDefinitions.find((definition) => definition.stableKey === "manual_keratometry");
  const dilationDefinition = entranceDefinitions.find((definition) => definition.stableKey === "entrance:dilation");
  const ocularHealthDefinitions = visibleDefinitions.filter((definition) =>
    definition.sectionKey?.startsWith("ocular-health:")
  );
  const ocularHealthSections = ocularHealthDefinitions.map((definition) => ({
    id: definition.stableKey as ChartSectionId,
    label: definition.display,
    segment: definition.stableKey.startsWith("ocular-health:posterior:") ? "posterior" as const : "anterior" as const,
  }));
  const customSections = customDefinitions.map((definition) => ({ id: definition.stableKey as ChartSectionId, label: definition.display }));
  const procedureDefinitions = procedureCatalog.definitions.filter((definition) =>
    definition.resourceKind === "procedure" &&
    definition.active
  );
  const procedureSections = procedureDefinitions.map((definition) => ({
    id: definition.stableKey as ChartSectionId,
    label: definition.display,
    group: "AESTHETICS",
  }));
  const spineCustomSections = [
    ...(discipline === "aesthetics"
      ? [{ id: "aesthetics-consent" as ChartSectionId, label: "Cosmetic consent", group: "AESTHETICS" }]
      : []),
    ...procedureSections,
    ...customSections,
  ];
  const customDefinition = activeSection.startsWith("custom:")
    ? customDefinitions.find((definition) => definition.stableKey === activeSection)
    : undefined;
  const procedureDefinition = activeSection.startsWith("procedure:")
    ? procedureDefinitions.find((definition) => definition.stableKey === activeSection)
    : undefined;
  const effectiveGroupKeys = new Set(sectionGroupCatalog.effectiveGroupKeys ?? []);
  const availableSectionGroups = sectionGroupCatalog.groups.filter(
    (group) => group.active && !effectiveGroupKeys.has(group.groupKey),
  );

  return (
    <div className={["odos-charting-workspace flex h-screen w-screen flex-col bg-bg-deep text-white", config.encounterDensity === "compact" ? "text-[0.95rem]" : ""].join(" ")}>
      <EncounterHeader patient={patient} encounterId={encounterId} />
      <div className="odos-charting-body flex min-h-0 flex-1 flex-col md:flex-row">
        <SpineNav
          active={activeSection}
          statuses={statuses}
          onSelect={setActiveSection}
          customSections={spineCustomSections}
          ocularHealthSections={ocularHealthSections}
          eyeGrowthDefaultVisible={eyeGrowthDefaultVisible}
          onAddSection={catalog.canWrite ? () => setCreatingSection(true) : undefined}
        />
        <main className="relative min-w-0 flex-1 bg-bg-deep" {...(sidebarExpanded ? { inert: "" } : {})}>
          {(availableSectionGroups.length > 0 || sectionGroupError) && (
            <div className="absolute right-4 top-3 z-20 flex max-w-sm items-center gap-2">
              {sectionGroupError && (
                <span role="alert" className="rounded border border-red-400/25 bg-bg-panel px-2 py-1 text-xs text-red-200">
                  {sectionGroupError}
                </span>
              )}
              {sectionGroupCatalog.canPullIn && availableSectionGroups.length > 0 && (
                <select
                  aria-label="Add section group"
                  value=""
                  disabled={addingSectionGroup}
                  onChange={(event) => {
                    if (event.target.value) void addSectionGroup(event.target.value);
                  }}
                  className="rounded border border-brand/50 bg-bg-panel px-3 py-2 text-sm text-brand-light shadow-lg"
                >
                  <option value="">{addingSectionGroup ? "Adding section group…" : "Add section group…"}</option>
                  {availableSectionGroups.map((group) => (
                    <option key={group.groupKey} value={group.groupKey}>{group.label}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          {activeSection === "hpi" && (
            <HpiSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("hpi", status)}
            />
          )}
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
          {activeSection === "manual-keratometry" && (manualKDefinition ? (
            <EntranceMeasurementSection definition={manualKDefinition} patientReference={patientReference} encounterReference={encounterReference} onSaved={(status) => markSaved("manual-keratometry", status)} />
          ) : <MissingDefinitionState section="Manual keratometry" />)}
          {activeSection === "pachymetry" && (pachymetryDefinition ? (
            <EntranceMeasurementSection definition={pachymetryDefinition} patientReference={patientReference} encounterReference={encounterReference} onSaved={(status) => markSaved("pachymetry", status)} />
          ) : <MissingDefinitionState section="Pachymetry" />)}
          {activeSection === "va" && (
            <VaSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("va", status)}
            />
          )}
          {activeSection === "pupils" && (pupilsDefinition ? (
            <EntranceStateSection definition={pupilsDefinition} patientReference={patientReference} encounterReference={encounterReference} onSaved={(status) => markSaved("pupils", status)} />
          ) : <MissingDefinitionState section="Pupils" />)}
          {activeSection === "stereopsis" && (stereopsisDefinition ? (
            <EntranceStateSection definition={stereopsisDefinition} patientReference={patientReference} encounterReference={encounterReference} onSaved={(status) => markSaved("stereopsis", status)} />
          ) : <MissingDefinitionState section="Stereopsis" />)}
          {activeSection === "color-vision" && (colorDefinition ? (
            <EntranceStateSection definition={colorDefinition} patientReference={patientReference} encounterReference={encounterReference} onSaved={(status) => markSaved("color-vision", status)} />
          ) : <MissingDefinitionState section="Color vision" />)}
          {activeSection === "eom" && (eomDefinition ? (
            <EomSection definition={eomDefinition} patientReference={patientReference} encounterReference={encounterReference} onSaved={(status) => markSaved("eom", status)} />
          ) : <MissingDefinitionState section="EOM / diplopia" />)}
          {activeSection === "cvf" && (cvfDefinition ? (
            <CvfSection definition={cvfDefinition} patientReference={patientReference} encounterReference={encounterReference} onSaved={(status) => markSaved("cvf", status)} />
          ) : <MissingDefinitionState section="Confrontation visual fields" />)}
          {activeSection === "cover-test" && (
            <CoverTestSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("cover-test", status)}
            />
          )}
          {activeSection === "iop" && (
            <IopSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("iop", status)}
            />
          )}
          {activeSection === "dilation" && (dilationDefinition ? (
            <DilationSection definition={dilationDefinition} patientReference={patientReference} encounterReference={encounterReference} onSaved={(status) => markSaved("dilation", status)} />
          ) : <MissingDefinitionState section="Dilation" />)}
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
          {activeSection === "eye-growth" && (
            <EyeGrowthSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => {
                markSaved("eye-growth", status);
                void loadEyeGrowthVisibility();
              }}
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
          {activeSection === "cup-disc" && (
            <CupDiscSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("cup-disc", status)}
            />
          )}
          {activeSection === "gonioscopy" && (
            <GonioscopySection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("gonioscopy", status)}
            />
          )}
          {activeSection === "imaging" && (
            <ImagingSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("imaging", status)}
            />
          )}
          {activeSection === "assessment" && (
            <AssessmentSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("assessment", status)}
              onRefer={() => setReferralComposeOpen(true)}
            />
          )}
          {activeSection === "prescription" && (
            <PrescriptionSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("prescription", status)}
            />
          )}
          {activeSection === "aesthetics-consent" && discipline === "aesthetics" && (
            <AestheticsConsentSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("aesthetics-consent", status)}
            />
          )}
          {activeSection.startsWith("ocular-health:") && (
            <OcularHealthSection
              definitions={ocularHealthDefinitions}
              focusedStableKey={activeSection}
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status, stableKeys) => stableKeys.forEach((stableKey) => markSaved(stableKey as ChartSectionId, status))}
            />
          )}
          {activeSection.startsWith("custom:") && customDefinition && (
            <CustomFindingSection
              definition={customDefinition}
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved(activeSection, status)}
            />
          )}
          {activeSection.startsWith("procedure:") && procedureDefinition && (
            <CustomFindingSection
              definition={procedureDefinition}
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved(activeSection, status)}
            />
          )}
        </main>
        <div className={`odos-chart-sidebar-shell${sidebarExpanded ? " is-open" : ""}`}>
          {sidebarExpanded && (
            <button
              type="button"
              className="odos-chart-sidebar-scrim"
              aria-label="Close chart sidebar"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          <button
            type="button"
            className="odos-chart-sidebar-toggle"
            aria-controls="encounter-chart-sidebar"
            aria-expanded={sidebarExpanded}
            aria-label={sidebarExpanded ? "Collapse chart sidebar" : "Expand chart sidebar"}
            onClick={() => setSidebarOpen(!sidebarExpanded)}
          >
            <span aria-hidden>{sidebarExpanded ? "›" : "‹"}</span>
            <span aria-hidden>Chart</span>
          </button>
          <div id="encounter-chart-sidebar" className="odos-chart-sidebar-panel">
            <ChartSidebar patient={patient} />
          </div>
        </div>
      </div>
      {creatingSection && (
        <CustomSectionEditor
          saving={savingSection}
          onCancel={() => setCreatingSection(false)}
          onSave={createSection}
        />
      )}
      {referralComposeOpen && (
        <ReferralCompose
          patientReference={patientReference}
          encounterReference={encounterReference}
          onClose={() => setReferralComposeOpen(false)}
        />
      )}
    </div>
  );
}

function MissingDefinitionState({ section }: { section: string }) {
  return (
    <section className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded border border-amber-300/25 bg-amber-300/[0.07] p-6 text-center">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-200">Practice setup needed</div>
        <h2 className="mt-2 text-xl font-semibold">{section} is unavailable</h2>
        <p className="mt-2 text-sm text-[color:var(--odos-muted)]">Its finding definition is missing or inactive. Restore or activate the definition before documenting this section.</p>
      </div>
    </section>
  );
}
