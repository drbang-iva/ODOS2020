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
import { DryEyeGlandStructureSection } from "../components/charting/DryEyeGlandStructureSection";
import { EncounterHeader } from "../components/charting/EncounterHeader";
import {
  ExamOverviewBoard,
  isExamOverviewProjection,
  type ExamOverviewProjection,
} from "../components/charting/ExamOverviewBoard";
import {
  ExamEntrySheet,
  isExamEntrySheetSectionId,
  type ExamEntrySheetSectionId,
} from "../components/charting/ExamEntrySheet";
import { EyeGrowthSection } from "../components/charting/EyeGrowthSection";
import { EncounterFindingOverlay } from "../components/charting/EncounterFindingOverlay";
import { IopSection } from "../components/charting/IopSection";
import { ImagingSection } from "../components/charting/ImagingSection";
import { DiagnosisWorkspace, diagnosisWorkspaceInstanceKey } from "../components/charting/DiagnosisWorkspace";
import { OdosSelect } from "../components/inputs/OdosSelect";
import { HpiSection } from "../components/charting/HpiSection";
import { MyopiaManagementSection } from "../components/charting/MyopiaManagementSection";
import { OcularHealthSection } from "../components/charting/OcularHealthSection";
import { PrescriptionSection } from "../components/charting/PrescriptionSection";
import { OrthoKSection } from "../components/charting/OrthoKSection";
import { RefractionSection } from "../components/charting/RefractionSection";
import { RefractionHistorySection } from "../components/charting/RefractionHistorySection";
import { SoftContactLensSection } from "../components/charting/SoftContactLensSection";
import { SpecialtyContactLensSection } from "../components/charting/SpecialtyContactLensSection";
import { chartEditorInventory, SpineNav } from "../components/charting/SpineNav";
import { VaSection } from "../components/charting/VaSection";
import { WearingSection } from "../components/charting/WearingSection";
import { authHeaders, clinicalGraphApiBase } from "../lib/clinical-graph-client";
import { loadDiagnosisFindings } from "../lib/diagnosis-findings";
import { fhir } from "../lib/fhir";
import {
  loadEncounterChartView,
  saveEncounterChartView,
  type EncounterChartView,
} from "../lib/diagnosis-workspace-preferences";
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
    overrideGroupKeys: [],
    effectiveGroupKeys: [],
  });
  const [procedureCatalog, setProcedureCatalog] = useState<ProcedureCatalogResponse>({ definitions: [] });
  const [discipline, setDiscipline] = useState<SchedulingDiscipline>();
  const [encounterRecordedAt, setEncounterRecordedAt] = useState<string>();
  const [creatingSection, setCreatingSection] = useState(false);
  const [savingSection, setSavingSection] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(sidebarExpandedForSession);
  const [referralComposeOpen, setReferralComposeOpen] = useState(false);
  const [eyeGrowthDefaultVisible, setEyeGrowthDefaultVisible] = useState(false);
  const [addingSectionGroup, setAddingSectionGroup] = useState(false);
  const [sectionGroupError, setSectionGroupError] = useState<string | null>(null);
  const [chartView, setChartView] = useState<EncounterChartView>(loadEncounterChartView);
  const [selectedDiagnosis, setSelectedDiagnosis] = useState<{ workspaceKey: string; reference: string }>();
  const [examOverviewProjection, setExamOverviewProjection] = useState<ExamOverviewProjection>();
  const [examOverviewRefreshing, setExamOverviewRefreshing] = useState(false);
  const [examOverviewRefreshVersion, setExamOverviewRefreshVersion] = useState(0);
  const [boardEditorOpen, setBoardEditorOpen] = useState(false);
  const [entrySheetSection, setEntrySheetSection] = useState<ExamEntrySheetSectionId>();
  const [unassignedCount, setUnassignedCount] = useState<number>();

  function setSidebarOpen(expanded: boolean) {
    sidebarExpandedForSession = expanded;
    setSidebarExpanded(expanded);
  }

  function selectChartView(view: EncounterChartView) {
    setChartView(view);
    if (view !== "structure") {
      setBoardEditorOpen(false);
      setEntrySheetSection(undefined);
    }
    saveEncounterChartView(view);
  }

  function refreshExamOverview() {
    setExamOverviewRefreshVersion((current) => current + 1);
  }

  function openBoardEditor(sectionId: ChartSectionId) {
    setActiveSection(sectionId);
    if (isExamEntrySheetSectionId(sectionId)) {
      setEntrySheetSection(sectionId);
      setBoardEditorOpen(false);
    } else {
      setEntrySheetSection(undefined);
      setBoardEditorOpen(true);
    }
  }

  function returnToExamOverview() {
    setBoardEditorOpen(false);
    setEntrySheetSection(undefined);
    refreshExamOverview();
  }

  useEffect(() => {
    setBoardEditorOpen(false);
    setEntrySheetSection(undefined);
    setExamOverviewProjection(undefined);
  }, [encounterId]);

  useEffect(() => {
    let cancelled = false;
    setExamOverviewRefreshing(true);
    loadExamOverviewProjection(encounterId)
      .then((projection) => {
        if (!cancelled) setExamOverviewProjection(projection);
      })
      .catch((caught) => {
        if (!cancelled) {
          setExamOverviewProjection(undefined);
          console.error("Exam overview unavailable; retaining the section editor.", caught);
        }
      })
      .finally(() => {
        if (!cancelled) setExamOverviewRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [encounterId, examOverviewRefreshVersion]);

  useEffect(() => {
    let cancelled = false;
    const encounterReference = `Encounter/${encounterId}`;
    setUnassignedCount(undefined);
    void loadDiagnosisFindings(encounterReference)
      .then((payload) => {
        if (!cancelled) setUnassignedCount(payload.unassigned.length);
      })
      .catch((caught) => {
        if (!cancelled) {
          setUnassignedCount(undefined);
          console.error("Unassigned finding count unavailable.", caught);
        }
      });
    return () => { cancelled = true; };
  }, [encounterId, examOverviewRefreshVersion]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const encounterReference = `Encounter/${encounterId}`;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ encounterReference?: string }>).detail;
      if (detail?.encounterReference === encounterReference) refreshExamOverview();
    };
    window.addEventListener("odos:diagnosis-picked", refresh);
    window.addEventListener("odos:encounter-diagnosis-updated", refresh);
    window.addEventListener("odos:encounter-findings-changed", refresh);
    return () => {
      window.removeEventListener("odos:diagnosis-picked", refresh);
      window.removeEventListener("odos:encounter-diagnosis-updated", refresh);
      window.removeEventListener("odos:encounter-findings-changed", refresh);
    };
  }, [encounterId]);

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
          overrideGroupKeys: Array.isArray(body.overrideGroupKeys) ? body.overrideGroupKeys : [],
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
          overrideGroupKeys: [],
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
    setEncounterRecordedAt(undefined);
    fhir.read<Encounter>("Encounter", encounterId)
      .then((encounter) => {
        const code = encounter.serviceType?.coding?.find((coding) =>
          coding.system === ODOS_DISCIPLINE_SYSTEM
        )?.code;
        if (cancelled) return;
        setEncounterRecordedAt(encounter.period?.start ?? encounter.period?.end);
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
        overrideGroupKeys: [...new Set([...(current.overrideGroupKeys ?? []), groupKey])],
        pulledInGroupKeys: [...new Set([...(current.pulledInGroupKeys ?? []), groupKey])],
        effectiveGroupKeys: [...new Set([...(current.effectiveGroupKeys ?? []), groupKey])],
      }));
    } catch (caught) {
      setSectionGroupError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAddingSectionGroup(false);
    }
  }

  async function removeSectionGroup(groupKey: string) {
    setAddingSectionGroup(true);
    setSectionGroupError(null);
    try {
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/section-groups`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove", groupKey }),
        },
      );
      const body = await response.json() as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `Section-group removal failed: ${response.status}`);
      }
      setSectionGroupCatalog((current) => {
        const overrideGroupKeys = (current.overrideGroupKeys ?? [])
          .filter((key) => key !== groupKey);
        const activeGroupKeys = new Set(
          current.groups.filter((group) => group.active).map((group) => group.groupKey),
        );
        const pulledInGroupKeys = overrideGroupKeys.filter((key) => activeGroupKeys.has(key));
        return {
          ...current,
          overrideGroupKeys,
          pulledInGroupKeys,
          effectiveGroupKeys: [...new Set([
            ...(current.defaultGroupKeys ?? []),
            ...pulledInGroupKeys,
          ])],
        };
      });
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
    refreshExamOverview();
  }

  const patientReference = `Patient/${patient.id}`;
  const encounterReference = `Encounter/${encounterId}`;
  const diagnosisWorkspaceKey = diagnosisWorkspaceInstanceKey(patientReference, encounterReference);
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
  const visualFieldDefectDefinition = entranceDefinitions.find(
    (definition) => definition.stableKey === "entrance:visual-field-defect",
  );
  const pachymetryDefinition = entranceDefinitions.find((definition) => definition.stableKey === "pachymetry_um");
  const manualKDefinition = entranceDefinitions.find((definition) => definition.stableKey === "manual_keratometry");
  const dilationDefinition = entranceDefinitions.find((definition) => definition.stableKey === "entrance:dilation");
  const ocularHealthDefinitions = visibleDefinitions.filter((definition) =>
    definition.sectionKey?.startsWith("ocular-health:")
  );
  const tearFilmDefinition = ocularHealthDefinitions.find(
    (definition) => definition.stableKey === "ocular-health:anterior:tear-film",
  );
  const corneaDefinition = ocularHealthDefinitions.find(
    (definition) => definition.stableKey === "ocular-health:anterior:cornea",
  );
  const dryEyeDefinitions = visibleDefinitions.filter((definition) =>
    definition.sectionKey?.startsWith("dry-eye:")
  );
  const dryEyeDefinitionByKey = new Map(
    dryEyeDefinitions.map((definition) => [definition.stableKey, definition]),
  );
  const dryEyeSections = dryEyeDefinitions.length === 0
    ? []
    : [
        section("dry-eye:symptoms", "Symptoms"),
        ...(tearFilmDefinition
          ? [section("dry-eye:tear-stability", "Tear Stability")]
          : []),
        section("dry-eye:tear-volume", "Tear Volume"),
        section("dry-eye:markers", "Tear Film Markers"),
        section("dry-eye:gland-structure", "Gland Structure"),
        section("dry-eye:gland-function", "Gland Function"),
        section("dry-eye:conjunctival-staining", "Surface Staining"),
        section("dry-eye:staging", "Staging & Subtype"),
      ].filter((candidate) =>
        candidate.id === "dry-eye:tear-stability" ||
        dryEyeDefinitionByKey.has(candidate.id)
      );
  const ocularHealthSections = ocularHealthDefinitions.map((definition) => ({
    id: definition.stableKey as ChartSectionId,
    label: definition.display,
    segment: definition.stableKey.startsWith("ocular-health:posterior:") ? "posterior" as const : "anterior" as const,
  }));
  const customSections = customDefinitions.map((definition) => ({ id: definition.stableKey as ChartSectionId, label: definition.display }));
  const procedureDefinitions = procedureCatalog.definitions.filter((definition) =>
    definition.resourceKind === "procedure" &&
    definition.active &&
    definition.discipline === discipline
  );
  const procedureSections = procedureDefinitions.map((definition) => ({
    id: definition.stableKey as ChartSectionId,
    label: definition.display,
    group: "AESTHETICS",
  }));
  const spineCustomSections = [
    ...dryEyeSections,
    ...(discipline === "aesthetics"
      ? [{ id: "aesthetics-consent" as ChartSectionId, label: "Cosmetic consent", group: "AESTHETICS" }]
      : []),
    ...procedureSections,
    ...customSections,
  ];
  const boardEditorEntries = chartEditorInventory({
    customSections: spineCustomSections,
    ocularHealthSections,
    eyeGrowthDefaultVisible,
  });
  const customDefinition = activeSection.startsWith("custom:")
    ? customDefinitions.find((definition) => definition.stableKey === activeSection)
    : undefined;
  const procedureDefinition = activeSection.startsWith("procedure:")
    ? procedureDefinitions.find((definition) => definition.stableKey === activeSection)
    : undefined;
  const dryEyeDefinition = activeSection.startsWith("dry-eye:")
    ? dryEyeDefinitionByKey.get(activeSection)
    : undefined;
  const effectiveGroupKeys = new Set(sectionGroupCatalog.effectiveGroupKeys ?? []);
  const availableSectionGroups = sectionGroupCatalog.groups.filter(
    (group) => group.active && !effectiveGroupKeys.has(group.groupKey),
  );
  const overrideGroupKeys = sectionGroupCatalog.overrideGroupKeys ?? [];
  const groupLabel = (groupKey: string) =>
    sectionGroupCatalog.groups.find((group) => group.groupKey === groupKey)?.label ?? groupKey;
  const activeFindingSectionKey = visibleDefinitions.find((definition) =>
    definition.stableKey === activeSection
  )?.sectionKey ?? activeSection;
  const activeExamOverviewProjection = examOverviewProjection?.encounterReference === encounterReference
    ? examOverviewProjection
    : undefined;

  return (
    <div className={["odos-charting-workspace flex h-screen w-screen flex-col bg-bg-deep text-white", config.encounterDensity === "compact" ? "text-[0.95rem]" : ""].join(" ")}>
      <EncounterHeader
        patient={patient}
        encounterId={encounterId}
        completeness={activeExamOverviewProjection?.completeness}
        unassignedCount={unassignedCount}
      />
      <div className="odos-chart-view-toggle" role="group" aria-label="Chart workspace view">
        <button type="button" aria-pressed={chartView === "diagnosis"} onClick={() => selectChartView("diagnosis")}>By diagnosis</button>
        <button type="button" aria-pressed={chartView === "structure"} onClick={() => selectChartView("structure")}>By structure</button>
      </div>
      {chartView === "diagnosis" ? (
        <DiagnosisWorkspace
          key={diagnosisWorkspaceKey}
          patientReference={patientReference}
          encounterReference={encounterReference}
          selectedReference={selectedDiagnosis?.workspaceKey === diagnosisWorkspaceKey ? selectedDiagnosis.reference : undefined}
          onSelectDiagnosis={(reference) => setSelectedDiagnosis(reference ? { workspaceKey: diagnosisWorkspaceKey, reference } : undefined)}
        />
      ) : activeExamOverviewProjection && !boardEditorOpen ? (
        <div className="odos-exam-overview-stage" data-entry-sheet-open={entrySheetSection ? "true" : "false"}>
          <ExamOverviewBoard
            projection={activeExamOverviewProjection}
            editorEntries={boardEditorEntries}
            activeEditorId={entrySheetSection}
            refreshing={examOverviewRefreshing}
            onOpenEditor={openBoardEditor}
            onRefresh={refreshExamOverview}
          />
          {entrySheetSection && (
            <ExamEntrySheet
              sectionId={entrySheetSection}
              onCancel={() => setEntrySheetSection(undefined)}
              active={!referralComposeOpen}
            >
              <MappedExamSection
                sectionId={entrySheetSection}
                definitions={{
                  pupils: pupilsDefinition,
                  stereopsis: stereopsisDefinition,
                  colorVision: colorDefinition,
                  eom: eomDefinition,
                  cvf: cvfDefinition,
                  visualFieldDefect: visualFieldDefectDefinition,
                  manualKeratometry: manualKDefinition,
                  pachymetry: pachymetryDefinition,
                  dilation: dilationDefinition,
                }}
                patientReference={patientReference}
                encounterReference={encounterReference}
                onRefer={() => setReferralComposeOpen(true)}
                onSaved={(status) => {
                  markSaved(entrySheetSection, status);
                  setEntrySheetSection(undefined);
                }}
              />
            </ExamEntrySheet>
          )}
        </div>
      ) : (
        <div className="odos-charting-body flex min-h-0 flex-1 flex-col md:flex-row">
        {!activeExamOverviewProjection && (
          <SpineNav
            active={activeSection}
            statuses={statuses}
            onSelect={setActiveSection}
            customSections={spineCustomSections}
            ocularHealthSections={ocularHealthSections}
            eyeGrowthDefaultVisible={eyeGrowthDefaultVisible}
            onAddSection={catalog.canWrite ? () => setCreatingSection(true) : undefined}
          />
        )}
        <main className="relative min-w-0 flex-1 bg-bg-deep" {...(sidebarExpanded ? { inert: "" } : {})}>
          {activeExamOverviewProjection && boardEditorOpen && (
            <div className="odos-exam-editor-return">
              <button
                type="button"
                data-testid="return-to-exam-overview"
                onClick={returnToExamOverview}
                className="odos-exam-editor-return-button"
              >
                Back to exam overview
              </button>
            </div>
          )}
          <EncounterFindingOverlay
            encounterReference={encounterReference}
            sectionKey={activeFindingSectionKey}
          />
          {(sectionGroupCatalog.canPullIn || sectionGroupError) && (
            <div className="absolute right-4 top-3 z-20 flex max-w-xl flex-col items-end gap-2">
              {sectionGroupError && (
                <span role="alert" className="rounded border border-red-400/25 bg-bg-panel px-2 py-1 text-xs text-red-200">
                  {sectionGroupError}
                </span>
              )}
              {sectionGroupCatalog.canPullIn && (
                <div className="flex flex-wrap justify-end gap-2">
                  {overrideGroupKeys.map((groupKey) => (
                    <button
                      key={groupKey}
                      type="button"
                      disabled={addingSectionGroup}
                      onClick={() => void removeSectionGroup(groupKey)}
                      className="rounded border border-red-300/25 bg-bg-panel px-3 py-2 text-xs text-red-200 shadow-lg"
                    >
                      Remove {groupLabel(groupKey)}
                    </button>
                  ))}
                  {availableSectionGroups.length > 0 && (
                    <OdosSelect
                      value=""
                      disabled={addingSectionGroup}
                      options={[
                        {
                          value: "",
                          label: addingSectionGroup ? "Updating section groups…" : "Add section group…",
                        },
                        ...availableSectionGroups.map((group) => ({ value: group.groupKey, label: group.label })),
                      ]}
                      onChange={(value) => {
                        if (value) void addSectionGroup(value);
                      }}
                      ariaLabel="Add section group"
                    />
                  )}
                </div>
              )}
            </div>
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
          {isExamEntrySheetSectionId(activeSection) && (
            <MappedExamSection
              sectionId={activeSection}
              definitions={{
                pupils: pupilsDefinition,
                stereopsis: stereopsisDefinition,
                colorVision: colorDefinition,
                eom: eomDefinition,
                cvf: cvfDefinition,
                visualFieldDefect: visualFieldDefectDefinition,
                manualKeratometry: manualKDefinition,
                pachymetry: pachymetryDefinition,
                dilation: dilationDefinition,
              }}
              patientReference={patientReference}
              encounterReference={encounterReference}
              onRefer={() => setReferralComposeOpen(true)}
              onSaved={(status) => markSaved(activeSection, status)}
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
              encounterRecordedAt={encounterRecordedAt}
              onSaved={(status, stableKeys) => stableKeys.forEach((stableKey) => markSaved(stableKey as ChartSectionId, status))}
            />
          )}
          {activeSection === "dry-eye:tear-stability" && tearFilmDefinition && (
            <OcularHealthSection
              definitions={[tearFilmDefinition]}
              focusedStableKey={tearFilmDefinition.stableKey}
              patientReference={patientReference}
              encounterReference={encounterReference}
              encounterRecordedAt={encounterRecordedAt}
              onSaved={(status, stableKeys) => {
                stableKeys.forEach((stableKey) => markSaved(stableKey as ChartSectionId, status));
                markSaved("dry-eye:tear-stability", status);
              }}
            />
          )}
          {activeSection === "dry-eye:conjunctival-staining" && dryEyeDefinition && (
            <OcularHealthSection
              definitions={[
                ...(corneaDefinition ? [corneaDefinition] : []),
                dryEyeDefinition,
              ]}
              focusedStableKey={dryEyeDefinition.stableKey}
              patientReference={patientReference}
              encounterReference={encounterReference}
              encounterRecordedAt={encounterRecordedAt}
              onSaved={(status, stableKeys) => stableKeys.forEach((stableKey) =>
                markSaved(stableKey as ChartSectionId, status)
              )}
            />
          )}
          {activeSection === "dry-eye:gland-structure" && dryEyeDefinition && (
            <DryEyeGlandStructureSection
              definition={dryEyeDefinition}
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved(activeSection, status)}
            />
          )}
          {activeSection.startsWith("dry-eye:") &&
            activeSection !== "dry-eye:tear-stability" &&
            activeSection !== "dry-eye:conjunctival-staining" &&
            activeSection !== "dry-eye:gland-structure" &&
            dryEyeDefinition && (
              <CustomFindingSection
                key={dryEyeDefinition.stableKey}
                definition={dryEyeDefinition}
                patientReference={patientReference}
                encounterReference={encounterReference}
                onSaved={(status) => markSaved(activeSection, status)}
              />
            )}
          {activeSection.startsWith("custom:") && customDefinition && (
            <CustomFindingSection
              key={customDefinition.stableKey}
              definition={customDefinition}
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved(activeSection, status)}
            />
          )}
          {activeSection.startsWith("procedure:") && procedureDefinition && (
            <CustomFindingSection
              key={procedureDefinition.stableKey}
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
      )}
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

interface MappedExamDefinitions {
  pupils?: CustomFindingDefinition;
  stereopsis?: CustomFindingDefinition;
  colorVision?: CustomFindingDefinition;
  eom?: CustomFindingDefinition;
  cvf?: CustomFindingDefinition;
  visualFieldDefect?: CustomFindingDefinition;
  manualKeratometry?: CustomFindingDefinition;
  pachymetry?: CustomFindingDefinition;
  dilation?: CustomFindingDefinition;
}

function MappedExamSection({ sectionId, definitions, patientReference, encounterReference, onSaved, onRefer }: {
  sectionId: ExamEntrySheetSectionId;
  definitions: MappedExamDefinitions;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
  onRefer(): void;
}) {
  const props = { patientReference, encounterReference, onSaved };
  if (sectionId === "hpi") return <HpiSection {...props} />;
  if (sectionId === "manual-keratometry") {
    return definitions.manualKeratometry
      ? <EntranceMeasurementSection definition={definitions.manualKeratometry} {...props} />
      : <MissingDefinitionState section="Manual keratometry" />;
  }
  if (sectionId === "pachymetry") {
    return definitions.pachymetry
      ? <EntranceMeasurementSection definition={definitions.pachymetry} {...props} />
      : <MissingDefinitionState section="Pachymetry" />;
  }
  if (sectionId === "va") return <VaSection {...props} />;
  if (sectionId === "pupils") {
    return definitions.pupils
      ? <EntranceStateSection definition={definitions.pupils} {...props} />
      : <MissingDefinitionState section="Pupils" />;
  }
  if (sectionId === "stereopsis") {
    return definitions.stereopsis
      ? <EntranceStateSection definition={definitions.stereopsis} {...props} />
      : <MissingDefinitionState section="Stereopsis" />;
  }
  if (sectionId === "color-vision") {
    return definitions.colorVision
      ? <EntranceStateSection definition={definitions.colorVision} {...props} />
      : <MissingDefinitionState section="Color vision" />;
  }
  if (sectionId === "eom") {
    return definitions.eom
      ? <EomSection definition={definitions.eom} {...props} />
      : <MissingDefinitionState section="EOM / diplopia" />;
  }
  if (sectionId === "cvf") {
    return definitions.cvf && definitions.visualFieldDefect
      ? <CvfSection definition={definitions.cvf} fieldDefectDefinition={definitions.visualFieldDefect} {...props} />
      : <MissingDefinitionState section="Visual Field" />;
  }
  if (sectionId === "cover-test") return <CoverTestSection {...props} />;
  if (sectionId === "iop") return <IopSection {...props} />;
  if (sectionId === "dilation") {
    return definitions.dilation
      ? <DilationSection definition={definitions.dilation} {...props} />
      : <MissingDefinitionState section="Dilation" />;
  }
  if (sectionId === "ortho-k") return <OrthoKSection {...props} />;
  if (sectionId === "myopia-management") return <MyopiaManagementSection {...props} />;
  if (sectionId === "cup-disc") return <CupDiscSection {...props} />;
  if (sectionId === "gonioscopy") return <GonioscopySection {...props} />;
  if (sectionId === "dry-eye") return <DryEyeSection {...props} />;
  if (sectionId === "imaging") return <ImagingSection {...props} />;
  if (sectionId === "assessment") return <AssessmentSection {...props} onRefer={onRefer} />;
  return <PrescriptionSection {...props} />;
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

function section(id: `dry-eye:${string}`, label: string) {
  return { id: id as ChartSectionId, label, group: "DRY EYE WORKUP" };
}

async function loadExamOverviewProjection(encounterId: string): Promise<ExamOverviewProjection> {
  const response = await fetch(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/exam-overview`,
    { headers: authHeaders() },
  );
  const body = await response.json() as unknown;
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : `Exam overview failed: ${response.status}`;
    throw new Error(error);
  }
  if (!isExamOverviewProjection(body)) throw new Error("Exam overview returned an invalid projection.");
  return body;
}
