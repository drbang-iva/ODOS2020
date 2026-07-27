import { useEffect, useMemo, useRef, useState } from "react";
import type { Condition, Encounter, Observation } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import { useRole } from "../../lib/role-context";
import {
  createEncounterDiagnosis,
  hasValidDiagnosisRanks,
  makeConditionPrincipal,
  markConditionEnteredInError,
  swapConditionRanks,
  updateConditionBodySite,
  updateConditionCode,
  updateConditionStatus,
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
  readDiagnosisVisitStatuses,
  submitDiagnosisPick,
  updateDiagnosisVisitStatus,
  type DiagnosisVisitStatus,
} from "../../lib/clinical-graph-client";
import { ODOS_EXTENSION_URLS } from "../../lib/fhir-ophthalmology/extensions";
import {
  applyEncounterProtocol,
  captureEncounterProtocol,
  protocolActionDisabled,
  retainAppliedProtocolOffers,
  unapplyEncounterProtocol,
  type ProtocolItem,
} from "../../lib/protocol-authoring";
import { ProtocolStagingList } from "./ProtocolStagingList";

const DIAGNOSIS_KEY_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key";
const VERIFICATION_STATUS_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-ver-status";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
  onRefer?: () => void;
}

interface FormState {
  code: string;
  display: string;
  laterality: EyeChoice;
  tier: DiagnosisTierChoice;
}
interface ProtocolOffer {
  id: string;
  title: string;
  version: number;
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

export function AssessmentSection({ patientReference, encounterReference, onSaved, onRefer }: Props) {
  const { role } = useRole();
  const canShowEditing = role !== "front-desk";
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [provenanceLines, setProvenanceLines] = useState<Record<string, string>>({});
  const [diagnosisVisitStatuses, setDiagnosisVisitStatuses] = useState<Record<string, DiagnosisVisitStatus>>({});
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureName, setCaptureName] = useState("");
  const protocolTriggerRef = useRef<HTMLButtonElement>(null);
  const protocolDialogRef = useRef<HTMLDivElement>(null);
  const encounterId = encounterReference.replace(/^Encounter\//, "");

  async function load() {
    setError(null);
    const loadedEncounter = await fhir.read<Encounter>("Encounter", encounterId);
    const [conditionBundle, visitStatuses] = await Promise.all([
      fhir.search<Condition>("Condition", {
        encounter: encounterReference,
        _count: "40",
      }),
      readDiagnosisVisitStatuses(encounterId),
    ]);
    setEncounter(loadedEncounter);
    setDiagnosisVisitStatuses(Object.fromEntries(visitStatuses.map((row) => [row.conditionReference, row.status])));
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
      await updateConditionBodySite({ condition, patientReference, laterality });
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
      await makeConditionPrincipal({ encounter, condition });
    });
  }

  async function saveRankSwap(condition: Condition, adjacentCondition: Condition) {
    if (!encounter) return;
    await runEdit("tier", async () => {
      await swapConditionRanks({ encounter, condition, adjacentCondition });
    });
  }

  async function saveStatus(condition: Condition, status: "active" | "recurrence" | "resolved") {
    await runEdit("status", async () => {
      await updateConditionStatus({ condition, clinicalStatus: status });
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
    const identifierValue = condition.identifier?.find((identifier) => identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM)?.value;
    if (!identifierValue) {
      setError("This possible diagnosis is missing its diagnosis catalog link.");
      return;
    }
    const [diagnosisKey = "", lateralityBucket] = identifierValue.split("::").slice(-2);
    await runEdit(action, async () => {
      await submitDiagnosisPick({
        encounterReference,
        diagnosisKey,
        action,
        ...(lateralityBucket === "right" ? { laterality: "OD" as const } : {}),
        ...(lateralityBucket === "left" ? { laterality: "OS" as const } : {}),
        ...(lateralityBucket === "bilateral" ? { laterality: "OU" as const } : {}),
      });
    }, false);
  }

  async function runEdit(label: string, action: () => Promise<void>, refreshAfter = true) {
    setBusy(label);
    setError(null);
    try {
      await action();
      if (refreshAfter) await load();
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
      const activeIds = new Set(protocolApplications
        .filter((application) => application.confirmed && application.undoState === "active")
        .map((application) => application.protocolId));
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
            {canShowEditing && onRefer && (
              <button type="button" className="sidebar-button" onClick={onRefer}>Refer to…</button>
            )}
            {canShowEditing && (
              <button type="button" className="sidebar-button" onClick={() => setCaptureOpen((current) => !current)}>
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
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[150px_150px_1fr_1fr_auto]">
              <select value={form.tier} onChange={(event) => setForm({ ...form, tier: event.target.value as DiagnosisTierChoice })} className={INPUT_CLASS}>
                <option value="principal">Principal</option>
                <option value="secondary">Secondary</option>
              </select>
              <select value={form.laterality} onChange={(event) => setForm({ ...form, laterality: event.target.value as EyeChoice })} className={INPUT_CLASS}>
                <option value="OD">OD</option>
                <option value="OS">OS</option>
                <option value="OU">OU</option>
              </select>
              <input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} className={INPUT_CLASS} placeholder="ICD-10" />
              <input value={form.display} onChange={(event) => setForm({ ...form, display: event.target.value })} className={INPUT_CLASS} placeholder="Diagnosis label" />
              <button disabled={busy !== null || !form.code.trim()} onClick={addDiagnosis} className={BUTTON_CLASS}>
                Add diagnosis
              </button>
            </div>
          </div>
        )}

        {error && <div className="mt-4 rounded border border-[color:var(--odos-alert)] bg-[color:var(--odos-surface-2)] p-3 text-sm text-[color:var(--odos-alert)]">{error}</div>}

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
                  {busy === "protocol" ? "Applying..." : "Confirm and apply"}
                </button>
              </div>
            </div>
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
              const rankMoves = encounter
                ? diagnosisRankMoveNeighbors(encounter, sortedConditions, condition)
                : {};
              return (
                <DiagnosisCard
                  key={condition.id}
                  condition={condition}
                  rank={rank}
                  editing={editingId === condition.id}
                  canShowEditing={canShowEditing}
                  busy={busy}
                  provenanceLine={condition.id ? provenanceLines[condition.id] : undefined}
                  possible={verificationStatus(condition) === "provisional"}
                  canMoveUp={rankMoves.up !== undefined}
                  canMoveDown={rankMoves.down !== undefined}
                  visitStatus={condition.id ? diagnosisVisitStatuses[`Condition/${condition.id}`] : undefined}
                  visitStatusDisabled={!canShowEditing || encounter?.status === "finished"}
                  onToggle={() => setEditingId((current) => (current === condition.id ? null : condition.id ?? null))}
                  onLaterality={(laterality) => saveLaterality(condition, laterality)}
                  onCode={(code, display) => saveCode(condition, code, display)}
                  onMakePrincipal={() => savePrincipal(condition)}
                  onMoveUp={() => saveRankSwap(condition, rankMoves.up!)}
                  onMoveDown={() => saveRankSwap(condition, rankMoves.down!)}
                  onStatus={(status) => saveStatus(condition, status)}
                  onVisitStatus={(status) => saveVisitStatus(condition, status)}
                  onEnteredInError={() => markEnteredInError(condition)}
                  onConfirm={() => decidePossible(condition, "confirm")}
                  onDiscard={() => decidePossible(condition, "discard")}
                />
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

export function diagnosisRankMoveNeighbors(
  encounter: Encounter,
  sortedConditions: Condition[],
  condition: Condition,
): { up?: Condition; down?: Condition } {
  if (!hasValidDiagnosisRanks(encounter)) return {};
  const movableSecondaries = sortedConditions.filter((candidate) => {
    const rank = diagnosisRank(encounter, candidate);
    return verificationStatus(candidate) !== "provisional" &&
      rank !== undefined &&
      Number.isInteger(rank) &&
      rank > 1;
  });
  const index = movableSecondaries.findIndex((candidate) => candidate.id === condition.id);
  if (index < 0) return {};
  return {
    up: movableSecondaries[index - 1],
    down: movableSecondaries[index + 1],
  };
}

function DiagnosisCard({
  condition,
  rank,
  editing,
  canShowEditing,
  busy,
  provenanceLine,
  possible,
  canMoveUp,
  canMoveDown,
  visitStatus,
  visitStatusDisabled,
  onToggle,
  onLaterality,
  onCode,
  onMakePrincipal,
  onMoveUp,
  onMoveDown,
  onStatus,
  onVisitStatus,
  onEnteredInError,
  onConfirm,
  onDiscard,
}: {
  condition: Condition;
  rank: number | undefined;
  editing: boolean;
  canShowEditing: boolean;
  busy: string | null;
  provenanceLine?: string;
  possible: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  visitStatus?: DiagnosisVisitStatus;
  visitStatusDisabled: boolean;
  onToggle: () => void;
  onLaterality: (laterality: EyeChoice) => void;
  onCode: (code: string, display: string) => void;
  onMakePrincipal: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onStatus: (status: "active" | "recurrence" | "resolved") => void;
  onVisitStatus: (status: DiagnosisVisitStatus) => void;
  onEnteredInError: () => void;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const [laterality, setLaterality] = useState<EyeChoice>("OU");
  const [code, setCode] = useState(condition.code?.coding?.[0]?.code ?? "");
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
              {possible ? "Possible" : rank === 1 ? "Principal" : `Secondary rank ${rank ?? "unranked"}`} · {clinicalStatus(condition)}
            </div>
            {provenanceLine && <div className="mt-1 text-xs text-[color:var(--odos-accent)]">← from {provenanceLine}</div>}
          </div>
        </button>
        {!possible && (
          <div className="flex items-center gap-2">
            <select
              aria-label="Diagnosis visit status"
              value={visitStatus ?? ""}
              disabled={visitStatusDisabled || busy !== null}
              onChange={(event) => {
                if (event.target.value) onVisitStatus(event.target.value as DiagnosisVisitStatus);
              }}
              className="h-8 rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-2 text-xs text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)] disabled:opacity-60"
            >
              <option value=""></option>
              {DIAGNOSIS_VISIT_STATUSES.map((choice) => (
                <option key={choice} value={choice}>{visitStatusLabel(choice)}</option>
              ))}
            </select>
            {canShowEditing && <button type="button" onClick={onToggle} className="text-xs text-[color:var(--odos-accent)]">Edit</button>}
          </div>
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
            <select value={laterality} onChange={(event) => setLaterality(event.target.value as EyeChoice)} className={INPUT_CLASS}>
              <option value="OD">OD</option>
              <option value="OS">OS</option>
              <option value="OU">OU</option>
            </select>
            <div className="self-center text-sm text-[color:var(--odos-muted)]">Laterality correction</div>
            <button disabled={busy !== null} onClick={() => onLaterality(laterality)} className={BUTTON_CLASS}>Save</button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_auto]">
            <input value={code} onChange={(event) => setCode(event.target.value)} className={INPUT_CLASS} />
            <input value={display} onChange={(event) => setDisplay(event.target.value)} className={INPUT_CLASS} />
            <button disabled={busy !== null || !code.trim()} onClick={() => onCode(code, display)} className={BUTTON_CLASS}>Recode</button>
          </div>
          <DiagnosisRankActions
            possible={possible}
            principal={rank === 1}
            busy={busy !== null}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onMakePrincipal={onMakePrincipal}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_1fr_auto_auto]">
            <select value={status} onChange={(event) => setStatus(event.target.value as "active" | "recurrence" | "resolved")} className={INPUT_CLASS}>
              <option value="active">active</option>
              <option value="recurrence">recurrence</option>
              <option value="resolved">resolved</option>
            </select>
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

export function DiagnosisRankActions({
  possible,
  principal,
  busy,
  canMoveUp,
  canMoveDown,
  onMakePrincipal,
  onMoveUp,
  onMoveDown,
}: {
  possible: boolean;
  principal: boolean;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMakePrincipal: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  if (possible || principal) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <button disabled={busy} onClick={onMakePrincipal} className={BUTTON_CLASS}>Make Principal</button>
      <button disabled={busy || !canMoveUp} onClick={onMoveUp} className={BUTTON_CLASS}>Move up</button>
      <button disabled={busy || !canMoveDown} onClick={onMoveDown} className={BUTTON_CLASS}>Move down</button>
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

function findingProvenanceLine(observation: Observation): string {
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
