import { useEffect, useMemo, useRef, useState } from "react";
import type { Condition, Encounter, Observation } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import { useRole } from "../../lib/role-context";
import {
  DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
  createEncounterDiagnosis,
  markConditionEnteredInError,
  principalDiagnosisOrder,
  updateConditionBodySite,
  updateConditionCode,
  updateConditionStatus,
  updateEncounterDiagnosisProblemStatus,
  type DiagnosisTierChoice,
  type EyeChoice,
} from "../../lib/clinical-actions";
import {
  clinicalStatus,
  diagnosisRank,
  displayCode,
  isEncounterDiagnosisCondition,
} from "../../lib/clinical-view-model";
import type { SectionSaveStatus } from "./types";
import {
  authHeaders,
  clinicalGraphApiBase,
  DIAGNOSIS_VISIT_STATUSES,
  procedureChargeApi,
  readDiagnosisVisitStatuses,
  submitDiagnosisPick,
  updateDiagnosisOrder,
  updateDiagnosisVisitStatus,
  type AttachedProcedure,
  type DiagnosisDemotionImpact,
  type DiagnosisVisitStatus,
} from "../../lib/clinical-graph-client";
import { ODOS_EXTENSION_URLS } from "../../lib/fhir-ophthalmology/extensions";
import {
  encounterDiagnosisProblemStatus,
  MDM_PROBLEM_STATUSES,
  type MdmProblemStatus,
} from "../../lib/fhir-clinical/condition";
import {
  activeProtocolIds,
  applyEncounterProtocol,
  captureEncounterProtocol,
  protocolActionDisabled,
  retainAppliedProtocolOffers,
  unapplyEncounterProtocol,
  type ProtocolItem,
} from "../../lib/protocol-authoring";
import { ProtocolStagingList } from "./ProtocolStagingList";
import { ClearSectionButton } from "./ClearControls";
import { useEncounterEdit } from "./encounter-edit-context";
import {
  ReorderImpressionsModal,
  buildReorderImpressionRows,
} from "./ReorderImpressionsModal";
import { OdosSearchPicker } from "../inputs/OdosSearchPicker";
import { OdosSelect } from "../inputs/OdosSelect";
import {
  conditionCatalogStableKey,
  conditionRequiresDeclaredBilateralResolution,
  conditionResolvedCodeLabel,
  ICD10_CM_CODE_SYSTEM,
} from "../../lib/diagnosis-code-resolution";
import { DiagnosisDemotionImpactNotice } from "./DiagnosisDemotionImpactNotice";

const VERIFICATION_STATUS_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-ver-status";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
  onRefer?: () => void;
  onEngageDiagnosis?: (diagnosis: { reference: string; code: string; display: string }) => void;
}

interface FormState {
  code: string;
  display: string;
  laterality: EyeChoice;
  tier: DiagnosisTierChoice;
}
interface DiagnosisCodeOption {
  code: string;
  display: string;
}
interface DiagnosisCatalogCodeRow {
  display: string;
  stableKey: string;
  active: boolean;
  codingStatus: "verified" | "placeholder" | "provisional";
  lateralityRequired?: boolean;
  bilateralResolution?: "emit-both-eyes";
  icd10?: { code: string; display?: string } | { pattern: { unspecifiedEye?: string; right?: string; left?: string; bilateral?: string } };
}
let cachedDiagnosisCatalog: DiagnosisCatalogCodeRow[] | undefined;
interface ProtocolOffer {
  id: string;
  title: string;
  version: number;
  acceptCharges: boolean;
  statusScope: DiagnosisVisitStatus[];
  trigger: { kind: "diagnosis"; dxKeys: string[]; statusScope?: DiagnosisVisitStatus[] };
  items: ProtocolItem[];
}

const INITIAL_FORM: FormState = {
  code: "H52.13",
  display: "Myopia, bilateral",
  laterality: "OU",
  tier: "principal",
};

const INPUT_CLASS = "h-10 rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-3 text-sm text-[color:var(--odos-text)] outline-none transition placeholder:text-[color:var(--odos-faint)] focus:border-[color:var(--odos-accent-border)]";
const BUTTON_CLASS = "rounded border border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-hi)] px-3 py-2 text-sm font-semibold text-[color:var(--odos-text)] outline-none transition hover:bg-[color:var(--odos-accent-tint-lo)] focus-visible:ring-2 focus-visible:ring-[color:var(--odos-accent-border)] disabled:cursor-not-allowed disabled:opacity-50";

export function AssessmentSection({ patientReference, encounterReference, onSaved, onRefer, onEngageDiagnosis }: Props) {
  const { role } = useRole();
  const canShowEditing = role !== "front-desk";
  const { onCleared } = useEncounterEdit();
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [provenanceLines, setProvenanceLines] = useState<Record<string, string>>({});
  const [diagnosisVisitStatuses, setDiagnosisVisitStatuses] = useState<Record<string, DiagnosisVisitStatus>>({});
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnosisDemotionImpact, setDiagnosisDemotionImpact] = useState<DiagnosisDemotionImpact>();
  const [protocolApplications, setProtocolApplications] = useState<Array<{
    id: string;
    protocolId: string;
    confirmed: boolean;
    undoState: string;
  }>>([]);
  const [protocolOffers, setProtocolOffers] = useState<ProtocolOffer[]>([]);
  const [selectedProtocolId, setSelectedProtocolId] = useState<string>();
  const [protocolSheetOpen, setProtocolSheetOpen] = useState(false);
  const [protocolSelections, setProtocolSelections] = useState<Record<string, boolean>>({});
  const [diagnosisCatalog, setDiagnosisCatalog] = useState<DiagnosisCatalogCodeRow[]>([]);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureName, setCaptureName] = useState("");
  const [attachedProcedures, setAttachedProcedures] = useState<AttachedProcedure[]>([]);
  const [procedureAttachmentError, setProcedureAttachmentError] = useState<string>();
  const [reorderError, setReorderError] = useState<string>();
  const [reorderOpen, setReorderOpen] = useState(false);
  const protocolTriggerRef = useRef<HTMLButtonElement>(null);
  const protocolDialogRef = useRef<HTMLDivElement>(null);
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const currentEncounterReference = useRef(encounterReference);
  currentEncounterReference.current = encounterReference;

  async function load() {
    setDiagnosisDemotionImpact(undefined);
    setError(null);
    const loadedEncounter = await fhir.read<Encounter>("Encounter", encounterId);
    const [conditionBundle, visitStatuses, procedureResult] = await Promise.all([
      fhir.search<Condition>("Condition", {
        encounter: encounterReference,
        _count: "40",
      }),
      readDiagnosisVisitStatuses(encounterId),
      procedureChargeApi().read(encounterId).then(
        (response) => ({ response, error: undefined }),
        (caught) => ({
          response: undefined,
          error: caught instanceof Error ? caught.message : String(caught),
        }),
      ),
    ]);
    setEncounter(loadedEncounter);
    setDiagnosisVisitStatuses(Object.fromEntries(visitStatuses.map((row) => [row.conditionReference, row.status])));
    setAttachedProcedures(procedureResult.response?.attachedProcedures ?? []);
    setProcedureAttachmentError(procedureResult.error ? "Attached procedures could not be loaded." : undefined);
    const loadedConditions = (conditionBundle.entry ?? [])
        .flatMap((entry) => (entry.resource ? [entry.resource] : []))
        .filter(isEncounterDiagnosisCondition)
        .filter((condition) => !["refuted", "entered-in-error"].includes(verificationStatus(condition)));
    setConditions(loadedConditions);
    const evidenceReferences = [...new Set(loadedConditions.flatMap((condition) =>
      (condition.evidence ?? []).flatMap((evidence) => (evidence.detail ?? []).flatMap((detail) => detail.reference?.startsWith("Observation/") ? [detail.reference] : []))
    ))];
    const observationResults = await Promise.allSettled(evidenceReferences.map(async (reference) =>
      fhir.read<Observation>("Observation", reference.replace(/^Observation\//, ""))
    ));
    const observations = observationResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const observationsByReference = new Map(observations.map((observation) => [`Observation/${observation.id}`, observation]));
    setProvenanceLines(Object.fromEntries(loadedConditions.flatMap((condition) => {
      if (!condition.id) return [];
      const lines = (condition.evidence ?? []).flatMap((evidence) => evidence.detail ?? [])
        .flatMap((detail) => detail.reference ? [observationsByReference.get(detail.reference)] : [])
        .flatMap((observation) => observation ? [findingProvenanceLine(observation)] : []);
      return lines.length ? [[condition.id, lines.join(" · ")]] : [];
    })));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [encounterId, encounterReference]);

  useEffect(() => {
    const controller = new AbortController();
    void loadDiagnosisCatalog(controller.signal).then(setDiagnosisCatalog).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ encounterReference?: string }>).detail;
      if (detail?.encounterReference === encounterReference) void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    };
    window.addEventListener("odos:diagnosis-picked", refresh);
    return () => window.removeEventListener("odos:diagnosis-picked", refresh);
  }, [encounterReference]);

  const sortedConditions = useMemo(
    () => {
      if (!encounter) return conditions;
      return [...conditions].sort(
        (left, right) => (diagnosisRank(encounter, left) ?? 99) - (diagnosisRank(encounter, right) ?? 99),
      );
    },
    [conditions, encounter],
  );
  async function addDiagnosis() {
    if (!encounter) return;
    setBusy("add");
    setError(null);
    try {
      await createEncounterDiagnosis({
        patientReference,
        encounter,
        code: {
          system: "http://hl7.org/fhir/sid/icd-10-cm",
          code: form.code.trim(),
          display: form.display.trim() || form.code.trim(),
        },
        laterality: form.laterality,
        tier: form.tier,
      });
      await load();
      notifyEncounterDiagnosisUpdated(encounterReference);
      const status = {
        completed: true,
        summary: `${form.tier === "principal" ? "Principal" : "Secondary"} ${form.code}`,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI assessment",
      };
      onSaved(status);
      setForm((current) => ({ ...current, tier: "secondary" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveLaterality(condition: Condition, laterality: EyeChoice) {
    await runEdit("laterality", async () => {
      const stableKey = conditionCatalogStableKey(condition);
      const requiresResolution = conditionRequiresDeclaredBilateralResolution(condition);
      const diagnosis = requiresResolution
        ? (diagnosisCatalog.find((row) => row.stableKey === stableKey) ??
          (await loadDiagnosisCatalog(new AbortController().signal)).find((row) => row.stableKey === stableKey))
        : undefined;
      if (requiresResolution && !diagnosis) throw new Error("The eyelid diagnosis catalog row could not be loaded.");
      await updateConditionBodySite({ condition, patientReference, laterality, ...(diagnosis ? { diagnosis } : {}) });
    });
  }

  async function saveCode(condition: Condition, code: string, display: string) {
    await runEdit("code", async () => {
      await updateConditionCode({
        condition,
        code: {
          system: "http://hl7.org/fhir/sid/icd-10-cm",
          code,
          display,
        },
      });
    });
  }

  async function savePrincipal(condition: Condition) {
    if (!encounter) return;
    await runEdit("tier", async () => {
      await updateDiagnosisOrder(encounterId, principalDiagnosisOrder(encounter, condition));
    });
  }

  async function saveDiagnosisOrder(conditionReferences: string[]) {
    setBusy("reorder");
    setReorderError(undefined);
    try {
      await updateDiagnosisOrder(encounterId, conditionReferences);
      setReorderOpen(false);
      await load();
    } catch (caught) {
      setReorderError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function saveStatus(condition: Condition, status: "active" | "recurrence" | "resolved") {
    await runEdit("status", async () => {
      await updateConditionStatus({ condition, clinicalStatus: status });
    });
  }

  async function saveProblemStatus(condition: Condition, problemStatus: MdmProblemStatus) {
    if (!encounter) return;
    await runEdit("problem-status", async () => {
      await updateEncounterDiagnosisProblemStatus({ encounter, condition, problemStatus });
    });
  }

  async function saveVisitStatus(condition: Condition, status: DiagnosisVisitStatus) {
    if (!condition.id) return;
    await runEdit("visit-status", async () => {
      await updateDiagnosisVisitStatus({ encounterId, conditionId: condition.id!, status });
    });
  }

  async function markEnteredInError(condition: Condition) {
    await runEdit("entered-in-error", async () => {
      await markConditionEnteredInError(condition);
    });
  }

  async function decidePossible(condition: Condition, action: "confirm" | "discard") {
    const actionEncounterReference = encounterReference;
    const identifierValue = condition.identifier?.find((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM)?.value;
    if (!identifierValue) {
      setError("This possible diagnosis is missing its diagnosis catalog link.");
      return;
    }
    const [diagnosisKey = "", lateralityBucket] = identifierValue.split("::").slice(-2);
    await runEdit(action, async () => {
      const result = await submitDiagnosisPick({
        encounterReference,
        diagnosisKey,
        action,
        ...(lateralityBucket === "right" ? { laterality: "OD" as const } : {}),
        ...(lateralityBucket === "left" ? { laterality: "OS" as const } : {}),
        ...(lateralityBucket === "bilateral" ? { laterality: "OU" as const } : {}),
      });
      if (currentEncounterReference.current === actionEncounterReference) setDiagnosisDemotionImpact(result);
    }, false);
  }

  async function runEdit(label: string, action: () => Promise<void>, refreshAfter = true) {
    setBusy(label);
    setError(null);
    try {
      await action();
      if (refreshAfter) {
        await load();
        notifyEncounterDiagnosisUpdated(encounterReference);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const protocolDiagnoses = sortedConditions.flatMap((condition) => {
    if (!condition.id || verificationStatus(condition) !== "confirmed") return [];
    return (condition.code?.coding ?? []).flatMap((coding) => coding.code ? [{
      condition,
      reference: `Condition/${condition.id}`,
      code: coding.code,
      confirmed: true as const,
      visitStatus: diagnosisVisitStatuses[`Condition/${condition.id}`],
    }] : []);
  });
  const protocolOffer = protocolOffers.find((offer) => offer.id === selectedProtocolId) ?? protocolOffers[0];
  const acceptCharges = protocolOffer?.acceptCharges === true;
  const protocolApplication = protocolOffer
    ? protocolApplications.find((application) =>
        application.protocolId === protocolOffer.id &&
        application.confirmed &&
        application.undoState === "active"
      )
    : undefined;
  const protocolApplied = Boolean(protocolApplication);
  const protocolDiagnosis = protocolOffer?.trigger.kind === "diagnosis"
    ? protocolDiagnoses.find((diagnosis) =>
        protocolOffer.trigger.dxKeys.some((pattern) => matchesProtocolCode(diagnosis.code, pattern))
      )
    : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${clinicalGraphApiBase()}/clinical-graph/protocols/applications?encounterId=${encodeURIComponent(encounterId)}`, {
      headers: authHeaders(), signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as {
        applications?: Array<{ id: string; protocolId: string; confirmed: boolean; undoState: string }>;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `Protocol applications load failed: ${response.status}`);
      if (controller.signal.aborted) return;
      setProtocolApplications(body.applications ?? []);
    }).catch((reason) => {
      if ((reason as Error).name !== "AbortError") setError(String((reason as Error).message ?? reason));
    });
    return () => controller.abort();
  }, [encounterId]);

  useEffect(() => {
    if (!protocolDiagnoses.length) {
      const activeIds = activeProtocolIds(protocolApplications);
      setProtocolOffers((current) => retainAppliedProtocolOffers(current, protocolApplications));
      setSelectedProtocolId((selected) => selected && activeIds.has(selected) ? selected : undefined);
      return;
    }
    const controller = new AbortController();
    fetch(`${clinicalGraphApiBase()}/clinical-graph/protocols/offers`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        diagnoses: protocolDiagnoses.map(({ reference, code, confirmed, visitStatus }) => ({
          reference,
          code,
          confirmed,
          ...(visitStatus ? { visitStatus } : {}),
        })),
      }),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as { protocols?: ProtocolOffer[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Protocol offers load failed: ${response.status}`);
      if (controller.signal.aborted) return;
      const offers = body.protocols ?? [];
      setProtocolOffers(offers);
      setSelectedProtocolId((current) => offers.some((offer) => offer.id === current) ? current : offers[0]?.id);
    }).catch((reason) => {
      if ((reason as Error).name !== "AbortError") setError(String((reason as Error).message ?? reason));
    });
    return () => controller.abort();
  }, [
    JSON.stringify(protocolDiagnoses.map((row) => [row.reference, row.code, row.visitStatus])),
    JSON.stringify(protocolApplications.map((row) => [row.id, row.protocolId, row.confirmed, row.undoState])),
  ]);

  useEffect(() => {
    if (!protocolOffer) {
      setProtocolSelections({});
      return;
    }
    setProtocolSelections(Object.fromEntries(
      protocolOffer.items.map((item) => [item.itemKey, item.defaultSelected]),
    ));
  }, [protocolOffer?.id, protocolOffer?.version]);

  useEffect(() => {
    if (!protocolSheetOpen) return;
    const dialog = protocolDialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : protocolTriggerRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? [])];
    (focusable()[0] ?? dialog)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProtocolSheetOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [protocolSheetOpen]);

  async function applySelectedProtocol() {
    if (!protocolDiagnosis || !protocolOffer) return;
    setBusy("protocol"); setError(null);
    try {
      const body = await applyEncounterProtocol({
        protocolId: protocolOffer.id,
        encounterId,
        patientId: patientReference.replace(/^Patient\//, ""),
        diagnosis: {
          reference: protocolDiagnosis.reference,
          code: protocolDiagnosis.code,
          confirmed: true,
        },
        selections: Object.entries(protocolSelections).map(([itemKey, selected]) => ({ itemKey, selected })),
        acceptCharges,
      });
      if (body.application?.id) {
        setProtocolApplications((current) => [...current, {
          id: body.application!.id!,
          protocolId: protocolOffer.id,
          confirmed: true,
          undoState: "active",
        }]);
      }
      setProtocolSheetOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  }

  async function unapplyProtocol() {
    if (!protocolApplication?.id) return;
    setBusy("protocol-unapply"); setError(null);
    try {
      await unapplyEncounterProtocol(protocolApplication.id);
      setProtocolApplications((current) => current.map((application) =>
        application.id === protocolApplication.id ? { ...application, undoState: "unapplied" } : application
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  }

  async function saveAsProtocol() {
    if (!captureName.trim()) return;
    setBusy("protocol-capture");
    setError(null);
    try {
      const result = await captureEncounterProtocol(encounterId, captureName.trim());
      const url = `/clinic/protocols?protocol=${encodeURIComponent(result.protocol.id)}`;
      window.history.pushState({}, "", url);
      window.dispatchEvent(new Event("popstate"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[color:var(--odos-text)]">Assessment</h2>
            <p className="mt-1 text-sm text-[color:var(--odos-muted)]">
              Visit diagnoses are separate from the longitudinal problem list.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canShowEditing && (
              <ClearSectionButton
                encounterReference={encounterReference}
                sectionKey="assessment"
                label="Assessment"
                hasRecorded={conditions.length > 0}
                onCleared={(result) => {
                  void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
                  onCleared?.({ scope: "section", result });
                }}
              />
            )}
            {canShowEditing && onRefer && (
              <button type="button" className="sidebar-button" data-entry-sheet-pristine-action onClick={onRefer}>Refer to…</button>
            )}
            {canShowEditing && (
              <button type="button" className="sidebar-button" data-entry-sheet-pristine-action onClick={() => setCaptureOpen((current) => !current)}>
                Save as Protocol
              </button>
            )}
            <span className="rounded border border-[color:var(--odos-line)] px-3 py-2 text-xs text-[color:var(--odos-muted)]">
              {sortedConditions.length} visit diagnoses
            </span>
          </div>
        </div>

        {canShowEditing && (
          <div data-testid="diagnosis-tier-tagger" className="mt-5 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[150px_150px_1fr_auto]">
              <OdosSelect
                value={form.tier}
                options={[
                  { value: "principal", label: "Principal" },
                  { value: "secondary", label: "Secondary" },
                ]}
                onChange={(tier) => setForm({ ...form, tier: tier as DiagnosisTierChoice })}
                ariaLabel="Diagnosis tier"
              />
              <OdosSelect
                value={form.laterality}
                options={[
                  { value: "OD", label: "OD" },
                  { value: "OS", label: "OS" },
                  { value: "OU", label: "OU" },
                ]}
                onChange={(laterality) => setForm({ ...form, laterality: laterality as EyeChoice })}
                ariaLabel="Diagnosis laterality"
              />
              <OdosSearchPicker
                label="Diagnosis / ICD-10"
                value={form.code}
                selectedLabel={form.display}
                placeholder="Search diagnosis catalog"
                search={searchDiagnosisCodeOptions}
                onClear={() => setForm({ ...form, code: "", display: "" })}
                onSelect={(option) => setForm({ ...form, code: option.item.code, display: option.item.display })}
              />
              <button disabled={busy !== null || !form.code.trim()} onClick={addDiagnosis} className={BUTTON_CLASS}>
                Add diagnosis
              </button>
            </div>
          </div>
        )}

        {error && <div className="mt-4 rounded border border-[color:var(--odos-alert)] bg-[color:var(--odos-surface-2)] p-3 text-sm text-[color:var(--odos-alert)]">{error}</div>}
        {diagnosisDemotionImpact && (
          <div className="mt-4">
            <DiagnosisDemotionImpactNotice impact={diagnosisDemotionImpact} />
          </div>
        )}

        {canShowEditing && captureOpen && (
          <div className="mt-4 flex flex-wrap items-end gap-3 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4">
            <label className="min-w-[260px] flex-1">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]">Protocol name</span>
              <input
                className={INPUT_CLASS}
                value={captureName}
                placeholder="Dry Eye — Stable"
                onChange={(event) => setCaptureName(event.target.value)}
              />
            </label>
            <button type="button" className={BUTTON_CLASS} disabled={busy !== null || !captureName.trim()} onClick={() => void saveAsProtocol()}>
              {busy === "protocol-capture" ? "Capturing…" : "Capture and open builder"}
            </button>
          </div>
        )}

        {canShowEditing && protocolOffers.length > 0 && protocolOffer && (
          <div className="mt-4 rounded border border-[color:var(--odos-accent-border)] bg-[color:var(--odos-accent-tint-hi)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[color:var(--odos-text)]">Protocol offers</div>
                <div className="mt-1 text-xs text-[color:var(--odos-muted)]">Ranked by visit-status match; every matching diagnosis variant remains selectable.</div>
                <div className="mt-1 text-xs text-[color:var(--odos-muted)]">
                  {protocolApplicationDisclosure(acceptCharges)}
                </div>
              </div>
              <button
                ref={protocolTriggerRef}
                disabled={protocolActionDisabled(busy !== null, protocolApplication?.id, Boolean(protocolDiagnosis))}
                onClick={protocolApplied ? unapplyProtocol : () => setProtocolSheetOpen(true)}
                className={BUTTON_CLASS}
              >
                {protocolApplied ? "Un-apply" : "Apply selected"}
              </button>
            </div>
            <div className="mt-3 grid gap-2">
              {protocolOffers.map((offer, index) => {
                const applied = protocolApplications.some((application) =>
                  application.protocolId === offer.id && application.confirmed && application.undoState === "active"
                );
                return (
                  <label key={offer.id} className="flex items-center gap-3 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-3">
                    <input
                      type="radio"
                      name="protocol-offer"
                      checked={offer.id === protocolOffer.id}
                      onChange={() => setSelectedProtocolId(offer.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[color:var(--odos-text)]">{offer.title}</span>
                      <span className="mt-0.5 block text-xs text-[color:var(--odos-muted)]">
                        v{offer.version} · {offer.statusScope.length ? offer.statusScope.join(", ") : "all visit statuses"}
                        {index === 0 ? " · highest ranked" : ""}
                      </span>
                    </span>
                    {applied && <span className="text-xs font-semibold text-[color:var(--odos-emerald)]">Applied</span>}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {protocolSheetOpen && protocolOffer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--odos-chart-scrim)] p-4" role="dialog" aria-modal="true" aria-label="Protocol staging sheet">
            <div ref={protocolDialogRef} tabIndex={-1} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface)] p-5 shadow-2xl">
              <h3 className="text-lg font-semibold text-[color:var(--odos-text)]">{protocolOffer.title}</h3>
              <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Review each proposed item before committing it to this encounter.</p>
              <div className="mt-4">
                <ProtocolStagingList
                  items={protocolOffer.items}
                  selections={protocolSelections}
                  onToggle={(itemKey, selected) => setProtocolSelections((current) => ({ ...current, [itemKey]: selected }))}
                />
              </div>
              <div className="mt-5 flex justify-end gap-3">
                <button type="button" onClick={() => setProtocolSheetOpen(false)} className={BUTTON_CLASS}>Cancel</button>
                <button type="button" disabled={busy !== null} onClick={applySelectedProtocol} className={BUTTON_CLASS}>
                  {busy === "protocol" ? "Applying..." : protocolConfirmationLabel(acceptCharges)}
                </button>
              </div>
            </div>
          </div>
        )}

        {canShowEditing && sortedConditions.length > 1 && encounter?.status !== "finished" && (
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setReorderError(undefined);
                setReorderOpen(true);
              }}
              className={BUTTON_CLASS}
            >
              Reorder Impressions
            </button>
          </div>
        )}

        <div className="mt-5 space-y-3">
          {sortedConditions.length === 0 ? (
            <div className="rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4 text-sm text-[color:var(--odos-muted)]">
              No assessment diagnoses yet.
            </div>
          ) : (
            sortedConditions.map((condition) => {
              const rank = encounter ? diagnosisRank(encounter, condition) : undefined;
              return (
                <DiagnosisCard
                  key={condition.id}
                  condition={condition}
                  codeLabel={conditionResolvedCodeLabel(condition, diagnosisCatalog)}
                  rank={rank}
                  editing={editingId === condition.id}
                  canShowEditing={canShowEditing}
                  busy={busy}
                  provenanceLine={condition.id ? provenanceLines[condition.id] : undefined}
                  possible={verificationStatus(condition) === "provisional"}
                  visitStatus={condition.id ? diagnosisVisitStatuses[`Condition/${condition.id}`] : undefined}
                  visitStatusDisabled={!canShowEditing || encounter?.status === "finished"}
                  problemStatus={encounterProblemStatus(encounter, condition)}
                  problemStatusDisabled={!canShowEditing || encounter?.status === "finished"}
                  onToggle={() => setEditingId((current) => (current === condition.id ? null : condition.id ?? null))}
                  onLaterality={(laterality) => saveLaterality(condition, laterality)}
                  onCode={(code, display) => saveCode(condition, code, display)}
                  onMakePrincipal={() => savePrincipal(condition)}
                  onStatus={(status) => saveStatus(condition, status)}
                  onVisitStatus={(status) => saveVisitStatus(condition, status)}
                  onProblemStatus={(status) => saveProblemStatus(condition, status)}
                  onEnteredInError={() => markEnteredInError(condition)}
                  onConfirm={() => decidePossible(condition, "confirm")}
                  onDiscard={() => decidePossible(condition, "discard")}
                  onEngage={condition.id && onEngageDiagnosis ? () => {
                    const coding = condition.code?.coding?.find((candidate) => candidate.code);
                    if (!coding?.code) return;
                    onEngageDiagnosis({
                      reference: `Condition/${condition.id}`,
                      code: coding.code,
                      display: displayCode(condition.code),
                    });
                  } : undefined}
                />
              );
            })
          )}
        </div>
        {reorderOpen && encounter && (
          <ReorderImpressionsModal
            rows={buildReorderImpressionRows(encounter, conditions, attachedProcedures)}
            busy={busy === "reorder"}
            attachmentError={reorderError ?? procedureAttachmentError}
            onCancel={() => setReorderOpen(false)}
            onSave={saveDiagnosisOrder}
          />
        )}
      </div>
    </section>
  );
}

export function protocolApplicationDisclosure(acceptCharges: boolean): string {
  return acceptCharges
    ? "Reviewable protocol defaults; confirmation writes exam prompts, plan actions, and accepted charges."
    : "Reviewable protocol defaults; applying writes committed exam seeds, plan actions, and staged charges.";
}

export function protocolConfirmationLabel(acceptCharges: boolean): string {
  return acceptCharges ? "Confirm, accept charges, and apply" : "Confirm and apply";
}

function DiagnosisCard({
  condition,
  codeLabel,
  rank,
  editing,
  canShowEditing,
  busy,
  provenanceLine,
  possible,
  visitStatus,
  visitStatusDisabled,
  problemStatus,
  problemStatusDisabled,
  onToggle,
  onLaterality,
  onCode,
  onMakePrincipal,
  onStatus,
  onVisitStatus,
  onProblemStatus,
  onEnteredInError,
  onConfirm,
  onDiscard,
  onEngage,
}: {
  condition: Condition;
  codeLabel: string;
  rank: number | undefined;
  editing: boolean;
  canShowEditing: boolean;
  busy: string | null;
  provenanceLine?: string;
  possible: boolean;
  visitStatus?: DiagnosisVisitStatus;
  visitStatusDisabled: boolean;
  problemStatus?: MdmProblemStatus;
  problemStatusDisabled: boolean;
  onToggle: () => void;
  onLaterality: (laterality: EyeChoice) => void;
  onCode: (code: string, display: string) => void;
  onMakePrincipal: () => void;
  onStatus: (status: "active" | "recurrence" | "resolved") => void;
  onVisitStatus: (status: DiagnosisVisitStatus) => void;
  onProblemStatus: (status: MdmProblemStatus) => void;
  onEnteredInError: () => void;
  onConfirm: () => void;
  onDiscard: () => void;
  onEngage?: () => void;
}) {
  const [laterality, setLaterality] = useState<EyeChoice>("OU");
  const [code, setCode] = useState(condition.code?.coding?.find((coding) => coding.system === ICD10_CM_CODE_SYSTEM)?.code ?? "");
  const [display, setDisplay] = useState(displayCode(condition.code));
  const [status, setStatus] = useState<"active" | "recurrence" | "resolved">(
    normalizeClinicalStatus(clinicalStatus(condition)),
  );

  return (
    <div data-testid="diagnosis-card" className={possible ? "rounded-full border border-[color:var(--odos-amber)] bg-[color:var(--odos-surface-2)] px-4 py-3" : "rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button
          type="button"
          onClick={canShowEditing ? onToggle : undefined}
          className="min-w-0 flex-1 text-left"
        >
          <div>
            <div className="text-base font-semibold text-[color:var(--odos-text)]">{displayCode(condition.code)}</div>
            <div className="mt-1 text-xs text-[color:var(--odos-muted)]">
              {possible ? "Possible" : rank === 1 ? "Principal" : `Secondary rank ${rank ?? "unranked"}`} · {clinicalStatus(condition)} · {codeLabel}
            </div>
            {provenanceLine && <div className="mt-1 text-xs text-[color:var(--odos-accent)]">← from {provenanceLine}</div>}
          </div>
        </button>
        {!possible && (
          <div className="flex min-w-[18rem] flex-col gap-2">
            <DiagnosisProblemStatusField
              value={problemStatus}
              disabled={problemStatusDisabled || busy !== null}
              onChange={onProblemStatus}
            />
            <OdosSelect
              value={visitStatus ?? ""}
              disabled={visitStatusDisabled || busy !== null}
              options={[
                { value: "", label: "" },
                ...DIAGNOSIS_VISIT_STATUSES.map((choice) => ({ value: choice, label: visitStatusLabel(choice) })),
              ]}
              onChange={(value) => {
                if (value) onVisitStatus(value as DiagnosisVisitStatus);
              }}
              ariaLabel="Diagnosis visit status"
            />
            {canShowEditing && <button type="button" onClick={onToggle} className="text-xs text-[color:var(--odos-accent)]">Edit</button>}
          </div>
        )}
        {onEngage && (
          <button type="button" className="sidebar-button" aria-label={`Engage ${displayCode(condition.code)}`} onClick={onEngage}>
            Engage
          </button>
        )}
      </div>

      {possible && canShowEditing && (
        <div className="mt-2 flex gap-2">
          <button disabled={busy !== null} onClick={onConfirm} className="rounded border border-[color:var(--odos-emerald)] bg-[color:var(--odos-surface-2)] px-3 py-1.5 text-xs font-semibold text-[color:var(--odos-emerald)] disabled:opacity-45">Confirm</button>
          <button disabled={busy !== null} onClick={onDiscard} className="rounded border border-[color:var(--odos-alert)] bg-[color:var(--odos-surface-2)] px-3 py-1.5 text-xs font-semibold text-[color:var(--odos-alert)] disabled:opacity-45">Discard</button>
        </div>
      )}

      {editing && !possible && (
        <div className="mt-4 grid gap-3 border-t border-[color:var(--odos-line)] pt-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr_auto]">
            <OdosSelect
              value={laterality}
              options={[
                { value: "OD", label: "OD" },
                { value: "OS", label: "OS" },
                { value: "OU", label: "OU" },
              ]}
              onChange={(value) => setLaterality(value as EyeChoice)}
              ariaLabel="Problem laterality"
            />
            <div className="self-center text-sm text-[color:var(--odos-muted)]">Laterality correction</div>
            <button disabled={busy !== null} onClick={() => onLaterality(laterality)} className={BUTTON_CLASS}>Save</button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
            <OdosSearchPicker
              label="Recode diagnosis"
              value={code}
              selectedLabel={display}
              placeholder="Search diagnosis catalog"
              search={searchDiagnosisCodeOptions}
              onClear={() => { setCode(""); setDisplay(""); }}
              onSelect={(option) => {
                setCode(option.item.code);
                setDisplay(option.item.display);
              }}
            />
            <button disabled={busy !== null || !code.trim()} onClick={() => onCode(code, display)} className={BUTTON_CLASS}>Recode</button>
          </div>
          <DiagnosisRankActions
            possible={possible}
            principal={rank === 1}
            busy={busy !== null}
            onMakePrincipal={onMakePrincipal}
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_1fr_auto_auto]">
            <OdosSelect
              value={status}
              options={[
                { value: "active", label: "active" },
                { value: "recurrence", label: "recurrence" },
                { value: "resolved", label: "resolved" },
              ]}
              onChange={(value) => setStatus(value as "active" | "recurrence" | "resolved")}
              ariaLabel="Diagnosis clinical status"
            />
            <div className="self-center text-sm text-[color:var(--odos-muted)]">Clinical status</div>
            <button disabled={busy !== null} onClick={() => onStatus(status)} className={BUTTON_CLASS}>Save status</button>
            <button disabled={busy !== null} onClick={onEnteredInError} className="rounded border border-[color:var(--odos-alert)] bg-[color:var(--odos-surface-2)] px-3 py-2 text-sm font-semibold text-[color:var(--odos-alert)] transition hover:bg-[color:var(--odos-surface)]">
              Entered in error
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DiagnosisProblemStatusField({
  value,
  disabled,
  onChange,
}: {
  value?: MdmProblemStatus;
  disabled: boolean;
  onChange: (value: MdmProblemStatus) => void;
}) {
  return (
    <div
      data-testid="diagnosis-problem-status"
      data-required={value ? undefined : "true"}
      className={[
        "rounded border p-2",
        value
          ? "border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface-2)]"
          : "border-[color:var(--odos-amber)] bg-[color:var(--odos-amber-wash)]",
      ].join(" ")}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]">
        <span>Problem status</span>
        {!value && <span className="text-[color:var(--odos-amber)]">Required</span>}
      </div>
      <OdosSelect<MdmProblemStatus | "">
        value={value ?? ""}
        disabled={disabled}
        options={[
          { value: "", label: "Required — select status", disabled: true },
          ...MDM_PROBLEM_STATUSES.map((status) => ({ value: status.code, label: status.display })),
        ]}
        onChange={(next) => {
          if (next) onChange(next);
        }}
        ariaLabel="Problem status"
      />
    </div>
  );
}

function encounterProblemStatus(encounter: Encounter | null, condition: Condition): MdmProblemStatus | undefined {
  const diagnosis = encounter?.diagnosis?.find(
    (entry) => entry.condition.reference === `Condition/${condition.id}`,
  );
  return diagnosis ? encounterDiagnosisProblemStatus(diagnosis) : undefined;
}

function notifyEncounterDiagnosisUpdated(encounterReference: string): void {
  window.dispatchEvent(new CustomEvent("odos:encounter-diagnosis-updated", {
    detail: { encounterReference },
  }));
}

async function loadDiagnosisCatalog(signal: AbortSignal): Promise<DiagnosisCatalogCodeRow[]> {
  if (cachedDiagnosisCatalog) return cachedDiagnosisCatalog;
  const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-catalog`, {
    headers: authHeaders(),
    signal,
  });
  const body = await response.json() as {
    diagnoses?: DiagnosisCatalogCodeRow[];
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? `Diagnosis catalog request failed: ${response.status}`);
  cachedDiagnosisCatalog = body.diagnoses ?? [];
  return cachedDiagnosisCatalog;
}

async function searchDiagnosisCodeOptions(query: string, signal: AbortSignal) {
  const diagnoses = await loadDiagnosisCatalog(signal);
  const normalized = query.trim().toLocaleLowerCase();
  return diagnoses.flatMap((row) => {
    const code = row.icd10 && ("code" in row.icd10 ? row.icd10.code : row.icd10.pattern.unspecifiedEye);
    if (
      !row.active
      || row.codingStatus !== "verified"
      || !code
      || !`${row.display} ${row.stableKey} ${code}`.toLocaleLowerCase().includes(normalized)
    ) return [];
    const item = { code, display: row.display } satisfies DiagnosisCodeOption;
    return [{
      value: code,
      label: row.display,
      description: code,
      item,
    }];
  }).slice(0, 20);
}

export function DiagnosisRankActions({
  possible,
  principal,
  busy,
  onMakePrincipal,
}: {
  possible: boolean;
  principal: boolean;
  busy: boolean;
  onMakePrincipal: () => void;
}) {
  if (possible || principal) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <button disabled={busy} onClick={onMakePrincipal} className={BUTTON_CLASS}>Make Principal</button>
    </div>
  );
}

function normalizeClinicalStatus(value: string): "active" | "recurrence" | "resolved" {
  if (value === "recurrence" || value === "resolved") return value;
  return "active";
}

function visitStatusLabel(status: DiagnosisVisitStatus): string {
  if (status === "resolved-this-visit") return "Resolved this visit";
  return status[0]!.toUpperCase() + status.slice(1);
}

function matchesProtocolCode(code: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(code);
}

function verificationStatus(condition: Condition): string {
  return condition.verificationStatus?.coding?.find((coding) => coding.system === VERIFICATION_STATUS_SYSTEM)?.code ??
    condition.verificationStatus?.text ?? "unknown";
}

export function findingProvenanceLine(observation: Observation): string {
  const stableCode = observation.code.coding?.find((coding) => coding.code)?.code;
  const label = stableCode === "cup_disc_ratio"
    ? "Cup/Disc"
    : observation.code.text ?? observation.code.coding?.find((coding) => coding.display)?.display ?? stableCode ?? "Finding";
  const laterality = observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  const value = findingValue(observation);
  return [label, value, laterality].filter(Boolean).join(" ");
}

function findingValue(observation: Observation): string | undefined {
  if (observation.valueQuantity?.value !== undefined) return String(observation.valueQuantity.value);
  if (observation.valueString) {
    try {
      const parsed = JSON.parse(observation.valueString) as Record<string, unknown>;
      const ratio = parsed.verticalCupDiscRatio ?? parsed.cupDiscRatio;
      if (typeof ratio === "number") return ratio.toFixed(2);
    } catch {
      return observation.valueString;
    }
  }
  const sphere = observation.component?.find((component) => component.code.coding?.some((coding) => coding.code === "SPHERE"))?.valueQuantity?.value;
  return sphere !== undefined ? `${sphere >= 0 ? "+" : ""}${sphere.toFixed(2)} D` : undefined;
}
