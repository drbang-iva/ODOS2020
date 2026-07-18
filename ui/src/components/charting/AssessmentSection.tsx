import { useEffect, useMemo, useState } from "react";
import type { Condition, Encounter, Observation } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import { useRole } from "../../lib/role-context";
import {
  createEncounterDiagnosis,
  markConditionEnteredInError,
  updateConditionBodySite,
  updateConditionCode,
  updateConditionStatus,
  updateConditionTier,
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
import { submitDiagnosisPick } from "../../lib/clinical-graph-client";
import { ODOS_EXTENSION_URLS } from "../../lib/fhir-ophthalmology/extensions";

const DIAGNOSIS_KEY_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key";
const VERIFICATION_STATUS_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-ver-status";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

interface FormState {
  code: string;
  display: string;
  laterality: EyeChoice;
  tier: DiagnosisTierChoice;
}

const INITIAL_FORM: FormState = {
  code: "H52.13",
  display: "Myopia, bilateral",
  laterality: "OU",
  tier: "principal",
};

export function AssessmentSection({ patientReference, encounterReference, onSaved }: Props) {
  const { role } = useRole();
  const canShowEditing = role !== "front-desk";
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [provenanceLines, setProvenanceLines] = useState<Record<string, string>>({});
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const encounterId = encounterReference.replace(/^Encounter\//, "");

  async function load() {
    setError(null);
    const loadedEncounter = await fhir.read<Encounter>("Encounter", encounterId);
    const conditionBundle = await fhir.search<Condition>("Condition", {
      encounter: encounterReference,
      _count: "40",
    });
    setEncounter(loadedEncounter);
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

  async function saveTier(condition: Condition, rank: number) {
    if (!encounter) return;
    await runEdit("tier", async () => {
      await updateConditionTier({ encounter, condition, rank });
    });
  }

  async function saveStatus(condition: Condition, status: "active" | "recurrence" | "resolved") {
    await runEdit("status", async () => {
      await updateConditionStatus({ condition, clinicalStatus: status });
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
    const [diagnosisKey = "", lateralityBucket] = identifierValue.split("::");
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

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Assessment</h2>
            <p className="mt-1 text-sm text-white/45">
              Visit diagnoses are separate from the longitudinal problem list.
            </p>
          </div>
          <span className="rounded border border-white/10 px-3 py-2 text-xs text-white/45">
            {sortedConditions.length} visit diagnoses
          </span>
        </div>

        {canShowEditing && (
          <div data-testid="diagnosis-tier-tagger" className="mt-5 rounded border border-white/10 bg-bg-panel/70 p-4">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[150px_150px_1fr_1fr_auto]">
              <select value={form.tier} onChange={(event) => setForm({ ...form, tier: event.target.value as DiagnosisTierChoice })} className="sidebar-input">
                <option value="principal">Principal</option>
                <option value="secondary">Secondary</option>
              </select>
              <select value={form.laterality} onChange={(event) => setForm({ ...form, laterality: event.target.value as EyeChoice })} className="sidebar-input">
                <option value="OD">OD</option>
                <option value="OS">OS</option>
                <option value="OU">OU</option>
              </select>
              <input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} className="sidebar-input" placeholder="ICD-10" />
              <input value={form.display} onChange={(event) => setForm({ ...form, display: event.target.value })} className="sidebar-input" placeholder="Diagnosis label" />
              <button disabled={busy !== null || !form.code.trim()} onClick={addDiagnosis} className="sidebar-button">
                Add diagnosis
              </button>
            </div>
          </div>
        )}

        {error && <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">{error}</div>}

        <div className="mt-5 space-y-3">
          {sortedConditions.length === 0 ? (
            <div className="rounded border border-white/10 bg-bg-panel/60 p-4 text-sm text-white/45">
              No assessment diagnoses yet.
            </div>
          ) : (
            sortedConditions.map((condition) => (
              <DiagnosisCard
                key={condition.id}
                condition={condition}
                rank={encounter ? diagnosisRank(encounter, condition) : undefined}
                editing={editingId === condition.id}
                canShowEditing={canShowEditing}
                busy={busy}
                provenanceLine={condition.id ? provenanceLines[condition.id] : undefined}
                possible={verificationStatus(condition) === "provisional"}
                onToggle={() => setEditingId((current) => (current === condition.id ? null : condition.id ?? null))}
                onLaterality={(laterality) => saveLaterality(condition, laterality)}
                onCode={(code, display) => saveCode(condition, code, display)}
                onTier={(rank) => saveTier(condition, rank)}
                onStatus={(status) => saveStatus(condition, status)}
                onEnteredInError={() => markEnteredInError(condition)}
                onConfirm={() => decidePossible(condition, "confirm")}
                onDiscard={() => decidePossible(condition, "discard")}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function DiagnosisCard({
  condition,
  rank,
  editing,
  canShowEditing,
  busy,
  provenanceLine,
  possible,
  onToggle,
  onLaterality,
  onCode,
  onTier,
  onStatus,
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
  onToggle: () => void;
  onLaterality: (laterality: EyeChoice) => void;
  onCode: (code: string, display: string) => void;
  onTier: (rank: number) => void;
  onStatus: (status: "active" | "recurrence" | "resolved") => void;
  onEnteredInError: () => void;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const [laterality, setLaterality] = useState<EyeChoice>("OU");
  const [code, setCode] = useState(condition.code?.coding?.[0]?.code ?? "");
  const [display, setDisplay] = useState(displayCode(condition.code));
  const [nextRank, setNextRank] = useState(String(rank ?? 1));
  const [status, setStatus] = useState<"active" | "recurrence" | "resolved">(
    normalizeClinicalStatus(clinicalStatus(condition)),
  );

  return (
    <div data-testid="diagnosis-card" className={possible ? "rounded-full border border-amber-300/30 bg-amber-400/[0.06] px-4 py-3" : "rounded border border-white/10 bg-bg-panel/70 p-4"}>
      <button
        type="button"
        onClick={canShowEditing ? onToggle : undefined}
        className="w-full text-left"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold text-white">{displayCode(condition.code)}</div>
            <div className="mt-1 text-xs text-white/45">
              {possible ? "Possible" : rank === 1 ? "Principal" : `Secondary rank ${rank ?? "unranked"}`} · {clinicalStatus(condition)}
            </div>
            {provenanceLine && <div className="mt-1 text-xs text-brand/75">← from {provenanceLine}</div>}
          </div>
          {canShowEditing && !possible && <span className="text-xs text-brand">Edit</span>}
        </div>
      </button>

      {possible && canShowEditing && (
        <div className="mt-2 flex gap-2">
          <button disabled={busy !== null} onClick={onConfirm} className="rounded border border-emerald-300/35 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-100 disabled:opacity-45">Confirm</button>
          <button disabled={busy !== null} onClick={onDiscard} className="rounded border border-red-300/35 bg-red-400/10 px-3 py-1.5 text-xs font-semibold text-red-100 disabled:opacity-45">Discard</button>
        </div>
      )}

      {editing && !possible && (
        <div className="mt-4 grid gap-3 border-t border-white/10 pt-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr_auto]">
            <select value={laterality} onChange={(event) => setLaterality(event.target.value as EyeChoice)} className="sidebar-input">
              <option value="OD">OD</option>
              <option value="OS">OS</option>
              <option value="OU">OU</option>
            </select>
            <div className="text-sm text-white/45 self-center">Laterality correction</div>
            <button disabled={busy !== null} onClick={() => onLaterality(laterality)} className="sidebar-button">Save</button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_auto]">
            <input value={code} onChange={(event) => setCode(event.target.value)} className="sidebar-input" />
            <input value={display} onChange={(event) => setDisplay(event.target.value)} className="sidebar-input" />
            <button disabled={busy !== null || !code.trim()} onClick={() => onCode(code, display)} className="sidebar-button">Recode</button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr_auto]">
            <input value={nextRank} onChange={(event) => setNextRank(event.target.value)} inputMode="numeric" className="sidebar-input" />
            <div className="text-sm text-white/45 self-center">Tier rank</div>
            <button disabled={busy !== null || !Number(nextRank)} onClick={() => onTier(Number(nextRank))} className="sidebar-button">Save tier</button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_1fr_auto_auto]">
            <select value={status} onChange={(event) => setStatus(event.target.value as "active" | "recurrence" | "resolved")} className="sidebar-input">
              <option value="active">active</option>
              <option value="recurrence">recurrence</option>
              <option value="resolved">resolved</option>
            </select>
            <div className="text-sm text-white/45 self-center">Clinical status</div>
            <button disabled={busy !== null} onClick={() => onStatus(status)} className="sidebar-button">Save status</button>
            <button disabled={busy !== null} onClick={onEnteredInError} className="rounded border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-100 transition hover:bg-red-400/20">
              Entered in error
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeClinicalStatus(value: string): "active" | "recurrence" | "resolved" {
  if (value === "recurrence" || value === "resolved") return value;
  return "active";
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
