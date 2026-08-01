import { useEffect, useMemo, useState } from "react";
import type { Coding, Condition, Encounter, MedicationRequest, Patient } from "@medplum/fhirtypes";
import { clinicalStatus, displayCode, isEncounterDiagnosisCondition } from "../../lib/clinical-view-model";
import {
  fhir,
  type WenoDrugSearchResult,
} from "../../lib/fhir";
import {
  buildMedicationRequest,
  NCPDP_PROVIDER_IDENTIFIER_SYSTEM,
  ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL,
  ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL,
  RXNORM_CODE_SYSTEM,
  WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
  isStructuredPharmacy,
  pharmacyDisplay,
  pharmacyFromResource,
  withPreferredPharmacy,
  type MedicationOrderPharmacy,
  type MedicationTransmissionMethod,
  type PreferredPharmacy,
} from "../../lib/fhir-medication-order";
import { clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { numericOptions } from "./power-options";
import { PowerDropdown } from "./PowerDropdown";
import type { SectionSaveStatus } from "./types";
import { OdosSearchPicker } from "../inputs/OdosSearchPicker";
import { OdosSelect } from "../inputs/OdosSelect";
import {
  PharmacyDirectoryPicker,
  pharmacyFromDirectoryResult,
  type DirectoryResult,
  type PharmacyDirectorySearchApi,
} from "../pharmacy/PharmacyDirectoryPicker";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

export interface PrescriptionDraft {
  drug: string;
  drugDbCode?: string;
  drugDbCodeQualifier?: string;
  quantityUnitOfMeasureCode?: string;
  sig: string;
  quantity: string;
  refills: string;
  daysSupply: string;
  route: string;
  indicationReference: string;
  indicationText: string;
  pharmacy: string;
  pharmacyNcpdpId?: string;
  pharmacyDetails?: MedicationOrderPharmacy;
  transmissionMethod: "printed" | "phoned-in";
}

export type FormularyResult = WenoDrugSearchResult;
export type { DirectoryResult } from "../pharmacy/PharmacyDirectoryPicker";

export interface WenoSearchApi extends PharmacyDirectorySearchApi {
  searchFormulary(query: string, signal?: AbortSignal): Promise<FormularyResult[]>;
}

interface EditorProps {
  draft: PrescriptionDraft;
  conditions: Condition[];
  controlledSubstanceTerms?: readonly string[];
  saving?: boolean;
  editing?: boolean;
  searchApi?: WenoSearchApi;
  formularyDebounceMs?: number;
  onChange: (draft: PrescriptionDraft) => void;
  onSave: () => void;
  onCancel?: () => void;
}
type FormularySelection =
  | { kind: "coded"; result: FormularyResult }
  | { kind: "free-text"; text: string };

export const CONTROLLED_SUBSTANCE_DRUG_TERMS: readonly string[] = [];
const WENO_OUTCOME_UNKNOWN_NOTE_PREFIX = "WENO Switch outcome unknown";
const REFILL_OPTIONS = numericOptions(undefined, 0, 11, 1);
const DAYS_SUPPLY_OPTIONS = numericOptions(undefined, 1, 365, 1);
const ROUTE_OPTIONS = ["Ophthalmic", "Oral", "Topical", "Otic", "Nasal", "Other"];

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
    drugDbCode: undefined,
    drugDbCodeQualifier: undefined,
    quantityUnitOfMeasureCode: undefined,
    ...(isControlledSubstanceDrug(drug, terms) ? { transmissionMethod: "phoned-in" as const } : {}),
  };
}

export function withFormularyResult(
  draft: PrescriptionDraft,
  result: FormularyResult,
): PrescriptionDraft {
  return {
    ...draft,
    drug: result.psnDescription,
    drugDbCode: result.drugDbCode,
    drugDbCodeQualifier: result.drugDbCodeQualifier,
    quantityUnitOfMeasureCode: result.quantityUnitOfMeasureCode,
    route: result.route || draft.route,
  };
}

export function withDirectoryResult(
  draft: PrescriptionDraft,
  result: DirectoryResult,
): PrescriptionDraft {
  const pharmacyDetails = pharmacyFromDirectoryResult(result);
  return {
    ...draft,
    pharmacy: pharmacyDisplay(pharmacyDetails),
    pharmacyNcpdpId: result.ncpdpId || undefined,
    pharmacyDetails,
  };
}

export function PrescriptionEditor({
  draft,
  conditions,
  controlledSubstanceTerms = CONTROLLED_SUBSTANCE_DRUG_TERMS,
  saving = false,
  editing = false,
  searchApi = DEFAULT_WENO_SEARCH_API,
  formularyDebounceMs = 280,
  onChange,
  onSave,
  onCancel,
}: EditorProps) {
  const controlled = isControlledSubstanceDrug(draft.drug, controlledSubstanceTerms);
  const set = (next: Partial<PrescriptionDraft>) => onChange({ ...draft, ...next });
  const searchFormularyOptions = useMemo(() => async (query: string, signal: AbortSignal) =>
    (await searchApi.searchFormulary(query, signal)).map((result) => ({
      value: `${result.drugDbCode}:${result.drugDbCodeQualifier}`,
      label: result.psnDescription,
      description: formularyDetails(result),
      item: { kind: "coded", result } satisfies FormularySelection,
    })), [searchApi]);

  return (
    <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div>
          <OdosSearchPicker<FormularySelection>
            label="Formulary"
            value={draft.drug ? draft.drugDbCode ?? `free:${draft.drug}` : ""}
            selectedLabel={draft.drug}
            placeholder="Start typing a medication"
            searchDelayMs={formularyDebounceMs}
            search={searchFormularyOptions}
            createLabel="Use as written"
            onCreate={async (text) => ({
              value: `free:${text}`,
              label: text,
              item: { kind: "free-text", text } satisfies FormularySelection,
            })}
            onClear={() => onChange(withDrugText(draft, "", controlledSubstanceTerms))}
            onSelect={(option) => {
              onChange(option.item.kind === "coded"
                ? withFormularyResult(draft, option.item.result)
                : withDrugText(draft, option.item.text, controlledSubstanceTerms));
            }}
          />
          {draft.drugDbCode && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-medium normal-case tracking-normal text-emerald-200/80">
              <span className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-2 py-1">Coded — from WENO drug database</span>
              <span>RxCUI {draft.drugDbCode}</span>
            </div>
          )}
        </div>
        <Field label="Sig">
          <input aria-label="Sig" className="sidebar-input" value={draft.sig} onChange={(event) => set({ sig: event.target.value })} placeholder="1 drop OU four times daily" />
        </Field>
        <Field label="Quantity">
          <input aria-label="Quantity" className="sidebar-input" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} placeholder="5 mL" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Refills">
            <PowerDropdown value={draft.refills} options={REFILL_OPTIONS} defaultValue="0" onChange={(value) => set({ refills: value })} ariaLabel="Refills" />
          </Field>
          <Field label="Days supply">
            <PowerDropdown value={draft.daysSupply} options={DAYS_SUPPLY_OPTIONS} defaultValue="30" onChange={(value) => set({ daysSupply: value })} ariaLabel="Days supply" />
          </Field>
        </div>
        <Field label="Route">
          <OdosSelect
            ariaLabel="Route"
            value={draft.route}
            options={ROUTE_OPTIONS.map((route) => ({ value: route, label: route }))}
            onChange={(route) => set({ route })}
          />
        </Field>
        <Field label="Assessment diagnosis">
          <OdosSelect
            ariaLabel="Assessment diagnosis"
            value={draft.indicationReference}
            options={[
              { value: "", label: "Free-text indication" },
              ...conditions.map((condition) => ({
                value: `Condition/${condition.id}`,
                label: displayCode(condition.code),
              })),
            ]}
            onChange={(indicationReference) => set({ indicationReference })}
          />
        </Field>
        <Field label="Indication fallback">
          <input aria-label="Indication fallback" className="sidebar-input" value={draft.indicationText} onChange={(event) => set({ indicationText: event.target.value })} placeholder="Free text when no diagnosis is linked" />
        </Field>
        <PharmacyDirectoryPicker
          pharmacy={draft.pharmacy}
          pharmacyNcpdpId={draft.pharmacyNcpdpId}
          searchApi={searchApi}
          onChange={(selection) => set(selection)}
        />
      </div>

      {controlled && (
        <div role="alert" className="mt-4 rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm font-semibold text-amber-100">
          Controlled substance — WENO e-Rx not available for this medication. Call it in to the pharmacy.
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
  const [patient, setPatient] = useState<Patient>();
  const [preferredPharmacy, setPreferredPharmacy] = useState<PreferredPharmacy>();
  const [preferredPharmacyDraft, setPreferredPharmacyDraft] = useState<PreferredPharmacy>();
  const [preferredPharmacyDirty, setPreferredPharmacyDirty] = useState(false);
  const [practitionerReference, setPractitionerReference] = useState("");
  const [draft, setDraft] = useState<PrescriptionDraft>(EMPTY_PRESCRIPTION_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingPreferredPharmacy, setSavingPreferredPharmacy] = useState(false);
  const [sendingId, setSendingId] = useState<string>();
  const [clearingId, setClearingId] = useState<string>();
  const [sendFeedback, setSendFeedback] = useState<Record<string, {
    kind: "status" | "error" | "unknown";
    text: string;
  }>>({});
  const [switchConfiguration, setSwitchConfiguration] = useState({
    configured: false,
    reason: "Checking WENO Switch configuration…",
  });
  const [error, setError] = useState<string | null>(null);
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const patientId = patientReference.replace(/^Patient\//, "");

  async function load() {
    setError(null);
    const [encounter, conditionBundle, requestBundle, loadedPatient, configuration] = await Promise.all([
      fhir.read<Encounter>("Encounter", encounterId),
      fhir.search<Condition>("Condition", { encounter: encounterReference, _count: "40" }),
      fhir.search<MedicationRequest>("MedicationRequest", { encounter: encounterReference, _count: "40" }),
      fhir.read<Patient>("Patient", patientId),
      fhir.readWenoSwitchConfiguration(clinicalGraphApiBase()).catch(() => ({
        configured: false,
        reason: "WENO Switch configuration could not be confirmed. Sending is disabled.",
      })),
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
    const loadedPreferredPharmacy = pharmacyFromResource(loadedPatient);
    setPatient(loadedPatient);
    setPreferredPharmacy(loadedPreferredPharmacy);
    setPreferredPharmacyDraft(loadedPreferredPharmacy);
    setPreferredPharmacyDirty(false);
    setSwitchConfiguration(configuration);
    setDraft((current) => draftWithPreferredPharmacy(current, loadedPreferredPharmacy));
  }

  useEffect(() => {
    setLoading(true);
    void load()
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, [encounterId, encounterReference, patientId]);

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
        drugDbCode: draft.drugDbCode,
        drugDbCodeQualifier: draft.drugDbCodeQualifier,
        quantityUnitOfMeasureCode: draft.quantityUnitOfMeasureCode,
        dosageText: draft.sig.trim(),
        quantity: optionalText(draft.quantity),
        refills: optionalInteger(draft.refills, "Refills", 0),
        daysSupply: optionalInteger(draft.daysSupply, "Days supply", 1),
        routeText: optionalText(draft.route),
        reasonReference: optionalText(draft.indicationReference),
        indicationText: draft.indicationReference ? undefined : optionalText(draft.indicationText),
        pharmacyText: optionalText(draft.pharmacy),
        pharmacyNcpdpId: draft.pharmacyNcpdpId,
        pharmacy: draft.pharmacyDetails,
        isControlledSubstance: controlled,
        transmissionMethod,
      });
      const saved = existing
        ? await fhir.update<MedicationRequest>(
            mergeMedicationRequestUpdate(existing, resource),
            "update_medication_request",
            existing.meta?.versionId,
          )
        : await fhir.create<MedicationRequest>(resource, "create_medication_request");
      setRequests((current) => existing
        ? current.map((request) => request.id === existing.id ? saved : request)
        : [saved, ...current]);
      setEditingId(null);
      setDraft(draftWithPreferredPharmacy(EMPTY_PRESCRIPTION_DRAFT, preferredPharmacy));
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

  async function persistPreferredPharmacy(next: PreferredPharmacy | undefined) {
    if (!patient) {
      setError("The Patient record is not loaded.");
      return;
    }
    setSavingPreferredPharmacy(true);
    setError(null);
    try {
      const saved = await fhir.update<Patient>(
        withPreferredPharmacy(patient, next),
        "update_preferred_pharmacy",
        patient.meta?.versionId,
      );
      setPatient(saved);
      setPreferredPharmacy(next);
      setPreferredPharmacyDraft(next);
      setPreferredPharmacyDirty(false);
      if (editingId === null) {
        setDraft((current) => replacePreferredPharmacyDefault(
          current,
          preferredPharmacy,
          next,
        ));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingPreferredPharmacy(false);
    }
  }

  async function sendPrescription(request: MedicationRequest) {
    if (!request.id) {
      setError("This prescription must be saved before it can be sent.");
      return;
    }
    setSendingId(request.id);
    setSendFeedback((current) => {
      const next = { ...current };
      delete next[request.id!];
      return next;
    });
    try {
      const response = await fhir.sendWenoPrescription(clinicalGraphApiBase(), request.id);
      setRequests((current) => current.map((candidate) =>
        candidate.id === request.id ? response.medicationRequest : candidate));
      setSendFeedback((current) => ({
        ...current,
        [request.id!]: response.result.kind === "status"
          ? {
              kind: "status",
              text: `WENO Status ${response.result.code}: ${response.result.description}`,
            }
          : response.result.kind === "error"
            ? {
                kind: "error",
                text: `WENO Error ${response.result.code}/${response.result.descriptionCode}: ${response.result.description}`,
              }
            : {
                kind: "unknown",
                text: "WENO did not return a determinate delivery outcome.",
              },
      }));
    } catch (caught) {
      setSendFeedback((current) => ({
        ...current,
        [request.id!]: {
          kind: "error",
          text: caught instanceof Error ? caught.message : String(caught),
        },
      }));
    } finally {
      setSendingId(undefined);
    }
  }

  async function clearIndeterminateSend(request: MedicationRequest) {
    if (!request.id) {
      setError("This prescription must be saved before its WENO reservation can be cleared.");
      return;
    }
    setClearingId(request.id);
    try {
      const response = await fhir.clearWenoIndeterminateSend(
        clinicalGraphApiBase(),
        request.id,
      );
      setRequests((current) => current.map((candidate) =>
        candidate.id === request.id ? response.medicationRequest : candidate));
      setSendFeedback((current) => ({
        ...current,
        [request.id!]: {
          kind: "status",
          text: "WENO send reservation cleared after staff verification. This prescription can be sent again.",
        },
      }));
    } catch (caught) {
      setSendFeedback((current) => ({
        ...current,
        [request.id!]: {
          kind: "error",
          text: caught instanceof Error ? caught.message : String(caught),
        },
      }));
    } finally {
      setClearingId(undefined);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">Plan</div>
            <h2 className="mt-1 text-lg font-semibold text-white">Prescriptions</h2>
            <p className="mt-1 text-sm text-white/45">Compose and save the medication order, then deliberately send eligible prescriptions through WENO Switch.</p>
          </div>
          <span className="rounded border border-white/10 px-3 py-2 text-xs text-white/55">
            {activeCount} active Rx
          </span>
        </div>

        {error && <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">{error}</div>}
        {!switchConfiguration.configured && (
          <div className="mt-4 rounded border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
            {switchConfiguration.reason}
          </div>
        )}

        <div className="mt-5 rounded border border-white/10 bg-bg-panel/60 p-4">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-white">Preferred pharmacy</h3>
            <p className="mt-1 text-xs text-white/45">Used as the default for new prescriptions. Each prescription can still use a different pharmacy.</p>
          </div>
          <PharmacyDirectoryPicker
            label="Preferred pharmacy ZIP or city"
            stateLabel="Preferred pharmacy state"
            pharmacy={preferredPharmacyDraft ? pharmacyDisplay(preferredPharmacyDraft) : ""}
            pharmacyNcpdpId={preferredPharmacyDraft && isStructuredPharmacy(preferredPharmacyDraft)
              ? preferredPharmacyDraft.ncpdpId
              : undefined}
            allowFreeText={false}
            onChange={(selection) => {
              setPreferredPharmacyDraft(selection.pharmacyDetails);
              setPreferredPharmacyDirty(true);
            }}
          />
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              className="sidebar-button"
              disabled={savingPreferredPharmacy || !preferredPharmacyDirty}
              onClick={() => void persistPreferredPharmacy(preferredPharmacyDraft)}
            >
              {savingPreferredPharmacy ? "Saving…" : "Save preferred pharmacy"}
            </button>
            {preferredPharmacy && (
              <button
                type="button"
                className="sidebar-button"
                disabled={savingPreferredPharmacy}
                onClick={() => void persistPreferredPharmacy(undefined)}
              >
                Clear preferred pharmacy
              </button>
            )}
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {loading ? (
            <div className="rounded border border-white/10 bg-bg-panel/60 p-4 text-sm text-white/45">Loading prescriptions…</div>
          ) : displayedRequests.length === 0 ? (
            <div className="rounded border border-white/10 bg-bg-panel/60 p-4 text-sm text-white/45">No active or pending prescriptions.</div>
          ) : displayedRequests.map((request) => {
            const feedback = request.id ? sendFeedback[request.id] : undefined;
            const sent = isElectronicallySent(request);
            const reserved = hasWenoMessageId(request);
            const outcomeUnknown = wenoOutcomeUnknown(request);
            const sending = request.id !== undefined && sendingId === request.id;
            const clearing = request.id !== undefined && clearingId === request.id;
            const sendDisabled = !request.id || sending || sent || reserved || !switchConfiguration.configured;
            return (
              <div key={request.id ?? request.authoredOn} className="rounded border border-white/10 bg-bg-panel/60 p-4">
                <div className="grid gap-3 md:grid-cols-[1.2fr_2fr_auto_auto_auto_auto] md:items-center">
                  <div className="font-semibold text-white">{request.medicationCodeableConcept?.text ?? "Unnamed medication"}</div>
                  <div className="text-sm text-white/65">{request.dosageInstruction?.[0]?.text ?? "No sig recorded"}</div>
                  <div className="text-xs text-white/45">{formatDate(request.authoredOn)}</div>
                  <span className="rounded border border-white/10 px-2 py-1 text-center text-xs uppercase text-white/55">{request.status}</span>
                  <button
                    type="button"
                    className="sidebar-button"
                    disabled={sent || reserved}
                    title={sent || reserved ? "A prescription with a WENO message id cannot be edited." : undefined}
                    onClick={() => edit(request)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="sidebar-button"
                    disabled={sendDisabled}
                    title={!switchConfiguration.configured
                      ? switchConfiguration.reason
                      : reserved && !sent
                        ? "This prescription already has a WENO message id and requires review before another send."
                        : undefined}
                    onClick={() => void sendPrescription(request)}
                  >
                    {sending ? "Sending…" : sent ? "Sent electronically" : "Send to pharmacy"}
                  </button>
                </div>
                {feedback && (
                  <div className={`mt-3 text-sm ${
                    feedback.kind === "status"
                      ? "text-emerald-200"
                      : feedback.kind === "unknown"
                        ? "text-amber-100"
                        : "text-red-200"
                  }`}>
                    {feedback.text}
                  </div>
                )}
                {outcomeUnknown && (
                  <div className="mt-3 rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100">
                    <div className="font-semibold">Delivery outcome unknown</div>
                    <p className="mt-1">
                      WENO did not confirm whether the pharmacy received this prescription. Verify with the pharmacy before resending.
                    </p>
                    <p className="mt-1 text-xs text-amber-100/70">{outcomeUnknown.reason}</p>
                    <button
                      type="button"
                      className="sidebar-button mt-3"
                      disabled={clearing}
                      onClick={() => void clearIndeterminateSend(request)}
                    >
                      {clearing
                        ? "Clearing…"
                        : "Pharmacy verified not received — clear reservation"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-5">
          <PrescriptionEditor
            draft={draft}
            conditions={conditions}
            saving={saving}
            editing={editingId !== null}
            onChange={setDraft}
            onSave={save}
            onCancel={() => {
              setEditingId(null);
              setDraft(draftWithPreferredPharmacy(EMPTY_PRESCRIPTION_DRAFT, preferredPharmacy));
            }}
          />
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block text-xs font-semibold uppercase tracking-wide text-white/45">
      <div>{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
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

const DEFAULT_WENO_SEARCH_API: WenoSearchApi = {
  searchFormulary(query, signal) {
    return fhir.searchWenoFormulary(clinicalGraphApiBase(), query, signal);
  },
  searchDirectory(input, signal) {
    return fhir.searchWenoDirectory(clinicalGraphApiBase(), input, signal);
  },
};

function formularyDetails(result: FormularyResult): string {
  return [result.route, result.strength].filter(Boolean).join(" · ") || "Route and strength not supplied";
}

function transmissionMethod(request: MedicationRequest): "printed" | "phoned-in" {
  const value = request.extension
    ?.find((extension) => extension.url === ODOS_TRANSMISSION_METHOD_EXTENSION_URL)
    ?.valueCode;
  return value === "phoned-in" ? "phoned-in" : "printed";
}

export function draftFromRequest(request: MedicationRequest): PrescriptionDraft {
  const codedDrug = request.medicationCodeableConcept?.coding
    ?.filter((entry) => entry.system === RXNORM_CODE_SYSTEM)
    .map(completeWenoDrugCoding)
    .find((entry) => entry.drugDbCode) ?? {};
  const storedPharmacy = pharmacyFromResource(request);
  const pharmacyDetails = storedPharmacy && isStructuredPharmacy(storedPharmacy)
    ? storedPharmacy
    : undefined;
  return {
    drug: request.medicationCodeableConcept?.text ?? "",
    ...codedDrug,
    sig: request.dosageInstruction?.[0]?.text ?? "",
    quantity: request.dispenseRequest?.quantity?.unit ?? "",
    refills: request.dispenseRequest?.numberOfRepeatsAllowed?.toString() ?? "0",
    daysSupply: request.dispenseRequest?.expectedSupplyDuration?.value?.toString() ?? "",
    route: request.dosageInstruction?.[0]?.route?.text ?? "Ophthalmic",
    indicationReference: request.reasonReference?.[0]?.reference ?? "",
    indicationText: request.reasonCode?.[0]?.text ?? "",
    pharmacy: request.dispenseRequest?.performer?.display
      ?? (pharmacyDetails ? pharmacyDisplay(pharmacyDetails) : ""),
    pharmacyNcpdpId: request.dispenseRequest?.performer?.identifier?.system === NCPDP_PROVIDER_IDENTIFIER_SYSTEM
      ? request.dispenseRequest.performer.identifier.value
      : undefined,
    pharmacyDetails,
    transmissionMethod: transmissionMethod(request),
  };
}

export function draftWithPreferredPharmacy(
  draft: PrescriptionDraft,
  preferredPharmacy: PreferredPharmacy | undefined,
): PrescriptionDraft {
  if (!preferredPharmacy || draft.pharmacy) return draft;
  return {
    ...draft,
    pharmacy: pharmacyDisplay(preferredPharmacy),
    pharmacyNcpdpId: isStructuredPharmacy(preferredPharmacy)
      ? preferredPharmacy.ncpdpId
      : undefined,
    pharmacyDetails: isStructuredPharmacy(preferredPharmacy)
      ? preferredPharmacy
      : undefined,
  };
}

function replacePreferredPharmacyDefault(
  draft: PrescriptionDraft,
  priorPreferred: PreferredPharmacy | undefined,
  nextPreferred: PreferredPharmacy | undefined,
): PrescriptionDraft {
  const usesPriorDefault = Boolean(
    priorPreferred
    && (isStructuredPharmacy(priorPreferred)
      ? draft.pharmacyDetails?.ncpdpId === priorPreferred.ncpdpId
      : draft.pharmacy === pharmacyDisplay(priorPreferred)),
  );
  if (draft.pharmacy && !usesPriorDefault) return draft;
  const withoutPharmacy = {
    ...draft,
    pharmacy: "",
    pharmacyNcpdpId: undefined,
    pharmacyDetails: undefined,
  };
  return draftWithPreferredPharmacy(withoutPharmacy, nextPreferred);
}

function isElectronicallySent(request: MedicationRequest): boolean {
  return request.extension?.some(
    (extension) =>
      extension.url === ODOS_TRANSMISSION_METHOD_EXTENSION_URL
      && extension.valueCode === "electronically-sent",
  ) ?? false;
}

function hasWenoMessageId(request: MedicationRequest): boolean {
  return request.identifier?.some(
    (identifier) =>
      identifier.system === WENO_MESSAGE_ID_IDENTIFIER_SYSTEM
      && Boolean(identifier.value?.trim()),
  ) ?? false;
}

function wenoOutcomeUnknown(
  request: MedicationRequest,
): { messageId: string; reason: string } | undefined {
  const messageId = request.identifier?.find(
    (identifier) =>
      identifier.system === WENO_MESSAGE_ID_IDENTIFIER_SYSTEM
      && Boolean(identifier.value?.trim()),
  )?.value?.trim();
  if (!messageId) return undefined;
  const prefix = `${WENO_OUTCOME_UNKNOWN_NOTE_PREFIX} ${messageId}:`;
  const notes = request.note ?? [];
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const text = notes[index]?.text;
    if (!text?.startsWith(prefix)) continue;
    return {
      messageId,
      reason: text.slice(prefix.length).trim()
        || "WENO Switch did not return a determinate response.",
    };
  }
  return undefined;
}

function completeWenoDrugCoding(
  coding: Coding | undefined,
): Pick<PrescriptionDraft, "drugDbCode" | "drugDbCodeQualifier" | "quantityUnitOfMeasureCode"> {
  const drugDbCode = coding?.code?.trim();
  const drugDbCodeQualifier = coding?.extension
    ?.find((extension) => extension.url === ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL)
    ?.valueCode?.trim();
  const quantityUnitOfMeasureCode = coding?.extension
    ?.find((extension) => extension.url === ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL)
    ?.valueCode?.trim();
  return drugDbCode && drugDbCodeQualifier && quantityUnitOfMeasureCode
    ? { drugDbCode, drugDbCodeQualifier, quantityUnitOfMeasureCode }
    : {};
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
