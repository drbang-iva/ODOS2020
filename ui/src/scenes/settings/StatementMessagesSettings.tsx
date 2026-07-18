import type { Basic } from "@medplum/fhirtypes";
import { useEffect, useState, type FormEvent } from "react";
import { fhir } from "../../lib/fhir";
import { searchAll } from "../../lib/fhir-search";
import {
  ODOS_STATEMENT_MESSAGE_CONFIG_CODE,
  ODOS_STATEMENT_MESSAGE_CONFIG_RESOURCE_ID,
  ODOS_STATEMENT_MESSAGE_CONFIG_SYSTEM,
  STATEMENT_MESSAGE_MAX_LENGTH,
  buildStatementMessageConfigResource,
  parseStatementMessageConfig,
  type PersistedStatementMessageConfig,
} from "./statement-message-config";

type LoadedStatementMessages = {
  config: PersistedStatementMessageConfig;
  resource?: Basic;
};

export type StatementMessagesSettingsClient = Pick<
  typeof fhir,
  "search" | "searchUrl" | "update"
>;

export function StatementMessagesSettings({
  canWrite,
  onBack,
}: {
  canWrite: boolean;
  onBack?: () => void;
}) {
  const [loaded, setLoaded] = useState<LoadedStatementMessages | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStatementMessageConfigSingleton(fhir)
      .then((result) => {
        if (!cancelled) setLoaded(result);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <SettingsState message={`Statement and receipt messages could not be loaded: ${error}`} alert onBack={onBack} />;
  }
  if (!loaded) {
    return <SettingsState message="Loading statement and receipt messages…" onBack={onBack} />;
  }
  return (
    <StatementMessagesSettingsReady
      {...loaded}
      canWrite={canWrite}
      client={fhir}
      onBack={onBack}
    />
  );
}

export async function loadStatementMessageConfigSingleton(
  client: Pick<typeof fhir, "search" | "searchUrl">,
): Promise<LoadedStatementMessages> {
  const resources = await searchAll<Basic>(client, "Basic", {
    code: `${ODOS_STATEMENT_MESSAGE_CONFIG_SYSTEM}|${ODOS_STATEMENT_MESSAGE_CONFIG_CODE}`,
    _count: "10",
  });
  const resource = [...resources].sort((a, b) => lastUpdatedMs(b) - lastUpdatedMs(a))[0];
  return {
    config: resource ? parseStatementMessageConfig(resource) : {},
    ...(resource ? { resource } : {}),
  };
}

export function StatementMessagesSettingsReady({
  config,
  resource,
  canWrite,
  client,
  onBack,
}: LoadedStatementMessages & {
  canWrite: boolean;
  client: StatementMessagesSettingsClient;
  onBack?: () => void;
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
      const built = buildStatementMessageConfigResource(draft, currentResource);
      const saved = await client.update(
        currentResource?.id
          ? built
          : { ...built, id: ODOS_STATEMENT_MESSAGE_CONFIG_RESOURCE_ID },
        "statement-message-config",
      );
      setCurrentResource(saved);
      setDraft(parseStatementMessageConfig(saved));
      setStatus("Statement and receipt messages saved.");
    } catch (saveError) {
      setStatus(`Messages could not be saved: ${errorMessage(saveError)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#060610] p-6 text-white">
      <div className="mx-auto max-w-3xl">
        {onBack && (
          <button className="mb-5 text-sm text-blue-200" type="button" onClick={onBack}>
            ← Practice settings
          </button>
        )}
        <div className="text-xs uppercase tracking-wide text-white/45">Practice Settings</div>
        <h1 className="mt-1 text-2xl font-semibold">Statement and receipt messages</h1>
        <p className="mt-2 text-sm text-white/55">
          Set short practice-wide notes for patient financial documents.
        </p>
        <form className="mt-7 space-y-6" onSubmit={(event) => void save(event)}>
          <MessageField
            id="statement-footer-message"
            label="Statement footer message"
            helper="This prints on every statement — keep it factual and free of patient-specific detail."
            value={draft.statementFooterMessage ?? ""}
            disabled={!canWrite || saving}
            onChange={(statementFooterMessage) => setDraft((current) => ({
              ...current,
              statementFooterMessage,
            }))}
          />
          <MessageField
            id="receipt-footer-message"
            label="Receipt footer message"
            helper="This prints on every receipt — keep it factual and free of patient-specific detail."
            value={draft.receiptFooterMessage ?? ""}
            disabled={!canWrite || saving}
            onChange={(receiptFooterMessage) => setDraft((current) => ({
              ...current,
              receiptFooterMessage,
            }))}
          />
          {!canWrite && (
            <p className="text-sm text-amber-100">Practice-admin access is required to edit these messages.</p>
          )}
          {status && <p role="status" className="text-sm text-white/70">{status}</p>}
          {canWrite && (
            <button
              className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
              type="submit"
              disabled={saving}
            >
              {saving ? "Saving…" : "Save messages"}
            </button>
          )}
        </form>
      </div>
    </main>
  );
}

function MessageField({
  id,
  label,
  helper,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  helper: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block rounded-lg border border-white/10 bg-white/[0.03] p-4" htmlFor={id}>
      <span className="flex items-center justify-between gap-4 text-sm font-semibold">
        <span>{label}</span>
        <span aria-live="polite" className="font-normal text-white/45">
          {value.length}/{STATEMENT_MESSAGE_MAX_LENGTH}
        </span>
      </span>
      <textarea
        id={id}
        className="mt-3 min-h-28 w-full rounded border border-white/15 bg-black/20 p-3 text-sm text-white"
        maxLength={STATEMENT_MESSAGE_MAX_LENGTH}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="mt-2 block text-xs text-white/45">{helper}</span>
    </label>
  );
}

function SettingsState({
  message,
  alert = false,
  onBack,
}: {
  message: string;
  alert?: boolean;
  onBack?: () => void;
}) {
  return (
    <main className="min-h-screen bg-[#060610] p-6 text-white">
      <div className="mx-auto max-w-3xl">
        {onBack && <button className="mb-5 text-sm text-blue-200" type="button" onClick={onBack}>← Practice settings</button>}
        <div className="text-xs uppercase tracking-wide text-white/45">Practice Settings</div>
        <h1 className="text-2xl font-semibold">Statement and receipt messages</h1>
        <div {...(alert ? { role: "alert" } : {})} className={`mt-5 text-sm ${alert ? "text-red-200" : "text-white/55"}`}>
          {message}
        </div>
      </div>
    </main>
  );
}

function lastUpdatedMs(resource: Basic): number {
  return resource.meta?.lastUpdated ? Date.parse(resource.meta.lastUpdated) || 0 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
