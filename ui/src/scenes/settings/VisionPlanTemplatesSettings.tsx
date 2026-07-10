import type { Basic } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import { createSingletonConfigDraft, type SingletonConfigDraft } from "../../lib/catalog-adapter";
import { fhir } from "../../lib/fhir";
import {
  buildInsuranceConfigResource,
  loadInsuranceConfigSingleton,
  type PersistedInsuranceConfig,
} from "../../lib/insurance-config";
import {
  PLAN_TEMPLATE_FIELDS,
  createPlanTemplateAdapter,
  emptyPlanTemplateRow,
  validatePlanTemplateRow,
  type PlanTemplateRow,
} from "../../lib/plan-template-settings";
import { useRole } from "../../lib/role-context";
import {
  CatalogScene,
  CatalogSection,
  type CatalogDescriptor,
} from "./CatalogEditor";

type InsuranceSettingsClient = {
  create<T extends Basic>(resource: T, sourceTag: string): Promise<T>;
  update<T extends Basic>(resource: T, sourceTag: string): Promise<T>;
};

export function VisionPlanTemplatesSettings() {
  const { role } = useRole();
  const [loaded, setLoaded] = useState<{
    resource?: Basic;
    config: PersistedInsuranceConfig;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = role === "practice-admin" || role === "front-desk";

  useEffect(() => {
    let cancelled = false;
    void loadInsuranceConfigSingleton(fhir)
      .then((result) => {
        if (!cancelled) {
          setLoaded(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="min-h-screen bg-[#060610] p-6 text-white">
        <div role="alert" className="mx-auto max-w-5xl border border-red-400/40 bg-red-950/50 px-4 py-3 text-sm text-red-100">
          Vision plan templates could not be loaded: {error}
        </div>
      </main>
    );
  }

  if (!loaded) {
    return (
      <main className="min-h-screen bg-[#060610] p-6 text-white">
        <div className="mx-auto max-w-5xl">
          <div className="text-xs uppercase tracking-wide text-white/45">Practice Settings</div>
          <h1 className="text-2xl font-semibold">Vision plan templates</h1>
          <div className="mt-5 text-sm text-white/55">Loading vision plan templates…</div>
        </div>
      </main>
    );
  }

  return (
    <VisionPlanTemplatesSettingsReady
      {...loaded}
      canWrite={canWrite}
      client={fhir}
    />
  );
}

export function VisionPlanTemplatesSettingsReady({
  resource,
  config,
  canWrite,
  client,
}: {
  resource?: Basic;
  config: PersistedInsuranceConfig;
  canWrite: boolean;
  client: InsuranceSettingsClient;
}) {
  const draft = useMemo(
    () =>
      createSingletonConfigDraft({
        configKey: "osod-insurance-config",
        config,
        resource,
        buildResource: buildInsuranceConfigResource,
        sourceTag: "insurance-config",
        fhirClient: client,
      }),
    [client, config, resource],
  );
  const adapter = useMemo(() => createPlanTemplateAdapter(draft), [draft]);
  const descriptor = useMemo(
    () => createPlanTemplateDescriptor(draft, adapter),
    [adapter, draft],
  );

  return (
    <CatalogScene title="Vision plan templates" canWrite={canWrite} transaction={draft}>
      <CatalogSection descriptor={descriptor} canWrite={canWrite} />
    </CatalogScene>
  );
}

export function createPlanTemplateDescriptor(
  draft: SingletonConfigDraft<PersistedInsuranceConfig>,
  adapter = createPlanTemplateAdapter(draft),
): CatalogDescriptor<PlanTemplateRow> {
  return {
    title: "Plan templates",
    singularLabel: "plan template",
    adapter,
    fields: PLAN_TEMPLATE_FIELDS,
    createItem: () => emptyPlanTemplateRow(newRowId()),
    validateItem: (item, items) => validatePlanTemplateRow(draft.current(), items, item),
    label: (item) => item.label,
    chips: (item) => [item.payerDisplay || "All payers"],
  };
}

function newRowId(): string {
  return `plan-template-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}
