import { useEffect, useRef, useState } from "react";
import {
  COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS, CommunicationsResponseError,
  readCommunicationPreferences, readCommunicationPreferenceDefaults, saveCommunicationPreferences,
  type CommsPurpose, type CommsPreferenceChannel, type PatientVersion,
  type CommunicationPreferenceInput, type CommunicationPreferencesInput,
  type CommunicationPreferencesResponse, type CommunicationPreferenceDefaultsResponse,
} from "../../lib/communications-client";

export const COMMUNICATION_PURPOSE_LABELS: Record<CommsPurpose, string> = {
  recalls: "Recalls", appointment: "Appointment", "product-pickup": "Product Pick Up", "marketing-promo": "Marketing Promo", education: "Education",
};
export const COMMUNICATION_CHANNEL_LABELS: Record<CommsPreferenceChannel, string> = { sms: "Text", call: "Call", email: "Email", mail: "Mail" };
export interface CommunicationPreferencesDraft {
  baseline: CommunicationPreferencesResponse["matrix"];
  changes: CommunicationPreferenceInput[];
  confirmedVia: "in-person" | "paper-form" | null;
  formDate: string;
}
export function createCommunicationPreferencesDraft(response: CommunicationPreferenceDefaultsResponse): CommunicationPreferencesDraft {
  return {
    baseline: Object.fromEntries(COMMS_PURPOSES.map(purpose => [purpose, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(channel =>
      [channel, { value: response.defaults[purpose][channel], source: "default" }]))])) as CommunicationPreferencesResponse["matrix"],
    changes: [], confirmedVia: null, formDate: "",
  };
}
function shownValue(draft: CommunicationPreferencesDraft, purpose: CommsPurpose, channel: CommsPreferenceChannel): boolean {
  const cell = draft.baseline[purpose][channel];
  return cell.source === "suppression" ? cell.value : draft.changes.find(change => change.purpose === purpose && change.channel === channel)?.allowed ?? cell.value;
}
export function communicationPreferencesInput(draft: CommunicationPreferencesDraft): CommunicationPreferencesInput {
  if (draft.confirmedVia === "paper-form" && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.formDate)
    || !Number.isFinite(Date.parse(draft.formDate)) || new Date(draft.formDate).toISOString().slice(0, 10) !== draft.formDate
    || draft.formDate > new Date().toISOString().slice(0, 10))) throw new Error("Enter a valid form date that is not in the future.");
  return {
    cells: draft.confirmedVia ? COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel =>
      ({ purpose, channel, allowed: shownValue(draft, purpose, channel) })))
      : draft.changes.filter(change => draft.baseline[change.purpose][change.channel].source !== "suppression"),
    ...(draft.confirmedVia ? { confirmedVia: draft.confirmedVia } : {}),
    ...(draft.confirmedVia === "paper-form" ? { formDate: draft.formDate } : {}),
  };
}
interface PatientProps {
  mode: "patient";
  patientReference: string;
  canEdit: boolean;
  onPatientWritten?: (version?: PatientVersion) => void;
  onDirtyChange?: (dirty: boolean) => void;
  refreshKey?: unknown;
}
interface RegistrationProps {
  mode: "registration";
  value: CommunicationPreferencesDraft | undefined;
  onChange: (value: CommunicationPreferencesDraft) => void;
  onAvailabilityChange?: (availability: "loading" | "available" | "unavailable") => void;
  canEdit?: boolean;
}
type Props = PatientProps | RegistrationProps;
const READ_FAILURE = "Communication preferences can't be read for this patient. Ask a practice administrator.";
const PERMISSION_FAILURE = "You don't have permission to change communication preferences.";
const STOP_TOOLTIP = "Patient texted STOP — clear the opt-out above first (identity verification required).";

export function CommunicationPreferencesControl(props: Props) {
  const [response, setResponse] = useState<CommunicationPreferencesResponse>();
  const [patientDraft, setPatientDraft] = useState<CommunicationPreferencesDraft>();
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const identity = props.mode === "patient" ? props.patientReference : "registration";
  const previousIdentity = useRef(identity);
  const refreshKey = props.mode === "patient" ? props.refreshKey : undefined;
  useEffect(() => {
    const operation = ++generation.current;
    let active = true;
    const changedPatient = previousIdentity.current !== identity;
    previousIdentity.current = identity;
    setLoading(true); setSaving(false); setUnavailable(false); setMessage(undefined);
    if (changedPatient) { setResponse(undefined); setPatientDraft(undefined); setDenied(false); }
    if (props.mode === "registration") props.onAvailabilityChange?.(props.value ? "available" : "loading");
    if (props.mode === "registration" && props.value) { setLoading(false); return; }
    const read = props.mode === "patient" ? readCommunicationPreferences(props.patientReference) : readCommunicationPreferenceDefaults();
    read.then(value => {
      if (!active || generation.current !== operation) return;
      if ("matrix" in value) {
        setResponse(value);
        setPatientDraft(previous => ({ baseline: value.matrix, changes: changedPatient ? [] : previous?.changes ?? [],
          confirmedVia: changedPatient ? null : previous?.confirmedVia ?? null, formDate: changedPatient ? "" : previous?.formDate ?? "" }));
      } else {
        const current = callbacks.current;
        if (current.mode === "registration") {
          if (!current.value) current.onChange(createCommunicationPreferencesDraft(value));
          current.onAvailabilityChange?.("available");
        }
      }
    }).catch(cause => {
      if (!active || generation.current !== operation) return;
      setUnavailable(true);
      const current = callbacks.current;
      if (current.mode === "registration") {
        current.onAvailabilityChange?.("unavailable");
        setMessage("Communication preference defaults could not be loaded. You can create the patient without setting preferences; server defaults will apply.");
        return;
      }
      if (cause instanceof CommunicationsResponseError && cause.status === 403) { setDenied(true); setMessage(PERMISSION_FAILURE); }
      else setMessage(READ_FAILURE);
    }).finally(() => { if (active && generation.current === operation) setLoading(false); });
    return () => { active = false; if (generation.current === operation) generation.current++; };
  }, [identity, props.mode, refreshKey, reload]);

  const draft = props.mode === "registration" ? props.value : patientDraft;
  const dirty = Boolean(draft && (draft.changes.length || draft.confirmedVia));
  useEffect(() => {
    const current = callbacks.current;
    if (current.mode === "patient") current.onDirtyChange?.(dirty);
  }, [dirty]);
  const editable = props.canEdit !== false && !denied && !saving && !loading && !unavailable;
  function update(next: CommunicationPreferencesDraft) {
    if (props.mode === "registration") props.onChange(next);
    else setPatientDraft(next);
    setMessage(undefined);
  }
  function changeCells(cells: CommunicationPreferenceInput[]) {
    if (!draft || !editable) return;
    let changes = [...draft.changes];
    for (const cell of cells) {
      if (draft.baseline[cell.purpose][cell.channel].source === "suppression") continue;
      changes = changes.filter(existing => existing.purpose !== cell.purpose || existing.channel !== cell.channel);
      if (cell.allowed !== draft.baseline[cell.purpose][cell.channel].value) changes.push(cell);
    }
    update({ ...draft, changes });
  }
  async function save() {
    if (props.mode !== "patient" || !draft || !editable) return;
    let input: CommunicationPreferencesInput;
    try { input = communicationPreferencesInput(draft); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "Check the confirmation date."); return; }
    if (!input.cells.length) return;
    const operation = generation.current;
    setSaving(true); setMessage(undefined);
    try {
      const result = await saveCommunicationPreferences({ patientReference: props.patientReference, ...input });
      if (generation.current !== operation) return;
      setResponse(result); setPatientDraft({ baseline: result.matrix, changes: [], confirmedVia: null, formDate: "" });
      setMessage("Communication preferences saved.");
      props.onPatientWritten?.(result.patientVersion);
    } catch (cause) {
      if (generation.current !== operation) return;
      if (cause instanceof CommunicationsResponseError && cause.status === 403) { setDenied(true); setMessage(PERMISSION_FAILURE); }
      else if (cause instanceof CommunicationsResponseError && cause.status === 409) {
        setMessage("This patient's communication preferences changed elsewhere. The grid has been reloaded; review your changes before saving again.");
        try {
          const fresh = await readCommunicationPreferences(props.patientReference);
          if (generation.current !== operation) return;
          setResponse(fresh); setPatientDraft({ baseline: fresh.matrix, changes: [], confirmedVia: null, formDate: "" });
        } catch { if (generation.current === operation) { setUnavailable(true); setMessage(READ_FAILURE); } }
      } else setMessage("Communication preferences could not be saved. Please try again.");
    } finally { if (generation.current === operation) setSaving(false); }
  }
  if (unavailable) return <div><p role="status">{message}</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry preferences</button></div>;
  if (!draft) return <p role="status">Loading communication preferences…</p>;
  const latest = response?.rows.flatMap(row => row.lastSet ? [row.lastSet] : [])
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
  const disabledStyle = !editable ? { opacity: 0.65 } : undefined;
  return <section aria-label="Communication methods" className="space-y-3 text-sm" style={disabledStyle}>
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-semibold">Communication methods</h3>
      <div className="flex gap-4">
        <button type="button" disabled={!editable} className="text-[color:var(--odos-accent)] underline" onClick={() => changeCells(COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => ({ purpose, channel, allowed: true }))))}>Select all</button>
        <button type="button" disabled={!editable} className="text-[color:var(--odos-accent)] underline" onClick={() => changeCells(COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => ({ purpose, channel, allowed: false }))))}>Clear all</button>
      </div>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-center" aria-label="Communication preferences grid">
        <thead><tr><th className="border-b px-2 py-2 text-left">Purpose</th>{COMMS_PREFERENCE_CHANNELS.map(channel => <th key={channel} className="border-b px-2 py-2">
          {COMMUNICATION_CHANNEL_LABELS[channel]}{(channel === "call" || channel === "mail") && <small className="block font-normal text-[color:var(--odos-faint)]">{channel === "call" ? "no automated calls" : "no automated mail"}</small>}
        </th>)}<th className="border-b px-2 py-2 text-left">Evidence</th></tr></thead>
        <tbody>{COMMS_PURPOSES.map(purpose => {
          const evidenceRows = response?.rows.filter(row => row.purpose === purpose) ?? [];
          const electronic = evidenceRows.filter(row => row.channel === "sms" || row.channel === "email");
          const records = electronic.flatMap(row => row.evidenceSummary);
          const sms = electronic.find(row => row.channel === "sms");
          const amber = purpose === "marketing-promo" && shownValue(draft, purpose, "sms") && !sms?.evidenceSummary.length;
          const gap = electronic.some(row => row.evidenceStatus === "gap") || (!response && (shownValue(draft, purpose, "sms") || shownValue(draft, purpose, "email")));
          const evidence = records[0];
          const method = evidence?.capture?.extension?.find(part => part.url === "method")?.valueCode;
          const label = method === "paper-form" ? "Form on file" : method === "in-person" ? "Patient stated in person" : "Consent on file";
          return <tr key={purpose}>
            <th scope="row" className="border-b px-2 py-3 text-left font-medium whitespace-nowrap">{COMMUNICATION_PURPOSE_LABELS[purpose]}</th>
            {COMMS_PREFERENCE_CHANNELS.map(channel => {
              const baseline = draft.baseline[purpose][channel];
              const changed = draft.changes.some(cell => cell.purpose === purpose && cell.channel === channel);
              const source = changed && baseline.source !== "suppression" ? "explicit" : baseline.source;
              const value = shownValue(draft, purpose, channel);
              return <td key={channel} className="border-b px-2 py-3" data-source={source}>
                {source === "suppression" ? <span aria-disabled="true" title={STOP_TOOLTIP} className="rounded-full px-2 py-1 text-xs font-bold" style={{ background: "var(--odos-amber, #f5b942)", color: "#2a1d00", cursor: "not-allowed" }}>STOP</span>
                  : <label className="relative inline-flex items-center gap-1" title={source === "default" ? "Practice default — not yet confirmed with the patient" : "Set explicitly"}>
                    <input type="checkbox" aria-label={`${COMMUNICATION_PURPOSE_LABELS[purpose]} ${COMMUNICATION_CHANNEL_LABELS[channel]}`} checked={value} disabled={!editable}
                      className="peer absolute h-6 w-6 cursor-pointer opacity-0" onChange={event => changeCells([{ purpose, channel, allowed: event.target.checked }])} />
                    <span aria-hidden="true" className="inline-grid h-6 w-6 place-items-center rounded border-2 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--odos-accent)]" style={{
                      borderColor: source === "default" ? "rgba(147,197,253,.65)" : "var(--odos-accent, #3b82f6)",
                      borderStyle: source === "default" && !value ? "dashed" : "solid",
                      background: source === "default" ? "rgba(191,219,254,.10)" : value ? "var(--odos-accent, #3b82f6)" : "transparent",
                      color: source === "default" ? "var(--odos-text, #bfdbfe)" : "white",
                    }}>{value ? "✓" : ""}</span>
                    {source === "legacy-marketing-consent" && <small className="rounded border px-1 text-[color:var(--odos-faint)]">legacy</small>}
                  </label>}
              </td>;
            })}
            <td className="border-b px-2 py-3 text-left text-xs" data-evidence-tone={amber ? "amber" : "neutral"} style={{ color: amber ? "var(--odos-amber, #b7791f)" : "var(--odos-faint)" }}>
              {evidence && <span>{`✓ ${label}${evidence.dateTime ? ` · ${evidence.dateTime.slice(0, 10)}` : ""}`}{(amber || gap) ? " · " : ""}</span>}{amber || gap ? "⚠ No evidence" : !evidence ? "— No evidence needed" : null}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="text-xs text-[color:var(--odos-faint)]">Outlined = practice default, not yet confirmed with the patient · Filled = set explicitly · STOP = patient opted out by text; preferences do not override it.</p>
    <p className="text-xs text-[color:var(--odos-muted)]">{latest ? `Last set by ${latest.setBy.display ?? latest.setBy.reference ?? "staff"} via ${latest.surface === "staff-registration" ? "registration" : latest.surface === "inbound-start" ? "START reply" : latest.surface === "staff-manual-send" ? "staff send" : "staff entry"}, ${latest.recordedAt.replace("T", " ").slice(0, 16)}` : "No preferences set yet — showing practice defaults."}</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">Confirmed via
        <select className="scheduler-input" aria-label="Confirmed via" disabled={!editable} value={draft.confirmedVia ?? ""} onChange={event => update({ ...draft, confirmedVia: (event.target.value || null) as CommunicationPreferencesDraft["confirmedVia"], formDate: "" })}>
          <option value="">Not confirmed</option><option value="in-person">Patient stated in person</option><option value="paper-form">Paper form on file</option>
        </select>
      </label>
      {draft.confirmedVia === "paper-form" && <label className="flex flex-col gap-1">Form date<input className="scheduler-input" type="date" aria-label="Form date" value={draft.formDate} max={new Date().toISOString().slice(0, 10)} disabled={!editable} onChange={event => update({ ...draft, formDate: event.target.value })} /></label>}
      {props.mode === "patient" && <button type="button" disabled={!editable || !dirty} className="rounded bg-[color:var(--odos-accent)] px-3 py-2 text-[color:var(--odos-accent-ink)]" onClick={() => void save()}>{saving ? "Saving preferences…" : "Save preferences"}</button>}
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}
