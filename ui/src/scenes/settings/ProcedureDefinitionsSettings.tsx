import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";

interface ProcedureDefinitionRow {
  stableKey: string;
  display: string;
  active: boolean;
  photo_posture: "timeline" | "compare";
}

export function ProcedureDefinitionsSettings({ canWrite }: { canWrite: boolean }) {
  const [definitions, setDefinitions] = useState<ProcedureDefinitionRow[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState<string>();

  async function load() {
    const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/procedure-definitions`, { headers: authHeaders() });
    const body = await response.json() as { definitions?: ProcedureDefinitionRow[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? `Procedure definitions failed: ${response.status}`);
    setDefinitions(body.definitions ?? []);
  }

  useEffect(() => {
    load().catch((cause) => setError(messageOf(cause)));
  }, []);

  async function update(definition: ProcedureDefinitionRow, changes: Partial<Pick<ProcedureDefinitionRow, "active" | "photo_posture">>) {
    setSaving(definition.stableKey);
    setError(undefined);
    try {
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/procedure-definitions/${encodeURIComponent(definition.stableKey)}`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update-definition", ...changes }),
        },
      );
      const body = await response.json() as { definition?: ProcedureDefinitionRow; error?: string };
      if (!response.ok || !body.definition) {
        throw new Error(body.error ?? `Procedure definition update failed: ${response.status}`);
      }
      setDefinitions((current) => current.map((row) => row.stableKey === definition.stableKey ? body.definition! : row));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(undefined);
    }
  }

  return (
    <main className="practice-settings">
      <div className="odos-ambient" />
      <div className="practice-settings-body">
        <header className="practice-settings-hero">
          <div>
            <div className="practice-settings-kicker">Clinical</div>
            <h1>Procedure definitions</h1>
            <p>Choose how each procedure&apos;s longitudinal images open on the patient chart.</p>
          </div>
        </header>
        {error && <div role="alert" className="mb-4 border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}
        <div className="grid gap-3">
          {definitions.map((definition) => (
            <section key={definition.stableKey} className="rounded border border-white/10 bg-bg-panel/80 p-4 text-white">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{definition.display}</h2>
                  <p className="mt-1 text-xs text-white/35">{definition.stableKey}</p>
                </div>
                <div className="flex items-center gap-4">
                  <label className="text-xs text-white/55">
                    Default photo view
                    <select
                      aria-label={`${definition.display} default photo view`}
                      className="sidebar-input mt-1"
                      value={definition.photo_posture}
                      disabled={!canWrite || saving === definition.stableKey}
                      onChange={(event) => update(definition, { photo_posture: event.target.value as ProcedureDefinitionRow["photo_posture"] })}
                    >
                      <option value="timeline">Timeline</option>
                      <option value="compare">Compare</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-white/55">
                    <input
                      type="checkbox"
                      checked={definition.active}
                      disabled={!canWrite || saving === definition.stableKey}
                      onChange={(event) => update(definition, { active: event.target.checked })}
                    />
                    Active
                  </label>
                </div>
              </div>
            </section>
          ))}
          {definitions.length === 0 && !error && <p className="text-sm text-white/45">No procedure definitions are available.</p>}
        </div>
      </div>
    </main>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
