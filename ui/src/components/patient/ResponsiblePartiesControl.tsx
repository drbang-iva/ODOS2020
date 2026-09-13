import { useEffect, useState } from "react";
import type { Person } from "@medplum/fhirtypes";
import {
  listPatientResponsibleParties, loadGuarantor, saveGuarantor, repairGuarantor,
  type GuarantorLoad,
} from "../../lib/guarantor-editor";

type Demographics = Pick<Person, "name" | "telecom" | "address">;
const demographics = (person: Person): Demographics => structuredClone({ name: person.name, telecom: person.telecom, address: person.address });
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
  const [editedContacts, setEditedContacts] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const editable = loaded.kind === "editable";
  const dirty = editable && JSON.stringify(draft) !== JSON.stringify(demographics(loaded.snapshot.person));
  const save = async (repair = false) => {
    if (loaded.kind !== "editable" || busy || (repair && dirty)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const next = repair ? await repairGuarantor(loaded.snapshot) : await saveGuarantor(loaded.snapshot, { ...draft, telecom: draft.telecom?.filter((contact, index) => !editedContacts.has(index) || Boolean(contact.value?.trim())) });
      setResult(next);
      setNotice(next.message);
      if (next.snapshot) {
        setLoaded({ ...loaded, snapshot: next.snapshot });
        if (repair || next.status === "saved" || next.status === "unchanged" || next.status === "partial") {
          setDraft(demographics(next.snapshot.person));
          setEditedContacts(new Set());
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
      const next = await loadGuarantor(loaded.relatedPerson.id);
      setLoaded(next);
      setEditedContacts(new Set());
      setDraft(next.kind === "editable" ? demographics(next.snapshot.person) : {});
      setResult(next.kind === "editable" ? next.verification : undefined);
      setNotice(undefined);
    } catch { setNotice("Could not reload this responsible party. Try again."); }
    finally { setBusy(false); }
  };
  if (!editable) return <section className="grid gap-2 rounded border border-[var(--odos-line)] p-3">
    <h3 className="font-semibold">{displayName(loaded.relatedPerson ?? {})}</h3>
    <p>{loaded.relatedPerson.telecom?.map(contact => `${contact.system ?? "Contact"}: ${contact.value ?? "Not recorded"}`).join(" · ") || "No contact details recorded."}</p>
    <p>{loaded.relatedPerson.address?.map(address => address.text || [...address.line ?? [], address.city, address.state, address.postalCode, address.country].filter(Boolean).join(", ")).join(" · ") || "No address recorded."}</p>
    <p role="status">{loaded.message}</p>
    {loaded.personIds?.length ? <p>Guarantor records: {loaded.personIds.join(", ")}</p> : null}
    <button type="button" disabled onClick={() => void save()}>Save guarantor</button>
    <button type="button" disabled={busy} onClick={() => void reload()}>Reload guarantor</button>
  </section>;
  const names = draft.name?.length ? draft.name : [{}];
  const telecom = draft.telecom?.length ? draft.telecom : [{ system: "phone" as const }];
  const addresses = draft.address?.length ? draft.address : [{}];
  const mismatched = result?.children.filter(child => child.classification === "mismatched") ?? [];
  return <section className="grid gap-3 rounded border border-[var(--odos-line)] p-3" aria-label={displayName(loaded.snapshot.person)}>
    <h3 className="font-semibold">{displayName(loaded.snapshot.person)}</h3>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
      {names.map((name, index) => <div className="grid gap-2" key={`name-${index}`}>
        <Field label={`Given names ${index + 1}`} value={name.given?.join(" ") ?? ""} change={value => setDraft({ ...draft, name: names.map((entry, i) => i === index ? { ...entry, given: value ? value.split(" ") : undefined } : entry) })} />
        <Field label={`Family name ${index + 1}`} value={name.family ?? ""} change={value => setDraft({ ...draft, name: names.map((entry, i) => i === index ? { ...entry, family: value || undefined } : entry) })} />
        {name.text !== undefined && <Field label={`Display name ${index + 1}`} value={name.text} change={value => setDraft({ ...draft, name: names.map((entry, i) => i === index ? { ...entry, text: value || undefined } : entry) })} />}
      </div>)}
      {telecom.map((contact, index) => <Field key={`contact-${index}`} label={`${contact.system === "phone" ? "Phone" : contact.system ?? "Contact"} ${index + 1}${contact.use ? ` (${contact.use})` : ""}`} value={contact.value ?? ""} change={value => { setEditedContacts(previous => new Set([...previous, index])); setDraft({ ...draft, telecom: telecom.map((entry, i) => i === index ? { ...entry, value } : entry) }); }} />)}
      {addresses.map((address, index) => <div key={`address-${index}`} className="grid gap-2">
        {(address.line?.length ? address.line : [""]).map((line, lineIndex) => <Field key={lineIndex} label={`Address ${index + 1} line ${lineIndex + 1}`} value={line} change={value => setDraft({ ...draft, address: addresses.map((entry, i) => i === index ? { ...entry, text: undefined, line: (entry.line?.length ? entry.line : [""]).map((old, j) => j === lineIndex ? value : old) } : entry) })} />)}
        {(["city", "state", "postalCode", "country"] as const).map(key => <Field key={key} label={`${key === "postalCode" ? "Postal code" : key[0].toUpperCase() + key.slice(1)} ${index + 1}`} value={address[key] ?? ""} change={value => setDraft({ ...draft, address: addresses.map((entry, i) => i === index ? { ...entry, text: undefined, [key]: value || undefined } : entry) })} />)}
      </div>)}
    </fieldset>
    {notice && <p role="status">{notice}</p>}
    {result?.generation && <p className="text-xs text-[color:var(--odos-muted)]">Checked against guarantor generation {result.generation}.</p>}
    {result && <ul>{result.children.map(child => <li key={child.relatedPersonId}>{child.patientName} — {child.classification}{child.writeStatus === "conflict" ? ": record changed while you were editing" : ""}</li>)}</ul>}
    {mismatched.length > 0 && dirty && <p className="text-sm text-[color:var(--odos-muted)]">Save your changes or reload the guarantor before repairing linked records.</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="rounded bg-[color:var(--odos-accent)] text-[color:var(--odos-accent-ink)] px-3 py-2 disabled:opacity-50" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Working…" : "Save guarantor"}</button>
      {mismatched.length > 0 && <button type="button" disabled={busy || dirty} onClick={() => void save(true)}>Repair for {mismatched.map(child => child.patientName).join(", ")}</button>}
      <button type="button" disabled={busy} onClick={() => void reload()}>Reload guarantor</button>
    </div>
  </section>;
}

function Field({ label, value, change }: { label: string; value: string; change: (value: string) => void }) {
  return <label className="grid gap-1 text-sm text-[color:var(--odos-muted)]">{label}<input className="scheduler-input" value={value} onChange={event => change(event.target.value)} /></label>;
}
