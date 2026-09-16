import { useEffect, useState } from "react";
import { discardGuarantor, listUnusedGuarantors, type UnusedGuarantorCard } from "../../lib/guarantor-link-operations";

export function UnusedGuarantorsSettings({ canDiscard }: { canDiscard: boolean }) {
  const [rows, setRows] = useState<UnusedGuarantorCard[]>();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!canDiscard) return;
    let live = true;
    void listUnusedGuarantors().then(value => { if (live) setRows(value); }, error => { if (live) setNotice(error.message); });
    return () => { live = false; };
  }, [canDiscard]);
  if (!canDiscard) return <main><h1>Unused guarantor records</h1><p>You do not have permission to manage guarantor links.</p></main>;
  return <main className="practice-settings"><div className="practice-settings-body">
    <a href="/settings">Back to Settings</a><h1>Unused guarantor records</h1>
    <p>Discard deactivates a record; it does not delete it. Only records with no patient links or recorded guarantor operations are listed.</p>
    <p>Creation time is unavailable. Ages below are measured from the last update; a recent record may still be in use by someone registering a patient.</p>
    {notice && <p role="status">{notice}</p>}
    {!rows && !notice && <p>Loading unused records…</p>}
    {rows?.length === 0 && <p>No unused guarantor records.</p>}
    <ul>{rows?.map(row => {
      const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(row.lastUpdated)) / 60000));
      return <li key={row.personId} className="rounded border p-3 grid gap-3">
        <h2>{row.name}</h2><p>Date of birth: {row.birthDate}</p><p>{row.phones.join(" · ") || "No phone recorded"}</p><p>{row.city} {row.postalCode}</p>
        <p>Last updated: {row.lastUpdated || "unknown"}{Number.isFinite(minutes) && ` (${minutes} minutes ago)`}</p>
        {minutes < 60 && <p role="note">Caution: this record may be mid-registration.</p>}
        <label>Reason to discard {row.name}<input className="scheduler-input" value={reasons[row.personId] ?? ""} disabled={busy} onChange={event => setReasons({ ...reasons, [row.personId]: event.target.value })} /></label>
        <button type="button" disabled={busy || !reasons[row.personId]?.trim()} onClick={async () => {
          setBusy(true); setNotice("");
          try {
            await discardGuarantor(row.personId, { reason: reasons[row.personId].trim(), expectedVersion: row.versionId });
            setRows(current => current?.filter(value => value.personId !== row.personId));
            setNotice(`${row.name} was deactivated.`);
          } catch (error) { setNotice(error instanceof Error ? error.message : "The discard result is unknown. Reload before continuing."); }
          finally { setBusy(false); }
        }}>Discard {row.name}</button>
      </li>;
    })}</ul>
  </div></main>;
}
