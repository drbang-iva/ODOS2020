import type { Basic } from "@medplum/fhirtypes";
import { useEffect, useState, type FormEvent } from "react";
import { fhir } from "../../lib/fhir";
import { loadAgeOfMajorityConfig } from "../../lib/age-of-majority";
import { buildAgeOfMajorityConfigResource, resolveAgeOfMajorityYears, ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM, ODOS_AGE_OF_MAJORITY_CONFIG_CODE } from "../../../../mcp/src/clinic/age-of-majority-config";

export function AgeOfMajoritySettings({ canWrite }: { canWrite: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [resource, setResource] = useState<Basic>();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    loadAgeOfMajorityConfig().then(config => {
      if (!active) return;
      setResource(config);
      setLoaded(true);
      try { setValue(String(resolveAgeOfMajorityYears(config))); }
      catch { setStatus("Age of majority is not configured"); }
    }).catch(cause => { if (active) setStatus(`Age of majority could not be loaded: ${String(cause)}`); });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving || !loaded) return;
    setSaving(true);
    try {
      if (resource?.id && !resource.meta?.versionId) throw new Error("Reload this setting before saving; its version is unavailable.");
      const built = buildAgeOfMajorityConfigResource({ ageOfMajorityYears: Number(value) }, resource);
      const saved = resource?.id
        ? await fhir.update(built, "age-of-majority-config", resource.meta?.versionId)
        : await fhir.create(built, "age-of-majority-config", {
          "If-None-Exist": `code=${ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM}|${ODOS_AGE_OF_MAJORITY_CONFIG_CODE}`,
        });
      setResource(saved);
      setValue(String(resolveAgeOfMajorityYears(saved)));
      setStatus("Age of majority saved.");
    } catch (cause) { setStatus(`Age of majority could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setSaving(false); }
  }

  return <main className="min-h-screen bg-[color:var(--odos-deep-surface)] p-6 text-[color:var(--odos-text)]">
    <div className="mx-auto max-w-3xl">
      <a href="/settings">← Practice settings</a>
      <h1 className="mt-4 text-2xl font-semibold">Age of majority</h1>
      <p className="mt-2 text-sm text-[color:var(--odos-muted)]">Set the age used for registration consent, statement recipients, and patient communications.</p>
      {!loaded && !status && <p>Loading age of majority…</p>}
      <form className="mt-6 space-y-4" onSubmit={event => void save(event)}>
        <label className="block">Age of majority (years)
          <input aria-label="Age of majority (years)" type="number" min="16" max="21" step="1" required value={value} disabled={!loaded || !canWrite || saving} onChange={event => setValue(event.target.value)} className="ml-3 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-deep-surface)] p-2" />
        </label>
        {status && <p role="status">{status}</p>}
        {!canWrite && <p>Practice-admin access is required to edit this setting.</p>}
        {canWrite && <button type="submit" disabled={!loaded || saving} className="rounded bg-[color:var(--odos-accent)] text-[color:var(--odos-accent-ink)] px-4 py-2">{saving ? "Saving…" : "Save age of majority"}</button>}
      </form>
    </div>
  </main>;
}
