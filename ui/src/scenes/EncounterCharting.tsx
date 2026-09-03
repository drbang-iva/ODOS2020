import { useEffect, useState } from "react";
import type { Condition, Encounter, Patient } from "@medplum/fhirtypes";
import { ChartSidebar } from "../components/ChartSidebar";
import { LongitudinalImagingCard } from "../components/LongitudinalImagingCard";
import { EngageSheet, type EngageDiagnosis } from "../components/comms/EngageSheet";
import { ReferralCompose } from "../components/referral/ReferralCompose";
import { AestheticsConsentSection } from "../components/charting/AestheticsConsentSection";
import { AssessmentSection } from "../components/charting/AssessmentSection";
import { AutoRefractionSection } from "../components/charting/AutoRefractionSection";
import { PretestVitalsSection } from "../components/charting/PretestVitalsSection";
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
  EXAM_ENTRY_SHEET_CONFIG,
  ExamEntrySheet,
  isExamEntrySheetSectionId,
  type ExamEntrySheetSectionId,
  useExamEntrySheetGuard,
} from "../components/charting/ExamEntrySheet";
import {
  ExamRightPanelSurface,
  ExamRightPanelTabs,
  EXAM_RIGHT_PANEL_IDS,
  examRightPanelEntryTitle,
  INITIAL_EXAM_RIGHT_PANEL_STATE,
  closeExamRightPanelEngage,
  finishExamRightPanelEntry,
  openExamRightPanelEntry,
  selectExamRightPanelTab,
} from "../components/charting/ExamRightPanel";
import { VisitChargesSheet } from "../components/charting/VisitChargesSheet";
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
import { EncounterEditContext, type EncounterClearFailedDetail, type EncounterClearedDetail } from "../components/charting/encounter-edit-context";
import { ConfirmDestructiveProvider } from "../components/charting/ConfirmDestructive";
import { UndoStrip } from "../components/charting/UndoStrip";
import { isClosedEncounterStatus } from "../lib/encounter-void";
import {
  emptyUndoLedger,
  confirmedSlotKeys,
  readEncounterUndoLedger,
  undoSlotKey,
  undoEncounterVoid,
  undoSlotForSection,
  type EncounterUndoLedger,
  type EncounterUndoRequest,
} from "../lib/encounter-undo";
import { RefractionHistorySection } from "../components/charting/RefractionHistorySection";
import { SoftContactLensSection } from "../components/charting/SoftContactLensSection";
import { SpecialtyContactLensSection } from "../components/charting/SpecialtyContactLensSection";
import { chartEditorInventory, SpineNav } from "../components/charting/SpineNav";
import { VaSection } from "../components/charting/VaSection";
import { WearingSection } from "../components/charting/WearingSection";
import { authHeaders, clinicalGraphApiBase, type VisitChargeResponse } from "../lib/clinical-graph-client";
import { loadDiagnosisFindings } from "../lib/diagnosis-findings";
import { fhir } from "../lib/fhir";
import { isMigratedEncounter } from "../lib/patient-overview";
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

type EncounterLoadState =
  | { encounterId: string; status: "loading" }
  | { encounterId: string; status: "ready"; encounter: Encounter }
  | { encounterId: string; status: "error" };

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
  const [chartClearVersion, setChartClearVersion] = useState(0);
  // The Undo ledger (§4b.4) is loaded with the encounter and replaced by every void / undo
  // response, so the strips survive navigation and reload rather than living in component state.
  const [undoLedger, setUndoLedger] = useState<EncounterUndoLedger>(() => emptyUndoLedger(encounterId));
  // Slots this page saw come back from a SUCCESSFUL void, so their counts are exact. Every
  // other slot — read on load, or re-read after a refused clear — was written from intent and
  // renders as an upper bound (see UndoStrip). Keyed by placement + the action's timestamp.
  const [confirmedUndoSlots, setConfirmedUndoSlots] = useState<ReadonlySet<string>>(() => new Set());
  const entrySheetGuard = useExamEntrySheetGuard(entrySheetSection);
  const [rightPanelState, setRightPanelState] = useState(INITIAL_EXAM_RIGHT_PANEL_STATE);
  const [rightPanelImageCount, setRightPanelImageCount] = useState(0);
  const [unassignedCount, setUnassignedCount] = useState<number>();
  const [encounterLoadState, setEncounterLoadState] = useState<EncounterLoadState>({
    encounterId,
    status: "loading",
  });
  const [visitChargesOpen, setVisitChargesOpen] = useState(false);
  const [visitCharge, setVisitCharge] = useState<VisitChargeResponse>();
  const [engageDiagnosis, setEngageDiagnosis] = useState<EngageDiagnosis>();
  const [brokenVisitDiagnosisDisplay, setBrokenVisitDiagnosisDisplay] = useState<string>();
  const currentEncounterLoadState: EncounterLoadState = encounterLoadState.encounterId === encounterId
    ? encounterLoadState
    : { encounterId, status: "loading" };
  const encounter = currentEncounterLoadState.status === "ready"
    ? currentEncounterLoadState.encounter
    : undefined;

  function setSidebarOpen(expanded: boolean) {
    sidebarExpandedForSession = expanded;
    setSidebarExpanded(expanded);
  }

  function selectChartView(view: EncounterChartView) {
    const transition = () => {
      setChartView(view);
      if (view !== "structure") {
        setBoardEditorOpen(false);
        setEntrySheetSection(undefined);
        setRightPanelState(INITIAL_EXAM_RIGHT_PANEL_STATE);
      }
      saveEncounterChartView(view);
    };
    if (view !== "structure" && entrySheetSection) {
      entrySheetGuard.requestTransition("By diagnosis", transition);
      return;
    }
    transition();
  }

  function refreshExamOverview() {
    setExamOverviewRefreshVersion((current) => current + 1);
  }

  // Pre-finalization delete: a void anywhere refreshes the Overview; a section clear drops that
  // section's saved status; a visit clear drops every status and remounts the open sheet blank.
  function handleEncounterCleared(detail: EncounterClearedDetail) {
    const ledger = detail.result.ledger;
    if (ledger) {
      setUndoLedger(ledger);
      // Vouch only for the slot whose rows this response actually enumerated; a no-op success
      // carries the current ledger and vouches for none of it.
      setConfirmedUndoSlots((current) => new Set([...current, ...confirmedSlotKeys(ledger, detail.result.voided)]));
    }
    if (detail.scope === "encounter") {
      setStatuses({});
      setChartClearVersion((current) => current + 1);
    } else if (detail.scope === "section") {
      setStatuses((current) => Object.fromEntries(Object.entries(current).filter(([key]) =>
        key !== activeSection && !key.startsWith(`${activeSection}:`)
      )) as SectionStatusMap);
    }
    refreshExamOverview();
  }

  // A clear that FAILS re-reads the chart too. The overview refetches only on a successful
  // clear or the manual button, so after a refused void the clinician would be reading a panel
  // whose contents may already be gone — which is how "nothing was cleared" was concluded about
  // a chart an earlier void had fully emptied (2026-09-02). The surface keeps its error on
  // screen; this only makes sure the overview beside it is current.
  function handleEncounterClearFailed(_detail: EncounterClearFailedDetail) {
    refreshExamOverview();
    // …and the Undo ledger. On this non-atomic stack a refused clear can still have written its
    // slot (and most of its voids); that slot is the clinician's way back from a partially
    // erased chart, and Undo restores only what was actually voided. Show the slot the server
    // holds, not the one this page last loaded.
    void readEncounterUndoLedger(`Encounter/${encounterId}`)
      .then((ledger) => { if (ledger.encounterId === encounterId) setUndoLedger(ledger); })
      .catch((caught) => { console.error("Undo ledger unavailable after a failed clear.", caught); });
  }

  // Undo reverses exactly one clear — the slot the server holds for that scope — and the
  // response's ledger replaces ours (the slot is gone). The open section remounts so its
  // history shows the restored values.
  async function handleUndo(request: EncounterUndoRequest) {
    // The remount below discards whatever is typed and unsaved in the open sheet. Undo is not
    // an edit, so its button never marks the sheet dirty — but it must still respect what the
    // clinician has typed since. Same guard, same question, as leaving the sheet.
    // Ask first, discard only on success: if the undo fails the typed edits stay on screen, so the
    // guard must stay armed for whatever the clinician does next.
    if (entrySheetSection && !entrySheetGuard.confirmDiscard("Undo will discard unsaved changes in {title}. Continue?")) return;
    const result = await undoEncounterVoid(encounterReference, request);
    if (entrySheetSection) entrySheetGuard.resetDirty();
    setUndoLedger(result.ledger);
    setChartClearVersion((current) => current + 1);
    refreshExamOverview();
  }

  function openBoardEditor(sectionId: ChartSectionId) {
    const transition = () => {
      setVisitChargesOpen(false);
      setActiveSection(sectionId);
      if (isExamEntrySheetSectionId(sectionId)) {
        setRightPanelState((current) => openExamRightPanelEntry(current, Boolean(entrySheetSection)));
        setEntrySheetSection(sectionId);
        setBoardEditorOpen(false);
      } else {
        setEntrySheetSection(undefined);
        setRightPanelState(INITIAL_EXAM_RIGHT_PANEL_STATE);
        setBoardEditorOpen(true);
      }
    };
    if (entrySheetSection && sectionId !== entrySheetSection) {
      const destinationTitle = boardEditorEntries.find((entry) => entry.id === sectionId)?.label ?? sectionId;
      entrySheetGuard.requestTransition(destinationTitle, transition);
      return;
    }
    transition();
  }

  function returnToExamOverview() {
    setBoardEditorOpen(false);
    setEntrySheetSection(undefined);
    setRightPanelState(INITIAL_EXAM_RIGHT_PANEL_STATE);
    refreshExamOverview();
  }

  function finishEntrySheet() {
    setEntrySheetSection(undefined);
    setRightPanelState((current) => finishExamRightPanelEntry(current));
  }

  function openEngage(diagnosis?: EngageDiagnosis) {
    setEngageDiagnosis(diagnosis);
    setVisitChargesOpen(false);
    setBoardEditorOpen(false);
    setRightPanelState((current) => selectExamRightPanelTab(current, "engage"));
  }

  useEffect(() => {
    setBoardEditorOpen(false);
    setEntrySheetSection(undefined);
    setRightPanelState(INITIAL_EXAM_RIGHT_PANEL_STATE);
    setRightPanelImageCount(0);
    setEngageDiagnosis(undefined);
    setExamOverviewProjection(undefined);
    setVisitChargesOpen(false);
    setVisitCharge(undefined);
    setBrokenVisitDiagnosisDisplay(undefined);
  }, [encounterId]);

  const linkedVisitDiagnosis = visitCharge?.proposal?.state === "accepted"
    ? visitCharge.proposal.dxPointers[0]
    : undefined;
  const brokenVisitDiagnosis = linkedVisitDiagnosis &&
    !visitCharge?.diagnoses.some((diagnosis) => diagnosis.reference === linkedVisitDiagnosis)
    ? linkedVisitDiagnosis
    : undefined;

  useEffect(() => {
    setBrokenVisitDiagnosisDisplay(undefined);
    const conditionId = brokenVisitDiagnosis?.match(/^Condition\/([A-Za-z0-9.-]+)$/)?.[1];
    if (!conditionId) return;
    let cancelled = false;
    void fhir.read<Condition>("Condition", conditionId)
      .then((condition) => {
        if (!cancelled) setBrokenVisitDiagnosisDisplay(conditionDisplay(condition, brokenVisitDiagnosis));
      })
      .catch(() => {
        if (!cancelled) setBrokenVisitDiagnosisDisplay(brokenVisitDiagnosis);
      });
    return () => { cancelled = true; };
  }, [brokenVisitDiagnosis]);

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
    setEncounterLoadState({ encounterId, status: "loading" });
    setUndoLedger(emptyUndoLedger(encounterId));
    setConfirmedUndoSlots(new Set());
    fhir.read<Encounter>("Encounter", encounterId)
      .then((encounter) => {
        const code = encounter.serviceType?.coding?.find((coding) =>
          coding.system === ODOS_DISCIPLINE_SYSTEM
        )?.code;
        if (cancelled) return;
        setEncounterLoadState({ encounterId, status: "ready", encounter });
        void readEncounterUndoLedger(`Encounter/${encounterId}`).then((ledger) => {
          if (!cancelled) setUndoLedger(ledger);
        });
        setEncounterRecordedAt(encounter.period?.start ?? encounter.period?.end);
        if (code === "eyecare" || code === "aesthetics") {
          setDiscipline(code);
          if (code === "aesthetics") {
            setActiveSection((current) => current === "va" ? "aesthetics-consent" : current);
          }
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setEncounterLoadState({ encounterId, status: "error" });
          console.error("Encounter discipline unavailable.", caught);
        }
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
  // The section key(s) each surface names when it clears — the same keys its Clear control
  // sends — so a sheet finds its own Undo slot and never another section's (§4b.2 rule 2).
  const keyOf = (definition?: { stableKey: string; sectionKey?: string }) =>
    definition ? [definition.sectionKey ?? definition.stableKey] : [];
  function sectionUndoKeys(section: string): string[] {
    switch (section) {
      case "hpi": return ["hpi", "complaints"];
      case "va": return ["va"];
      case "iop": return ["tonometry"];
      case "cover-test": return ["entrance:cover"];
      case "dilation": return ["entrance:dilation"];
      case "assessment": return ["assessment"];
      case "refraction": return ["refraction"];
      case "auto-refraction": return ["auto-refraction"];
      case "pupils": return keyOf(pupilsDefinition);
      case "stereopsis": return keyOf(stereopsisDefinition);
      case "color-vision": return keyOf(colorDefinition);
      case "eom": return keyOf(eomDefinition);
      case "cvf": return [cvfDefinition?.stableKey, visualFieldDefectDefinition?.stableKey].filter((key): key is string => Boolean(key));
      case "manual-keratometry": return keyOf(manualKDefinition);
      case "pachymetry": return keyOf(pachymetryDefinition);
      case "dry-eye:tear-stability": return tearFilmDefinition ? [tearFilmDefinition.stableKey] : [];
      case "dry-eye:conjunctival-staining":
        return [corneaDefinition?.stableKey, dryEyeDefinition?.stableKey].filter((key): key is string => Boolean(key));
      default:
        if (section.startsWith("ocular-health:")) return ocularHealthDefinitions.map((definition) => definition.stableKey);
        return [];
    }
  }
  const sheetUndoSlot = entrySheetSection ? undoSlotForSection(undoLedger, sectionUndoKeys(entrySheetSection)) : undefined;
  const sheetUndo = sheetUndoSlot
    ? {
        slot: sheetUndoSlot.slot,
        confirmed: confirmedUndoSlots.has(undoSlotKey(sheetUndoSlot.sectionKey, sheetUndoSlot.slot)),
        onUndo: () => handleUndo({ scope: "section", sectionKey: sheetUndoSlot.sectionKey }),
      }
    : undefined;
  const bodyUndoSlot = entrySheetSection ? undefined : undoSlotForSection(undoLedger, sectionUndoKeys(activeSection));
  const activeExamOverviewProjection = examOverviewProjection?.encounterReference === encounterReference
    ? examOverviewProjection
    : undefined;
  const clinicalActionUnavailableReason = entrySheetSection
    ? `Finish or cancel ${EXAM_ENTRY_SHEET_CONFIG[entrySheetSection].title} first`
    : undefined;
  const visitUnavailableReason = clinicalActionUnavailableReason
    ?? (currentEncounterLoadState.status === "loading"
      ? "Loading encounter details — Visit & charges unavailable"
      : currentEncounterLoadState.status === "error"
        ? "Encounter details unavailable — Visit & charges cannot be changed"
        : undefined);
  const visitChargesDisabled = currentEncounterLoadState.status !== "ready" || isMigratedEncounter(encounter);
  const rightPanelAvailable = chartView === "structure" && Boolean(activeExamOverviewProjection) && !boardEditorOpen;
  const rightPanelForward = rightPanelAvailable && !visitChargesOpen;
  const entryTabTitle = entrySheetSection
    ? examRightPanelEntryTitle(entrySheetSection, EXAM_ENTRY_SHEET_CONFIG[entrySheetSection].title)
    : undefined;
  const rightPanelTabs = (instanceId: string) => (
    <ExamRightPanelTabs
      instanceId={instanceId}
      activeTab={rightPanelState.activeTab}
      entryTitle={entryTabTitle}
      imageCount={rightPanelImageCount}
      onSelect={(tab) => {
        if (tab === "entry" && !entrySheetSection) return;
        setRightPanelState((current) => selectExamRightPanelTab(current, tab));
      }}
    />
  );

  return (
    <EncounterEditContext.Provider value={{ encounterStatus: encounter?.status, onCleared: handleEncounterCleared, onClearFailed: handleEncounterClearFailed }}>
    <ConfirmDestructiveProvider>
    <div className={["odos-charting-workspace flex h-screen w-screen flex-col bg-bg-deep text-white", config.encounterDensity === "compact" ? "text-[0.95rem]" : ""].join(" ")}>
      <EncounterHeader
        patient={patient}
        encounterId={encounterId}
        completeness={activeExamOverviewProjection?.completeness}
        unassignedCount={unassignedCount}
        visitCharge={visitCharge}
        brokenDiagnosisDisplay={brokenVisitDiagnosisDisplay}
        visitChargesOpen={visitChargesOpen}
        visitUnavailableReason={visitUnavailableReason}
        clinicalActionUnavailableReason={clinicalActionUnavailableReason}
        onToggleVisitCharges={() => setVisitChargesOpen((current) => !current)}
        undoSlot={undoLedger.encounter ?? undefined}
        undoConfirmed={undoLedger.encounter ? confirmedUndoSlots.has(undoSlotKey("encounter", undoLedger.encounter)) : false}
        onUndo={() => handleUndo({ scope: "encounter" })}
      />
      <div
        className="odos-charting-stage"
        data-entry-sheet-open={visitChargesOpen || rightPanelAvailable ? "true" : "false"}
        data-panel-summoned={rightPanelState.summoned ? "true" : "false"}
      >
        <div className="odos-charting-primary">
      <div className="odos-chart-view-toggle" role="group" aria-label="Chart workspace view">
        <button type="button" aria-pressed={chartView === "diagnosis"} onClick={() => selectChartView("diagnosis")}>By diagnosis</button>
        <button type="button" aria-pressed={chartView === "structure"} onClick={() => selectChartView("structure")}>By structure</button>
      </div>
      {rightPanelAvailable && (
        <div className="odos-exam-panel-launchers" aria-label="Exam panel shortcuts">
          <button type="button" onClick={() => setRightPanelState((current) => selectExamRightPanelTab(current, "images"))}>
            Images{rightPanelImageCount > 0 ? ` · ${rightPanelImageCount}` : ""}
          </button>
          <button type="button" onClick={() => openEngage()}>Engage</button>
        </div>
      )}
      {chartView === "diagnosis" ? (
        <DiagnosisWorkspace
          key={diagnosisWorkspaceKey}
          patientReference={patientReference}
          encounterReference={encounterReference}
          selectedReference={selectedDiagnosis?.workspaceKey === diagnosisWorkspaceKey ? selectedDiagnosis.reference : undefined}
          onSelectDiagnosis={(reference) => setSelectedDiagnosis(reference ? { workspaceKey: diagnosisWorkspaceKey, reference } : undefined)}
        />
      ) : activeExamOverviewProjection && !boardEditorOpen ? (
        <div className="odos-exam-overview-stage">
          <ExamOverviewBoard
            projection={activeExamOverviewProjection}
            editorEntries={boardEditorEntries}
            activeEditorId={entrySheetSection}
            refreshing={examOverviewRefreshing}
            onOpenEditor={openBoardEditor}
            onRefresh={refreshExamOverview}
          />
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
        <main key={chartClearVersion} className="relative min-w-0 flex-1 bg-bg-deep" {...(sidebarExpanded ? { inert: "" } : {})}>
          {bodyUndoSlot && (
            <UndoStrip
              slot={bodyUndoSlot.slot}
              scope="section"
              confirmed={confirmedUndoSlots.has(undoSlotKey(bodyUndoSlot.sectionKey, bodyUndoSlot.slot))}
              closed={isClosedEncounterStatus(encounter?.status)}
              onUndo={() => handleUndo({ scope: "section", sectionKey: bodyUndoSlot.sectionKey })}
            />
          )}
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
          {activeSection === "pretest-vitals" && (
            <PretestVitalsSection
              patientReference={patientReference}
              encounterReference={encounterReference}
              onSaved={(status) => markSaved("pretest-vitals", status)}
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
              onEngageDiagnosis={openEngage}
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
        </div>
        {rightPanelForward && entrySheetSection && (
          <ExamEntrySheet
            key={entrySheetSection}
            sectionId={entrySheetSection}
            onCancel={() => entrySheetGuard.requestTransition(undefined, finishEntrySheet)}
            onCheckpointDirty={entrySheetGuard.checkpointDirty}
            onClearDirtyCheckpoint={entrySheetGuard.clearDirtyCheckpoint}
            onDirty={entrySheetGuard.markDirty}
            onDirtyCheckpoint={entrySheetGuard.markDirtyCheckpoint}
            onFocusWithin={entrySheetGuard.rememberFocus}
            onRestoreDirtyCheckpoint={entrySheetGuard.restoreDirtyCheckpoint}
            panelId={EXAM_RIGHT_PANEL_IDS.entry}
            panelLabelledBy="entry-panel-entry-tab"
            panelTabs={rightPanelTabs("entry-panel")}
            active={rightPanelState.activeTab === "entry" && !referralComposeOpen}
            hidden={rightPanelState.activeTab !== "entry"}
            encounterReference={encounterReference}
            encounterStatus={encounter?.status}
            onEncounterCleared={(result) => handleEncounterCleared({ scope: "encounter", result })}
            undo={sheetUndo}
          >
            <MappedExamSection
              key={`${entrySheetSection}:${chartClearVersion}`}
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
              onEngageDiagnosis={openEngage}
              onRefer={() => setReferralComposeOpen(true)}
              onSaved={(status, keepOpen) => {
                if (keepOpen && !status.completed) entrySheetGuard.markDirty();
                else entrySheetGuard.resetDirty(Boolean(keepOpen));
                markSaved(entrySheetSection, status);
                if (!keepOpen) finishEntrySheet();
              }}
            />
          </ExamEntrySheet>
        )}
        {rightPanelForward && (
          <ExamRightPanelSurface
            active={rightPanelState.activeTab === "images"}
            label="Images"
            panelId={EXAM_RIGHT_PANEL_IDS.images}
            labelledBy="images-panel-images-tab"
            tabs={rightPanelTabs("images-panel")}
          >
            <LongitudinalImagingCard
              patientReference={patientReference}
              onCountChange={setRightPanelImageCount}
            />
          </ExamRightPanelSurface>
        )}
        <VisitChargesSheet
          open={visitChargesOpen}
          encounter={encounter}
          encounterId={encounterId}
          patientReference={patientReference}
          disabled={visitChargesDisabled}
          visitCharge={visitCharge}
          onClose={() => setVisitChargesOpen(false)}
          onVisitChargeChange={setVisitCharge}
        />
        {rightPanelForward && (
          <EngageSheet
            open={rightPanelState.activeTab === "engage"}
            patient={patient}
            encounterReference={encounterReference}
            diagnosis={engageDiagnosis}
            panelId={EXAM_RIGHT_PANEL_IDS.engage}
            panelLabelledBy="engage-panel-engage-tab"
            panelTabs={rightPanelTabs("engage-panel")}
            onClose={() => {
              setEngageDiagnosis(undefined);
              setRightPanelState((current) => closeExamRightPanelEngage(current, Boolean(entrySheetSection)));
            }}
          />
        )}
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
    </ConfirmDestructiveProvider>
    </EncounterEditContext.Provider>
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

function MappedExamSection({ sectionId, definitions, patientReference, encounterReference, onSaved, onRefer, onEngageDiagnosis }: {
  sectionId: ExamEntrySheetSectionId;
  definitions: MappedExamDefinitions;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus, keepOpen?: boolean): void;
  onRefer(): void;
  onEngageDiagnosis(diagnosis: EngageDiagnosis): void;
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
      : <MissingDefinitionState section="Confrontation visual fields" />;
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
  if (sectionId === "assessment") return <AssessmentSection {...props} onRefer={onRefer} onEngageDiagnosis={onEngageDiagnosis} />;
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

function conditionDisplay(condition: Condition, fallback: string): string {
  return condition.code?.text ??
    condition.code?.coding?.find((coding) => coding.display)?.display ??
    condition.code?.coding?.find((coding) => coding.code)?.code ??
    fallback;
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
