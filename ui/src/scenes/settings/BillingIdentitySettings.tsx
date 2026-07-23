import type { Basic } from "@medplum/fhirtypes";
import { useEffect, useState, type FormEvent } from "react";
import { fhir } from "../../lib/fhir";
import { searchAll } from "../../lib/fhir-search";
import {
  ODOS_BILLING_IDENTITY_CONFIG_CODE,
  ODOS_BILLING_IDENTITY_CONFIG_SYSTEM,
  buildBillingIdentityResource,
  emptyBillingIdentityConfig,
  parseBillingIdentityConfig,
  type BillingIdentityConfig,
} from "./billing-identity-config";

export type LoadedBillingIdentity = {
  config?: BillingIdentityConfig;
  resource?: Basic;
};

export type BillingIdentitySettingsClient = Pick<typeof fhir, "create" | "update">;

type BillingIdentityLoaderClient = Pick<typeof fhir, "search"> &
  Partial<Pick<typeof fhir, "searchUrl">>;

export function BillingIdentitySettings({ canWrite }: { canWrite: boolean }) {
  const [loaded, setLoaded] = useState<LoadedBillingIdentity | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    loadBillingIdentityConfigSingleton(fhir)
      .then((result) => {
        if (!cancelled) setLoaded(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <SettingsState message={`Billing identity could not be loaded: ${error}`} alert />;
  if (!loaded) return <SettingsState message="Loading billing identity…" />;
  return <BillingIdentitySettingsReady {...loaded} canWrite={canWrite} client={fhir} />;
}

export async function loadBillingIdentityConfigSingleton(
  client: BillingIdentityLoaderClient,
): Promise<LoadedBillingIdentity> {
  const resources = await searchAll<Basic>(client, "Basic", {
    code: `${ODOS_BILLING_IDENTITY_CONFIG_SYSTEM}|${ODOS_BILLING_IDENTITY_CONFIG_CODE}`,
    _count: "10",
  });
  const resource = [...resources].sort((left, right) => lastUpdatedMs(right) - lastUpdatedMs(left))[0];
  return resource ? { resource, config: parseBillingIdentityConfig(resource) } : {};
}

export function BillingIdentitySettingsReady({
  config,
  resource,
  canWrite,
  client,
}: LoadedBillingIdentity & {
  canWrite: boolean;
  client: BillingIdentitySettingsClient;
}) {
  const [draft, setDraft] = useState(config ?? emptyBillingIdentityConfig());
  const [currentResource, setCurrentResource] = useState(resource);
  const [status, setStatus] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving) return;
    setSaving(true);
    setStatus(undefined);
    try {
      const built = buildBillingIdentityResource(draft, currentResource);
      const saved = currentResource?.id
        ? await client.update(built, "billing-identity-config")
        : await client.create(built, "billing-identity-config");
      setCurrentResource(saved);
      setDraft(parseBillingIdentityConfig(saved));
      setStatus("Billing identity saved.");
    } catch (cause) {
      setStatus(`Billing identity could not be saved: ${errorMessage(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  const set = (key: keyof BillingIdentityConfig, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <main className="min-h-screen bg-bg-deep p-6 text-[color:var(--odos-text)]">
      <div className="mx-auto max-w-4xl">
        <div className="text-xs uppercase tracking-wide text-[color:var(--odos-muted)]">Practice Settings</div>
        <h1 className="mt-1 text-2xl font-semibold">Billing identity</h1>
        <p className="mt-2 text-sm text-[color:var(--odos-muted)]">
          Set the practice-wide billing provider defaults used when composing professional claims.
        </p>
        <form className="mt-7 space-y-5" onSubmit={(event) => void save(event)}>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <ConfigField label="Practice name" value={draft.name} disabled={!canWrite || saving} onChange={(value) => set("name", value)} />
            <ConfigField label="NPI" value={draft.npi} disabled={!canWrite || saving} onChange={(value) => set("npi", value)} />
            <ConfigField label="Taxonomy" value={draft.taxonomy} disabled={!canWrite || saving} onChange={(value) => set("taxonomy", value)} />
            <ConfigField label="Tax ID" value={draft.taxId} disabled={!canWrite || saving} onChange={(value) => set("taxId", value)} />
            <label className="text-xs font-semibold text-[color:var(--odos-muted)]">Tax ID type
              <select value={draft.taxIdType} disabled={!canWrite || saving} onChange={(event) => set("taxIdType", event.target.value)} className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 py-2 text-sm text-[color:var(--odos-text)]">
                <option value="E">EIN</option><option value="S">SSN</option>
              </select>
            </label>
            <ConfigField label="Phone" value={draft.phone ?? ""} disabled={!canWrite || saving} onChange={(value) => set("phone", value)} />
            <ConfigField label="Email" value={draft.email ?? ""} disabled={!canWrite || saving} onChange={(value) => set("email", value)} />
            <ConfigField label="Fax" value={draft.fax ?? ""} disabled={!canWrite || saving} onChange={(value) => set("fax", value)} />
            <ConfigField label="Address" value={draft.address1} disabled={!canWrite || saving} onChange={(value) => set("address1", value)} />
            <ConfigField label="City" value={draft.city} disabled={!canWrite || saving} onChange={(value) => set("city", value)} />
            <ConfigField label="State" value={draft.state} disabled={!canWrite || saving} onChange={(value) => set("state", value)} />
            <ConfigField label="ZIP" value={draft.zip} disabled={!canWrite || saving} onChange={(value) => set("zip", value)} />
          </div>
          {!canWrite && <p className="text-sm text-amber-100">Practice-admin access is required to edit billing identity.</p>}
          {status && <p role="status" className="text-sm text-[color:var(--odos-muted)]">{status}</p>}
          {canWrite && <button type="submit" disabled={saving} className="rounded bg-brand px-4 py-2 text-sm font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save billing identity"}</button>}
        </form>
      </div>
    </main>
  );
}

function ConfigField({ label, value, disabled, onChange }: {
  label: string;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return <label className="text-xs font-semibold text-[color:var(--odos-muted)]">{label}<input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 py-2 text-sm text-[color:var(--odos-text)] outline-none focus:border-brand" /></label>;
}

function SettingsState({ message, alert = false }: { message: string; alert?: boolean }) {
  return <main className="min-h-screen bg-bg-deep p-6 text-[color:var(--odos-text)]"><div role={alert ? "alert" : "status"} className="mx-auto max-w-4xl rounded border border-[color:var(--odos-line)] bg-bg-panel/70 p-5 text-sm">{message}</div></main>;
}

function lastUpdatedMs(resource: Basic): number {
  return resource.meta?.lastUpdated ? Date.parse(resource.meta.lastUpdated) || 0 : 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
