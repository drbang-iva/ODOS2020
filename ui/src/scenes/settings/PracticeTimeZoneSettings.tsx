import type { Basic } from "@medplum/fhirtypes";
import { useEffect, useState, type FormEvent } from "react";
import { fhir } from "../../lib/fhir";
import { buildPracticeTimeZoneConfigResource, parsePracticeTimeZoneConfig, ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM, ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE } from "../../../../mcp/src/clinic/practice-time-zone-config";

export function PracticeTimeZoneSettings({ canWrite }: { canWrite: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [resource, setResource] = useState<Basic>();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const zones = Intl.supportedValuesOf("timeZone");
  useEffect(() => {
    if (!canWrite) return;
    let active = true;
    fhir.search<Basic>("Basic", { code: `${ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM}|${ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE}`, _sort: "-_lastUpdated", _count: "2" }).then(bundle => {
      if (!active) return;
      const rows = (bundle.entry ?? []).flatMap(entry => entry.resource ? [entry.resource] : []);
      setResource(rows[0]);
      setLoaded(true);
      if (rows[0]) {
        try { setValue(parsePracticeTimeZoneConfig(rows[0]).timeZone); }
        catch { setStatus("The stored practice time zone is invalid. Choose a valid zone and save to repair it."); }
      }
      if (rows.length > 1 || bundle.link?.some(link => link.relation === "next")) setStatus("Multiple practice time-zone settings found; editing the newest.");
    }).catch(cause => { if (active) setStatus(`Practice time zone could not be loaded: ${String(cause)}`); });
    return () => { active = false; };
  }, [canWrite]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving || !loaded) return;
    setSaving(true);
    try {
      if (resource?.id && !resource.meta?.versionId) throw new Error("Reload this setting before saving; its version is unavailable.");
      const built = buildPracticeTimeZoneConfigResource({ timeZone: value }, resource);
      const saved = resource?.id
        ? await fhir.update(built, "practice-time-zone-config", resource.meta?.versionId)
        : await fhir.create(built, "practice-time-zone-config", { "If-None-Exist": `code=${ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM}|${ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE}` });
      setResource(saved);
      setValue(parsePracticeTimeZoneConfig(saved).timeZone);
      setStatus("Practice time zone saved.");
    } catch (cause) { setStatus(`Practice time zone could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setSaving(false); }
  }
  return <main className="min-h-screen bg-[color:var(--odos-deep-surface)] p-6 text-[color:var(--odos-text)]">
    <div className="mx-auto max-w-3xl">
      <a href="/settings">← Practice settings</a>
      <h1 className="mt-4 text-2xl font-semibold">Practice time zone</h1>
      <p className="mt-2 text-sm text-[color:var(--odos-muted)]">Choose the local time zone used to group open charts by service day.</p>
      {!canWrite ? <p className="mt-4">Practice-admin access is required to view and edit this setting.</p> : <>
        {!loaded && !status && <p>Loading practice time zone…</p>}
        {loaded && !resource && <p className="mt-4">Not set — the server default is used until you save one.</p>}
        <form className="mt-6 space-y-4" onSubmit={event => void save(event)}>
          <label className="block">Time zone
            <select aria-label="Time zone" required value={value} disabled={!loaded || saving} onChange={event => setValue(event.target.value)} className="ml-3 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-deep-surface)] p-2">
              <option value="" disabled>Choose a time zone</option>
              {value && !zones.includes(value) && <option value={value}>{value}</option>}
              {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </label>
          <button type="submit" disabled={!loaded || saving || !value} className="rounded bg-[color:var(--odos-accent)] text-[color:var(--odos-accent-ink)] px-4 py-2">{saving ? "Saving…" : "Save practice time zone"}</button>
        </form>
      </>}
      {status && <p className="mt-4" role="status">{status}</p>}
    </div>
  </main>;
}
