import { useEffect, useMemo, useRef, useState } from "react";
import type { Coding, Condition, Encounter, MedicationRequest } from "@medplum/fhirtypes";
import { clinicalStatus, displayCode, isEncounterDiagnosisCondition } from "../../lib/clinical-view-model";
import {
  fhir,
  type WenoDrugSearchResult,
  type WenoPharmacySearchResult,
} from "../../lib/fhir";
import {
  buildMedicationRequest,
  NCPDP_PROVIDER_IDENTIFIER_SYSTEM,
  ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL,
  ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL,
  RXNORM_CODE_SYSTEM,
  type MedicationTransmissionMethod,
} from "../../lib/fhir-medication-order";
import { clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";

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
  transmissionMethod: "printed" | "phoned-in";
}

export type FormularyResult = WenoDrugSearchResult;
export type DirectoryResult = WenoPharmacySearchResult;

export interface WenoSearchApi {
  searchFormulary(query: string, signal?: AbortSignal): Promise<FormularyResult[]>;
  searchDirectory(input: {
    state: string;
    place: string;
    searchType: "local-retail" | "mail-order";
  }, signal?: AbortSignal): Promise<DirectoryResult[]>;
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
  return {
    ...draft,
    pharmacy: directoryDisplay(result),
    pharmacyNcpdpId: result.ncpdpId || undefined,
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
  const [formularyResults, setFormularyResults] = useState<FormularyResult[]>([]);
  const [formularyStatus, setFormularyStatus] = useState<"idle" | "searching" | "ready" | "error">("idle");
  const [directoryPlace, setDirectoryPlace] = useState("");
  const [directoryState, setDirectoryState] = useState("");
  const [directorySearchType, setDirectorySearchType] = useState<"local-retail" | "mail-order">("local-retail");
  const [directoryResults, setDirectoryResults] = useState<DirectoryResult[]>([]);
  const [directoryStatus, setDirectoryStatus] = useState<"idle" | "searching" | "ready" | "error">("idle");
  const directoryRequest = useRef(0);
  const directoryAbort = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const query = draft.drug.trim();
    if (!query || draft.drugDbCode) {
      setFormularyResults([]);
      setFormularyStatus("idle");
      return;
    }
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => {
      setFormularyStatus("searching");
      void searchApi.searchFormulary(query, controller.signal)
        .then((results) => {
          if (!active) return;
          setFormularyResults(results);
          setFormularyStatus("ready");
        })
        .catch((caught) => {
          if (!active || (caught instanceof Error && caught.name === "AbortError")) return;
          setFormularyResults([]);
          setFormularyStatus("error");
        });
    }, formularyDebounceMs);
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [draft.drug, draft.drugDbCode, formularyDebounceMs, searchApi]);

  useEffect(() => () => {
    directoryRequest.current += 1;
    directoryAbort.current?.abort();
  }, []);

  function invalidateDirectorySearch() {
    directoryRequest.current += 1;
    directoryAbort.current?.abort();
    directoryAbort.current = undefined;
    setDirectoryResults([]);
    setDirectoryStatus("idle");
  }

  async function runDirectorySearch() {
    const place = directoryPlace.trim();
    const state = directoryState.trim();
    if (!place || !state) return;
    const request = directoryRequest.current + 1;
    directoryRequest.current = request;
    directoryAbort.current?.abort();
    const controller = new AbortController();
    directoryAbort.current = controller;
    setDirectoryStatus("searching");
    try {
      const results = await searchApi.searchDirectory({
        place,
        state,
        searchType: directorySearchType,
      }, controller.signal);
      if (directoryRequest.current !== request) return;
      setDirectoryResults(results);
      setDirectoryStatus("ready");
    } catch (caught) {
      if (directoryRequest.current !== request
        || (caught instanceof Error && caught.name === "AbortError")) return;
      setDirectoryResults([]);
      setDirectoryStatus("error");
    } finally {
      if (directoryRequest.current === request) directoryAbort.current = undefined;
    }
  }

  return (
    <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Field label="Formulary">
          <input
            aria-label="Formulary"
            className="sidebar-input"
            value={draft.drug}
            onChange={(event) => onChange(withDrugText(draft, event.target.value, controlledSubstanceTerms))}
            placeholder="Start typing a medication or enter it as written"
          />
          {draft.drugDbCode && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-medium normal-case tracking-normal text-emerald-200/80">
              <span className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-2 py-1">Coded — from WENO drug database</span>
              <span>RxCUI {draft.drugDbCode}</span>
            </div>
          )}
          {formularyStatus === "searching" && <SearchNote>Searching the Formulary…</SearchNote>}
          {formularyStatus === "error" && <SearchNote>The Formulary is unavailable. You can keep this entry as written.</SearchNote>}
          {formularyStatus === "ready" && formularyResults.length === 0 && (
            <SearchNote>No Formulary matches. You can keep this entry as written.</SearchNote>
          )}
          {formularyResults.length > 0 && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-white/10 bg-bg-panel shadow-xl">
              {formularyResults.map((result) => (
                <button
                  key={`${result.drugDbCode}:${result.drugDbCodeQualifier}`}
                  type="button"
                  className="block w-full border-b border-white/5 px-3 py-2 text-left normal-case tracking-normal last:border-b-0 hover:bg-white/5"
                  aria-label={`Choose ${result.psnDescription} from the Formulary`}
                  onClick={() => {
                    onChange(withFormularyResult(draft, result));
                    setFormularyResults([]);
                    setFormularyStatus("idle");
                  }}
                >
                  <span className="block text-sm font-semibold text-white">{result.psnDescription}</span>
                  <span className="mt-0.5 block text-xs text-white/50">{formularyDetails(result)}</span>
                </button>
              ))}
            </div>
          )}
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
        <Field label="Directory">
          <input
            aria-label="Directory entry"
            className="sidebar-input"
            value={draft.pharmacy}
            onChange={(event) => set({ pharmacy: event.target.value, pharmacyNcpdpId: undefined })}
            placeholder="Type a name or phone, or choose from the Directory"
          />
          {draft.pharmacyNcpdpId && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-medium normal-case tracking-normal text-sky-200/80">
              <span className="rounded-full border border-sky-300/25 bg-sky-300/10 px-2 py-1">Coded — from the WENO Directory</span>
              <span>NCPDP {draft.pharmacyNcpdpId}</span>
            </div>
          )}
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
            <input aria-label="Directory ZIP or city" className="sidebar-input" value={directoryPlace} onChange={(event) => { invalidateDirectorySearch(); setDirectoryPlace(event.target.value); }} placeholder="ZIP or city" />
            <input aria-label="Directory state" className="sidebar-input uppercase" maxLength={2} value={directoryState} onChange={(event) => { invalidateDirectorySearch(); setDirectoryState(event.target.value.toUpperCase()); }} placeholder="State" />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 normal-case tracking-normal">
            <div className="flex rounded border border-white/10 bg-black/10 p-1 text-xs">
              <button type="button" aria-pressed={directorySearchType === "local-retail"} className={directorySearchType === "local-retail" ? "rounded bg-white/10 px-3 py-1.5 text-white" : "px-3 py-1.5 text-white/50"} onClick={() => { invalidateDirectorySearch(); setDirectorySearchType("local-retail"); }}>Local</button>
              <button type="button" aria-pressed={directorySearchType === "mail-order"} className={directorySearchType === "mail-order" ? "rounded bg-white/10 px-3 py-1.5 text-white" : "px-3 py-1.5 text-white/50"} onClick={() => { invalidateDirectorySearch(); setDirectorySearchType("mail-order"); }}>Mail order</button>
            </div>
            <button type="button" className="sidebar-button" disabled={!directoryPlace.trim() || !directoryState.trim() || directoryStatus === "searching"} onClick={() => void runDirectorySearch()}>
              {directoryStatus === "searching" ? "Searching…" : "Search Directory"}
            </button>
          </div>
          {directoryStatus === "error" && <SearchNote>The Directory is unavailable. You can keep this entry as written.</SearchNote>}
          {directoryStatus === "ready" && directoryResults.length === 0 && <SearchNote>No Directory matches. You can keep this entry as written.</SearchNote>}
          {directoryResults.length > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded border border-white/10 bg-bg-panel shadow-xl">
              {directoryResults.map((result, index) => (
                <button
                  key={`${result.ncpdpId}:${result.businessName}:${index}`}
                  type="button"
                  className="block w-full border-b border-white/5 px-3 py-2 text-left normal-case tracking-normal last:border-b-0 hover:bg-white/5"
                  aria-label={`Choose ${result.businessName} from the Directory`}
                  onClick={() => {
                    onChange(withDirectoryResult(draft, result));
                    setDirectoryResults([]);
                    setDirectoryStatus("idle");
                  }}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-white">
                    {result.businessName}
                    {result.onWeno && <span className="rounded-full border border-sky-300/25 bg-sky-300/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sky-100">On WENO</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-white/50">{directoryAddress(result)}</span>
                </button>
              ))}
            </div>
          )}
        </Field>
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
  return (
    <div className="block text-xs font-semibold uppercase tracking-wide text-white/45">
      <div>{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function SearchNote({ children }: { children: React.ReactNode }) {
  return <div role="status" className="mt-2 text-xs font-normal normal-case tracking-normal text-white/45">{children}</div>;
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

function directoryAddress(result: DirectoryResult): string {
  return [
    [result.addressLine1, result.addressLine2].filter(Boolean).join(" "),
    [result.city, result.state, result.zip].filter(Boolean).join(" "),
  ].filter(Boolean).join(" · ");
}

function directoryDisplay(result: DirectoryResult): string {
  return [result.businessName, directoryAddress(result), result.phone].filter(Boolean).join(" · ");
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
    pharmacy: request.dispenseRequest?.performer?.display ?? "",
    pharmacyNcpdpId: request.dispenseRequest?.performer?.identifier?.system === NCPDP_PROVIDER_IDENTIFIER_SYSTEM
      ? request.dispenseRequest.performer.identifier.value
      : undefined,
    transmissionMethod: transmissionMethod(request),
  };
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
