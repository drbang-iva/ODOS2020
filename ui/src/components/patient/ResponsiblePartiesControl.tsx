import { PhoneFields } from "./PhoneFields";
import { applyPhoneDraft, phoneDraft, telecomSnapshot, validatePatientPhones } from "../../../../mcp/src/clinic/patient-telecom";
import { projectResponsiblePartyDemographics, type ResponsiblePartyDemographics } from "../../../../mcp/src/clinic/responsible-party-demographics";
import { useEffect, useState } from "react";
import type { Person } from "@medplum/fhirtypes";
import {
  listPatientResponsibleParties, loadGuarantor, saveGuarantor, repairGuarantor,
  type GuarantorLoad,
} from "../../lib/guarantor-editor";
import { completeGuarantorLinkOperation, correctGuarantorLinkOperation } from "../../lib/guarantor-link-operations";

import { GuarantorLinkScreens } from "./GuarantorLinkScreens";

const writeStatusMessages = { stopped: "not updated — the guarantor changed or a link operation is pending", updated: "update accepted", conflict: "record changed while you were editing", error: "update failed", "no-response": "update response not received" };

type Demographics = ResponsiblePartyDemographics & Pick<Person, "birthDate">;
const demographics = (person: Person): Demographics => ({ ...projectResponsiblePartyDemographics(person), birthDate: person.birthDate });
const displayName = (person: Demographics) => person.name?.[0]?.text || [...(person.name?.[0]?.given ?? []), person.name?.[0]?.family].filter(Boolean).join(" ") || "Unnamed responsible party";

export function ResponsiblePartiesControl({ patientId }: { patientId: string }) {
  const [parties, setParties] = useState<GuarantorLoad[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setParties(undefined);
    setError(undefined);
    void listPatientResponsibleParties(patientId).then(value => { if (active) setParties(value); }).catch(() => {
      if (active) setError("Responsible parties could not be loaded. Close and reopen to try again.");
    });
    return () => { active = false; };
  }, [patientId]);
  return <fieldset className="grid gap-4 rounded-lg border border-[var(--odos-line)] bg-[var(--odos-context-surface)] text-[color:var(--odos-text)] p-4 lg:col-span-2">
    <legend className="px-2 text-sm font-semibold text-[color:var(--odos-text)]">Responsible parties</legend>
    <p className="text-sm text-[color:var(--odos-muted)]">Save guarantor contact details separately. Changes apply to all linked patients.</p>
    {error ? <p role="status">{error}</p> : !parties ? <p role="status">Loading responsible parties…</p> : parties.length === 0 ? <p>No responsible parties recorded.</p> : parties.map((party, index) => <PartyEditor key={`${patientId}-${party.relatedPerson?.id ?? index}`} initial={party} />)}
  </fieldset>;
}

function PartyEditor({ initial }: { initial: GuarantorLoad }) {
  const [loaded, setLoaded] = useState(initial);
  const [draft, setDraft] = useState<Demographics>(() => initial.kind === "editable" ? demographics(initial.snapshot.person) : {});
  const [result, setResult] = useState(initial.kind === "editable" ? initial.verification : undefined);
  const initialPhoneState = () => { const person: Person = initial.kind === "editable" ? initial.snapshot.person : { resourceType: "Person" }; const now = new Date().toISOString(); return { draft: phoneDraft(person, now), snapshot: telecomSnapshot(person, now) }; };
  const [phoneState, setPhoneState] = useState(initialPhoneState);
  const resetPhones = (person: Person) => { const now = new Date().toISOString(); setPhoneState({ draft: phoneDraft(person, now), snapshot: telecomSnapshot(person, now) }); };
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [correctionReason, setCorrectionReason] = useState("");
  const editable = loaded.kind === "editable";
  const dirty = editable && (JSON.stringify(draft) !== JSON.stringify(demographics(loaded.snapshot.person)) || JSON.stringify(phoneState.draft) !== JSON.stringify(phoneDraft(loaded.snapshot.person, phoneState.snapshot.now)));
  const refresh = async () => {
    const next = await loadGuarantor(loaded.relatedPerson.id!);
    const loadedTaskId = loaded.kind === "pending" ? loaded.operation.task.id : undefined;
    const nextTaskId = next.kind === "pending" ? next.operation.task.id : undefined;
    if (loadedTaskId !== nextTaskId) setCorrectionReason("");
    setLoaded(next);
    resetPhones(next.kind === "editable" ? next.snapshot.person : { resourceType: "Person" });
    setDraft(next.kind === "editable" ? demographics(next.snapshot.person) : {});
    setResult(next.kind === "editable" ? next.verification : undefined);
  };
  const save = async (repair = false) => {
    if (loaded.kind !== "editable" || busy || (repair && dirty)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const next = repair ? await repairGuarantor(loaded.snapshot) : await saveGuarantor(loaded.snapshot, applyPhoneDraft({ ...draft, resourceType: "Person" }, phoneState.draft, phoneState.snapshot));
      setResult(next);
      setNotice(next.message);
      if (next.status === "superseded") {
        setNotice("A newer edit or guarantor link operation landed while yours was being applied. Showing the current record.");
        await refresh();
      } else if (next.snapshot) {
        setLoaded({ ...loaded, snapshot: next.snapshot });
        if (repair || next.status === "saved" || next.status === "unchanged" || next.status === "partial") {
          setDraft(demographics(next.snapshot.person));
          resetPhones(next.snapshot.person);
        }
      }
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The result could not be determined. Reload before continuing.");
    } finally { setBusy(false); }
  };
  const reload = async () => {
    if (!loaded.relatedPerson?.id || busy) return;
    setBusy(true);
    try {
      await refresh();
      setNotice(undefined);
    } catch { setNotice("Could not reload this responsible party. Try again."); }
    finally { setBusy(false); }
  };
  const recover = async (correct = false) => {
    if (loaded.kind !== "pending" || busy || (correct && (loaded.operation.kind === "correct" || !correctionReason.trim()))) return;
    setBusy(true);
    setNotice(undefined);
    try {
      if (correct) await correctGuarantorLinkOperation(loaded.operation.task.id!, correctionReason.trim());
      else await completeGuarantorLinkOperation(loaded.operation.task.id!);
      setCorrectionReason("");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The operation result could not be determined.");
    } finally {
      try { await refresh(); }
      catch { setNotice("Could not reload this responsible party. Reload before continuing."); }
      setBusy(false);
    }
  };
  if (!editable) {
    const displayedMessage = loaded.kind === "missing" && loaded.message === "No linked guarantor record — pre-migration." ? "No linked guarantor record." : loaded.message;
    return <section className="grid gap-2 rounded border border-[var(--odos-line)] p-3">
    <h3 className="font-semibold">{displayName(loaded.relatedPerson ?? {})}</h3>
    <p>{loaded.relatedPerson.telecom?.map(contact => `${contact.system ?? "Contact"}: ${contact.value ?? "Not recorded"}`).join(" · ") || "No contact details recorded."}</p>
    <p>{loaded.relatedPerson.address?.map(address => address.text || [...address.line ?? [], address.city, address.state, address.postalCode, address.country].filter(Boolean).join(", ")).join(" · ") || "No address recorded."}</p>
    <p role="status">{displayedMessage}</p>
    {notice && <p role="status">{notice}</p>}
    {loaded.personIds?.length ? <p>Guarantor records: {loaded.personIds.join(", ")}</p> : null}
    <button type="button" disabled onClick={() => save()}>Save guarantor</button>
    {loaded.kind === "missing" && <GuarantorLinkScreens relatedPersonId={loaded.relatedPerson.id!} disabled={busy} onReload={refresh} attachOnly />}
    {loaded.kind === "pending" && <>
      <ul aria-label="Patients affected by this operation">{loaded.operation.patients.map(patient => <li key={patient.relatedPersonId}>{patient.name || patient.patientId}</li>)}</ul>
      <button type="button" disabled onClick={() => save(true)}>Repair guarantor</button>
      <button type="button" disabled={busy} onClick={() => recover()}>Complete</button>
      {loaded.operation.kind === "correct" ? <p>A correction cannot itself be corrected. Complete this operation before starting a new transfer.</p> : <fieldset disabled={busy}><Field label="Reason for correction" value={correctionReason} change={setCorrectionReason} /></fieldset>}
      <button type="button" disabled={busy || loaded.operation.kind === "correct" || !correctionReason.trim()} onClick={() => recover(true)}>Correct</button>
    </>}
    <button type="button" disabled={busy} onClick={() => void reload()}>Reload guarantor</button>
    </section>;
  }
  const names = draft.name?.length ? draft.name : [{}];
  const addresses = draft.address?.length ? draft.address : [{}];
  const mismatched = result?.children.filter(child => child.classification === "mismatched") ?? [];
  return <section className="grid gap-3 rounded border border-[var(--odos-line)] p-3" aria-label={displayName(loaded.snapshot.person)}>
    <h3 className="font-semibold">{displayName(loaded.snapshot.person)}</h3>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
      <Field type="date" label="Guarantor date of birth" value={draft.birthDate ?? ""} change={value => setDraft({ ...draft, birthDate: value || undefined })} />
      {names.map((name, index) => <div className="grid gap-2" key={`name-${index}`}>
        <Field label={`Given names ${index + 1}`} value={name.given?.join(" ") ?? ""} change={value => setDraft({ ...draft, name: names.map((entry, i) => i === index ? { ...entry, given: value ? value.split(" ") : undefined } : entry) })} />
        <Field label={`Family name ${index + 1}`} value={name.family ?? ""} change={value => setDraft({ ...draft, name: names.map((entry, i) => i === index ? { ...entry, family: value || undefined } : entry) })} />
        {name.text !== undefined && <Field label={`Display name ${index + 1}`} value={name.text} change={value => setDraft({ ...draft, name: names.map((entry, i) => i === index ? { ...entry, text: value || undefined } : entry) })} />}
      </div>)}
      <div className="grid gap-3 sm:col-span-2"><PhoneFields draft={phoneState.draft} errors={validatePatientPhones(phoneState.draft.phones, phoneState.draft.textable)} onChange={draft => setPhoneState({ ...phoneState, draft })} /></div>
      {addresses.map((address, index) => <div key={`address-${index}`} className="grid gap-2">
        {(address.line?.length ? address.line : [""]).map((line, lineIndex) => <Field key={lineIndex} label={`Address ${index + 1} line ${lineIndex + 1}`} value={line} change={value => setDraft({ ...draft, address: addresses.map((entry, i) => i === index ? { ...entry, text: undefined, line: (entry.line?.length ? entry.line : [""]).map((old, j) => j === lineIndex ? value : old) } : entry) })} />)}
        {(["city", "state", "postalCode", "country"] as const).map(key => <Field key={key} label={`${key === "postalCode" ? "Postal code" : key[0].toUpperCase() + key.slice(1)} ${index + 1}`} value={address[key] ?? ""} change={value => setDraft({ ...draft, address: addresses.map((entry, i) => i === index ? { ...entry, text: undefined, [key]: value || undefined } : entry) })} />)}
      </div>)}
    </fieldset>
    {notice && <p role="status">{notice}</p>}
    {result?.generation && <p className="text-xs text-[color:var(--odos-muted)]">Checked against guarantor generation {result.generation}.</p>}
    {result && <ul>{result.children.map(child => <li key={child.relatedPersonId}>{child.patientName} — {child.classification}{child.writeStatus ? `: ${writeStatusMessages[child.writeStatus]}` : ""}</li>)}</ul>}
    {mismatched.length > 0 && dirty && <p className="text-sm text-[color:var(--odos-muted)]">Save your changes or reload the guarantor before repairing linked records.</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="rounded bg-[color:var(--odos-accent)] text-[color:var(--odos-accent-ink)] px-3 py-2 disabled:opacity-50" disabled={busy || !dirty} onClick={() => save()}>{busy ? "Working…" : "Save guarantor"}</button>
      {mismatched.length > 0 && <button type="button" disabled={busy || dirty} onClick={() => save(true)}>Repair for {mismatched.map(child => child.patientName).join(", ")}</button>}
      <button type="button" disabled={busy} onClick={() => void reload()}>Reload guarantor</button>
    </div>
    <GuarantorLinkScreens key={loaded.snapshot.person.id} person={loaded.snapshot.person} relatedPersonId={loaded.relatedPerson.id!} disabled={busy || dirty} onReload={refresh} />
  </section>;
}

function Field({ label, value, change, type = "text" }: { label: string; value: string; change: (value: string) => void; type?: string }) {
  return <label className="grid gap-1 text-sm text-[color:var(--odos-muted)]">{label}<input type={type} className="scheduler-input" value={value} onChange={event => change(event.target.value)} /></label>;
}
