import { useEffect, useMemo, useState } from "react";
import type { Condition, Encounter, MedicationRequest } from "@medplum/fhirtypes";
import { clinicalStatus, displayCode, isEncounterDiagnosisCondition } from "../../lib/clinical-view-model";
import { fhir } from "../../lib/fhir";
import {
  buildMedicationRequest,
  ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  type MedicationTransmissionMethod,
} from "../../lib/fhir-medication-order";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

export interface PrescriptionDraft {
  drug: string;
  sig: string;
  quantity: string;
  refills: string;
  daysSupply: string;
  route: string;
  indicationReference: string;
  indicationText: string;
  pharmacy: string;
  transmissionMethod: "printed" | "phoned-in";
}

interface EditorProps {
  draft: PrescriptionDraft;
  conditions: Condition[];
  controlledSubstanceTerms?: readonly string[];
  saving?: boolean;
  editing?: boolean;
  onChange: (draft: PrescriptionDraft) => void;
  onSave: () => void;
  onCancel?: () => void;
}

export const CONTROLLED_SUBSTANCE_DRUG_TERMS: readonly string[] = [];

export const EMPTY_PRESCRIPTION_DRAFT: PrescriptionDraft = {
  drug: "",
  sig: "",
  quantity: "",
  refills: "0",
  daysSupply: "",
  route: "Ophthalmic",
  indicationReference: "",
  indicationText: "",
  pharmacy: "",
  transmissionMethod: "printed",
};

export function isControlledSubstanceDrug(
  drug: string,
  terms: readonly string[] = CONTROLLED_SUBSTANCE_DRUG_TERMS,
): boolean {
  const normalizedDrug = drug.trim().toLocaleLowerCase();
  return normalizedDrug.length > 0 && terms.some((term) => {
    const normalizedTerm = term.trim().toLocaleLowerCase();
    return normalizedTerm.length > 0 && normalizedDrug.includes(normalizedTerm);
  });
}

export function withDrugText(
  draft: PrescriptionDraft,
  drug: string,
  terms: readonly string[] = CONTROLLED_SUBSTANCE_DRUG_TERMS,
): PrescriptionDraft {
  return {
    ...draft,
    drug,
    ...(isControlledSubstanceDrug(drug, terms) ? { transmissionMethod: "phoned-in" as const } : {}),
  };
}

export function PrescriptionEditor({
  draft,
  conditions,
  controlledSubstanceTerms = CONTROLLED_SUBSTANCE_DRUG_TERMS,
  saving = false,
  editing = false,
  onChange,
  onSave,
  onCancel,
}: EditorProps) {
  const controlled = isControlledSubstanceDrug(draft.drug, controlledSubstanceTerms);
  const set = (next: Partial<PrescriptionDraft>) => onChange({ ...draft, ...next });

  return (
    <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Field label="Drug">
          <input
            aria-label="Drug"
            className="sidebar-input"
            value={draft.drug}
            onChange={(event) => onChange(withDrugText(draft, event.target.value, controlledSubstanceTerms))}
            placeholder="Prednisolone acetate 1%"
          />
        </Field>
        <Field label="Sig">
          <input aria-label="Sig" className="sidebar-input" value={draft.sig} onChange={(event) => set({ sig: event.target.value })} placeholder="1 drop OU four times daily" />
        </Field>
        <Field label="Quantity">
          <input aria-label="Quantity" className="sidebar-input" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} placeholder="5 mL" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Refills">
            <input aria-label="Refills" type="number" min="0" className="sidebar-input" value={draft.refills} onChange={(event) => set({ refills: event.target.value })} />
          </Field>
          <Field label="Days supply">
            <input aria-label="Days supply" type="number" min="1" className="sidebar-input" value={draft.daysSupply} onChange={(event) => set({ daysSupply: event.target.value })} />
          </Field>
        </div>
        <Field label="Route">
          <input aria-label="Route" className="sidebar-input" value={draft.route} onChange={(event) => set({ route: event.target.value })} />
        </Field>
        <Field label="Assessment diagnosis">
          <select aria-label="Assessment diagnosis" className="sidebar-input" value={draft.indicationReference} onChange={(event) => set({ indicationReference: event.target.value })}>
            <option value="">Free-text indication</option>
            {conditions.map((condition) => (
              <option key={condition.id} value={`Condition/${condition.id}`}>{displayCode(condition.code)}</option>
            ))}
          </select>
        </Field>
        <Field label="Indication fallback">
          <input aria-label="Indication fallback" className="sidebar-input" value={draft.indicationText} onChange={(event) => set({ indicationText: event.target.value })} placeholder="Free text when no diagnosis is linked" />
        </Field>
        <Field label="Pharmacy name and phone">
          <input aria-label="Pharmacy name and phone" className="sidebar-input" value={draft.pharmacy} onChange={(event) => set({ pharmacy: event.target.value })} placeholder="Main Street Pharmacy · 555-0100" />
        </Field>
      </div>

      {controlled && (
        <div role="alert" className="mt-4 rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm font-semibold text-amber-100">
          Controlled substance — WENO e-Rx not available for this drug. Call it in to the pharmacy.
        </div>
      )}

      <fieldset className="mt-4">
        <legend className="text-xs font-semibold uppercase tracking-wide text-white/45">Transmission method</legend>
        <div className="mt-2 flex gap-5 text-sm text-white/75">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="transmission-method"
              value="printed"
              checked={draft.transmissionMethod === "printed"}
              disabled={controlled}
              onChange={() => set({ transmissionMethod: "printed" })}
            />
            Printed
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="transmission-method"
              value="phoned-in"
              checked={controlled || draft.transmissionMethod === "phoned-in"}
              onChange={() => set({ transmissionMethod: "phoned-in" })}
            />
            Phoned in
          </label>
        </div>
      </fieldset>

      <div className="mt-5 flex gap-3">
        <button type="button" className="sidebar-button" disabled={saving || !draft.drug.trim() || !draft.sig.trim()} onClick={onSave}>
          {saving ? "Saving…" : editing ? "Update prescription" : "Add prescription"}
        </button>
        {editing && onCancel && <button type="button" className="sidebar-button" onClick={onCancel}>Cancel edit</button>}
      </div>
    </div>
  );
}

export function PrescriptionSection({ patientReference, encounterReference, onSaved }: Props) {
  const [requests, setRequests] = useState<MedicationRequest[]>([]);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [practitionerReference, setPractitionerReference] = useState("");
  const [draft, setDraft] = useState<PrescriptionDraft>(EMPTY_PRESCRIPTION_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const encounterId = encounterReference.replace(/^Encounter\//, "");

  async function load() {
    setError(null);
    const [encounter, conditionBundle, requestBundle] = await Promise.all([
      fhir.read<Encounter>("Encounter", encounterId),
      fhir.search<Condition>("Condition", { encounter: encounterReference, _count: "40" }),
      fhir.search<MedicationRequest>("MedicationRequest", { encounter: encounterReference, _count: "40" }),
    ]);
    const practitioner = encounter.participant
      ?.flatMap((participant) => participant.individual?.reference ? [participant.individual.reference] : [])
      .find((reference) => reference.startsWith("Practitioner/"));
    setPractitionerReference(practitioner ?? "");
    setConditions((conditionBundle.entry ?? [])
      .flatMap((entry) => entry.resource ? [entry.resource] : [])
      .filter(isEncounterDiagnosisCondition)
      .filter((condition) => ["active", "recurrence", "relapse"].includes(clinicalStatus(condition))));
    setRequests((requestBundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
  }

  useEffect(() => {
    setLoading(true);
    void load()
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, [encounterId, encounterReference]);

  const displayedRequests = useMemo(
    () => requests
      .filter((request) => !["cancelled", "completed", "stopped", "entered-in-error"].includes(request.status))
      .sort((left, right) => (right.authoredOn ?? "").localeCompare(left.authoredOn ?? "")),
    [requests],
  );
  const activeCount = requests.filter((request) => request.status === "active").length;

  async function save() {
    if (!practitionerReference) {
      setError("This encounter has no Practitioner participant to record as prescriber.");
      return;
    }
    const controlled = isControlledSubstanceDrug(draft.drug);
    const transmissionMethod: MedicationTransmissionMethod = controlled ? "phoned-in" : draft.transmissionMethod;
    setSaving(true);
    setError(null);
    try {
      const existing = editingId ? requests.find((request) => request.id === editingId) : undefined;
      if (editingId && !existing) {
        throw new Error("The prescription being edited could not be found. Reload the chart and try again.");
      }
      const resource = buildMedicationRequest({
        patientReference,
        practitionerReference,
        encounterReference,
        medicationText: draft.drug.trim(),
        dosageText: draft.sig.trim(),
        quantity: optionalText(draft.quantity),
        refills: optionalInteger(draft.refills, "Refills", 0),
        daysSupply: optionalInteger(draft.daysSupply, "Days supply", 1),
        routeText: optionalText(draft.route),
        reasonReference: optionalText(draft.indicationReference),
        indicationText: draft.indicationReference ? undefined : optionalText(draft.indicationText),
        pharmacyText: optionalText(draft.pharmacy),
        isControlledSubstance: controlled,
        transmissionMethod,
      });
      const saved = existing
        ? await fhir.update<MedicationRequest>(mergeMedicationRequestUpdate(existing, resource), "update_medication_request")
        : await fhir.create<MedicationRequest>(resource, "create_medication_request");
      setRequests((current) => existing
        ? current.map((request) => request.id === existing.id ? saved : request)
        : [saved, ...current]);
      setEditingId(null);
      setDraft(EMPTY_PRESCRIPTION_DRAFT);
      onSaved({
        completed: true,
        summary: `${activeCount + (existing ? 0 : 1)} active Rx`,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI prescription",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function edit(request: MedicationRequest) {
    setEditingId(request.id ?? null);
    setDraft(draftFromRequest(request));
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">Plan</div>
            <h2 className="mt-1 text-lg font-semibold text-white">Prescriptions</h2>
            <p className="mt-1 text-sm text-white/45">Capture the medication order here; no live electronic transmission occurs.</p>
          </div>
          <span className="rounded border border-white/10 px-3 py-2 text-xs text-white/55">
            {activeCount} active Rx
          </span>
        </div>

        {error && <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">{error}</div>}

        <div className="mt-5 space-y-3">
          {loading ? (
            <div className="rounded border border-white/10 bg-bg-panel/60 p-4 text-sm text-white/45">Loading prescriptions…</div>
          ) : displayedRequests.length === 0 ? (
            <div className="rounded border border-white/10 bg-bg-panel/60 p-4 text-sm text-white/45">No active or pending prescriptions.</div>
          ) : displayedRequests.map((request) => (
            <div key={request.id ?? request.authoredOn} className="grid gap-3 rounded border border-white/10 bg-bg-panel/60 p-4 md:grid-cols-[1.2fr_2fr_auto_auto_auto] md:items-center">
              <div className="font-semibold text-white">{request.medicationCodeableConcept?.text ?? "Unnamed medication"}</div>
              <div className="text-sm text-white/65">{request.dosageInstruction?.[0]?.text ?? "No sig recorded"}</div>
              <div className="text-xs text-white/45">{formatDate(request.authoredOn)}</div>
              <span className="rounded border border-white/10 px-2 py-1 text-center text-xs uppercase text-white/55">{request.status}</span>
              <button type="button" className="sidebar-button" onClick={() => edit(request)}>Edit</button>
            </div>
          ))}
        </div>

        <div className="mt-5">
          <PrescriptionEditor
            draft={draft}
            conditions={conditions}
            saving={saving}
            editing={editingId !== null}
            onChange={setDraft}
            onSave={save}
            onCancel={() => { setEditingId(null); setDraft(EMPTY_PRESCRIPTION_DRAFT); }}
          />
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-semibold uppercase tracking-wide text-white/45">{label}<span className="mt-1 block">{children}</span></label>;
}

function optionalText(value: string): string | undefined {
  return value.trim() || undefined;
}

function optionalInteger(value: string, label: string, minimum: number): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be a whole number of at least ${minimum}.`);
  }
  return parsed;
}

function transmissionMethod(request: MedicationRequest): "printed" | "phoned-in" {
  const value = request.extension
    ?.find((extension) => extension.url === ODOS_TRANSMISSION_METHOD_EXTENSION_URL)
    ?.valueCode;
  return value === "phoned-in" ? "phoned-in" : "printed";
}

function draftFromRequest(request: MedicationRequest): PrescriptionDraft {
  return {
    drug: request.medicationCodeableConcept?.text ?? "",
    sig: request.dosageInstruction?.[0]?.text ?? "",
    quantity: request.dispenseRequest?.quantity?.unit ?? "",
    refills: request.dispenseRequest?.numberOfRepeatsAllowed?.toString() ?? "0",
    daysSupply: request.dispenseRequest?.expectedSupplyDuration?.value?.toString() ?? "",
    route: request.dosageInstruction?.[0]?.route?.text ?? "Ophthalmic",
    indicationReference: request.reasonReference?.[0]?.reference ?? "",
    indicationText: request.reasonCode?.[0]?.text ?? "",
    pharmacy: request.dispenseRequest?.performer?.display ?? "",
    transmissionMethod: transmissionMethod(request),
  };
}

export function mergeMedicationRequestUpdate(
  existing: MedicationRequest,
  resource: MedicationRequest,
): MedicationRequest {
  return {
    ...existing,
    ...resource,
    id: existing.id,
    meta: existing.meta,
    status: existing.status,
    requester: existing.requester,
  };
}

export function formatDate(value: string | undefined): string {
  if (!value) return "Date unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
