import type { Basic } from "@medplum/fhirtypes";
import { useEffect, useState, type FormEvent } from "react";
import {
  APPEARANCE_ACCENTS,
  SELECTABLE_APPEARANCE_SURFACES,
  applyAppearance,
  buildAppearanceConfigResource,
  loadAppearanceConfigSingleton,
  parseAppearanceConfig,
  type AppearanceAccent,
  type AppearanceConfig,
  type AppearanceSettingsClient,
  type AppearanceSurface,
} from "../../lib/appearance";
import { fhir } from "../../lib/fhir";

const SURFACE_LABELS: Record<AppearanceSurface, string> = {
  light: "Light",
  midnight: "Midnight",
  "space-black": "Space Black",
};

const ACCENT_LABELS: Record<AppearanceAccent, string> = {
  gold: "Gold",
  emerald: "Emerald",
  sapphire: "Sapphire",
  amethyst: "Amethyst",
  "deep-sapphire": "Deep Sapphire",
  "deep-amethyst": "Deep Amethyst",
};

type LoadedAppearance = {
  config: AppearanceConfig;
  resource?: Basic;
};

export function AppearanceSettings({ canWrite }: { canWrite: boolean }) {
  const [loaded, setLoaded] = useState<LoadedAppearance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAppearanceConfigSingleton(fhir)
      .then((result) => {
        if (!cancelled) setLoaded(result);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => { cancelled = true; };
  }, []);

  if (error) return <AppearanceState message={`Appearance could not be loaded: ${error}`} alert />;
  if (!loaded) return <AppearanceState message="Loading appearance…" />;
  return <AppearanceSettingsReady {...loaded} canWrite={canWrite} client={fhir} />;
}

export function AppearanceSettingsReady({
  config,
  resource,
  canWrite,
  client,
}: LoadedAppearance & {
  canWrite: boolean;
  client: AppearanceSettingsClient;
}) {
  const [draft, setDraft] = useState(config);
  const [currentResource, setCurrentResource] = useState(resource);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const built = buildAppearanceConfigResource(draft, currentResource);
      const saved = currentResource?.id
        ? await client.update(built, "appearance-config")
        : await client.create(built, "appearance-config");
      const persisted = parseAppearanceConfig(saved);
      setCurrentResource(saved);
      setDraft(persisted);
      applyAppearance(persisted);
      setStatus("Appearance saved for this practice.");
    } catch (saveError) {
      setStatus(`Appearance could not be saved: ${errorMessage(saveError)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="practice-settings appearance-settings">
      <div className="odos-ambient" />
      <div className="appearance-settings-body">
        <header className="appearance-settings-header">
          <div className="practice-settings-kicker">Practice Settings</div>
          <h1>Appearance</h1>
          <p>Choose one coordinated surface and accent scheme for every workstation in the practice.</p>
        </header>
        <form onSubmit={(event) => void save(event)}>
          <SchemeRow
            legend="Surface"
            description="Sets the app canvas, cards, text, borders, popovers, and shadows."
            options={SELECTABLE_APPEARANCE_SURFACES}
            labels={SURFACE_LABELS}
            value={draft.surface}
            disabled={!canWrite || saving}
            onChange={(surface) => setDraft((current) => ({ ...current, surface }))}
          />
          <SchemeRow
            legend="Accent"
            description="Coordinates selections, primary actions, totals, focus rings, and card hairlines."
            options={APPEARANCE_ACCENTS}
            labels={ACCENT_LABELS}
            value={draft.accent}
            disabled={!canWrite || saving}
            onChange={(accent) => setDraft((current) => ({ ...current, accent }))}
            accent
          />
          {!canWrite && (
            <p className="appearance-settings-note">Practice-admin access is required to change appearance.</p>
          )}
          {status && <p className="appearance-settings-status" role="status">{status}</p>}
          {canWrite && (
            <button className="settings-primary-action" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save appearance"}
            </button>
          )}
        </form>
      </div>
    </main>
  );
}

function SchemeRow<T extends string>({
  legend,
  description,
  options,
  labels,
  value,
  disabled,
  onChange,
  accent = false,
}: {
  legend: string;
  description: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
  accent?: boolean;
}) {
  return (
    <fieldset className="appearance-scheme-row" disabled={disabled}>
      <legend>{legend}</legend>
      <p>{description}</p>
      <div className="appearance-scheme-options">
        {options.map((option) => (
          <label key={option} className={accent ? "appearance-accent-option" : undefined}>
            <input
              type="radio"
              name={legend.toLocaleLowerCase()}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            {accent && <span className="appearance-accent-swatch" data-accent-swatch={option} aria-hidden="true" />}
            <span>{labels[option]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AppearanceState({ message, alert = false }: { message: string; alert?: boolean }) {
  return (
    <main className="practice-settings appearance-settings">
      <div className="appearance-settings-body">
        <div className="practice-settings-kicker">Practice Settings</div>
        <h1>Appearance</h1>
        <p {...(alert ? { role: "alert" } : {})}>{message}</p>
      </div>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
