import { useEffect, useMemo, useState } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import {
  archiveSeriesProtocol,
  fetchSeriesProtocols,
  saveSeriesProtocol,
  type SeriesProtocolDefinition,
} from "../../lib/series-tracker";
import { DRY_EYE_TREATMENT_TYPE_CODES, displayForTreatmentType } from "../../lib/fhir-dry-eye/terminology";
import { CatalogEditor, type CatalogDescriptor } from "../../scenes/settings/CatalogEditor";

type ProcedureOption = { value: string; label: string };

export function ProtocolDefinitionsSettings({ canWrite }: { canWrite: boolean }) {
  const [procedureOptions, setProcedureOptions] = useState<ProcedureOption[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch(`${clinicalGraphApiBase()}/clinical-graph/procedure-definitions`, { headers: authHeaders() })
      .then(async (response) => {
        const body = await response.json() as {
          definitions?: Array<{ display?: string; fhirProcedureCode?: { code?: string } | { coding?: Array<{ code?: string }> } }>;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? `Procedure catalog failed: ${response.status}`);
        const catalog = (body.definitions ?? []).flatMap((definition) => {
          const fhirCode = definition.fhirProcedureCode;
          let code: string | undefined;
          if (fhirCode && "coding" in fhirCode) code = fhirCode.coding?.[0]?.code;
          else if (fhirCode && "code" in fhirCode) code = fhirCode.code;
          return code ? [{ value: code, label: definition.display ?? code }] : [];
        });
        const dryEye = DRY_EYE_TREATMENT_TYPE_CODES.map((code) => ({ value: code, label: displayForTreatmentType(code) }));
        return [...new Map([...dryEye, ...catalog].map((option) => [option.value, option])).values()];
      })
      .then((options) => !cancelled && setProcedureOptions(options))
      .catch((cause) => !cancelled && setError(messageOf(cause)));
    return () => { cancelled = true; };
  }, []);

  const adapter = useMemo(() => protocolAdapter(), []);
  const descriptor = useMemo(() => protocolDescriptor(adapter, procedureOptions), [adapter, procedureOptions]);
  return (
    <>
      {error && <div role="alert" className="border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">Procedure types could not be loaded: {error}</div>}
      <CatalogEditor descriptor={descriptor} canWrite={canWrite} />
    </>
  );
}

export function protocolAdapter(): CatalogAdapter<SeriesProtocolDefinition> {
  return {
    capabilities: { reorder: false, deactivate: true, presetSeed: false, groupBy: false },
    list: () => fetchSeriesProtocols(true),
    save: (item) => saveSeriesProtocol({
      ...(item.id ? { id: item.id } : {}),
      name: item.name,
      eligibleProcedureTypeCodes: item.eligibleProcedureTypeCodes,
      sessionCount: item.sessionCount,
      intervalMinDays: item.intervalMinDays,
      intervalMaxDays: item.intervalMaxDays,
      maintenanceAfter: item.maintenanceAfter,
    }),
    deactivate: (item) => archiveSeriesProtocol(item.id),
  };
}

export function protocolDescriptor(
  adapter: CatalogAdapter<SeriesProtocolDefinition>,
  procedureOptions: readonly ProcedureOption[],
): CatalogDescriptor<SeriesProtocolDefinition> {
  return {
    title: "Treatment protocols",
    singularLabel: "protocol",
    adapter,
    fields: [
      { type: "text", key: "name", label: "Name", required: true, unique: true },
      { type: "multi-select", key: "eligibleProcedureTypeCodes", label: "Eligible procedure types", required: true, options: procedureOptions },
      { type: "number", key: "sessionCount", label: "Session count", required: true, min: 2, integer: true },
      { type: "number", key: "intervalMinDays", label: "Minimum interval (days)", required: true, min: 1, integer: true },
      { type: "number", key: "intervalMaxDays", label: "Maximum interval (days)", required: true, min: 1, integer: true },
      { type: "toggle", key: "maintenanceAfter", label: "Maintenance follows the initial series" },
    ],
    createItem: () => ({
      id: "",
      name: "",
      eligibleProcedureTypeCodes: [],
      sessionCount: 4,
      intervalMinDays: 21,
      intervalMaxDays: 28,
      maintenanceAfter: false,
      active: true,
      planDefinitionCanonical: "",
      activityDefinitionCanonical: "",
      updatedAt: "",
    }),
    validateItem: (item) => {
      if (item.intervalMinDays > item.intervalMaxDays) throw new Error("Minimum interval cannot exceed maximum interval.");
    },
    label: (item) => item.name || "New protocol",
    facts: (item) => [`${item.sessionCount} sessions`, `${item.intervalMinDays}–${item.intervalMaxDays} days`],
    chips: (item) => [item.maintenanceAfter ? "Maintenance after" : "Initial series only", item.active ? "Active" : "Archived"],
    immediateCommit: true,
    listGrammar: {
      searchPlaceholder: "Find a treatment protocol",
      searchText: (item) => [item.name, ...item.eligibleProcedureTypeCodes].join(" "),
      deactivateConsequence: (item) => `Archive ${item.name}. Existing patient CarePlans remain unchanged.`,
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
