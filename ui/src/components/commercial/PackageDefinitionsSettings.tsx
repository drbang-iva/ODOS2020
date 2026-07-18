import { useEffect, useMemo, useState } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import {
  archivePackageDefinition,
  fetchPackageDefinitions,
  savePackageDefinition,
  type PackageDefinition,
} from "../../lib/commercial-engine";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { CatalogEditor, type CatalogDescriptor } from "../../scenes/settings/CatalogEditor";
import {
  DRY_EYE_TREATMENT_TYPE_CODES,
  displayForTreatmentType,
} from "../../lib/fhir-dry-eye/terminology";

type ProcedureOption = { value: string; label: string };

export function PackageDefinitionsSettings({ canWrite }: { canWrite: boolean }) {
  const [procedureOptions, setProcedureOptions] = useState<ProcedureOption[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch(`${clinicalGraphApiBase()}/clinical-graph/procedure-definitions`, { headers: authHeaders() })
      .then(async (response) => {
        const body = await response.json() as {
          definitions?: Array<{
            display?: string;
            fhirProcedureCode?: { code?: string } | { coding?: Array<{ code?: string }> };
          }>;
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

  const adapter = useMemo(() => packageDefinitionAdapter(), []);
  const descriptor = useMemo(() => packageDescriptor(adapter, procedureOptions), [adapter, procedureOptions]);
  return (
    <>
      {error && <div role="alert" className="border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">Procedure types could not be loaded: {error}</div>}
      <CatalogEditor descriptor={descriptor} canWrite={canWrite} />
    </>
  );
}

export function packageDefinitionAdapter(): CatalogAdapter<PackageDefinition> {
  return {
    capabilities: { reorder: false, deactivate: true, presetSeed: false, groupBy: false },
    list: () => fetchPackageDefinitions(true),
    save: (item) => savePackageDefinition({
      ...(item.id ? { id: item.id } : {}),
      name: item.name,
      eligibleProcedureTypeCodes: item.eligibleProcedureTypeCodes,
      sessionCount: item.sessionCount,
      priceCents: item.priceCents,
      expiryDays: item.expiryDays,
      refundPolicy: item.refundPolicy,
    }),
    deactivate: (item) => archivePackageDefinition(item.id),
  };
}

export function packageDescriptor(
  adapter: CatalogAdapter<PackageDefinition>,
  procedureOptions: readonly ProcedureOption[],
): CatalogDescriptor<PackageDefinition> {
  return {
    title: "Packages",
    singularLabel: "package",
    adapter,
    fields: [
      { type: "text", key: "name", label: "Name", required: true, unique: true },
      { type: "multi-select", key: "eligibleProcedureTypeCodes", label: "Eligible procedure types", required: true, options: procedureOptions },
      { type: "number", key: "sessionCount", label: "Session count", required: true, min: 1 },
      { type: "number", key: "priceCents", label: "Package price (cents)", required: true, min: 1 },
      { type: "number", key: "expiryDays", label: "Expiry (days)", required: true, min: 1 },
      {
        type: "select",
        key: "refundPolicy",
        label: "Refund policy",
        required: true,
        options: [
          { value: "non_refundable", label: "Non-refundable" },
          { value: "store_credit_only", label: "Store credit only" },
          { value: "prorated_cash", label: "Prorated cash" },
        ],
      },
    ],
    createItem: () => ({
      id: "",
      name: "",
      eligibleProcedureTypeCodes: [],
      sessionCount: 3,
      priceCents: 0,
      expiryDays: 365,
      refundPolicy: "non_refundable",
      active: true,
      soldCount: 0,
      createdAt: "",
      updatedAt: "",
    }),
    label: (item) => item.name || "New package",
    facts: (item) => [`${item.sessionCount} sessions`, money(item.priceCents), `${item.expiryDays} days`],
    chips: (item) => [refundLabel(item.refundPolicy), item.active ? "Active" : "Archived"],
    readOnlyFacts: (item) => [{ label: "Packages sold", value: String(item.soldCount) }],
    immediateCommit: true,
    listGrammar: {
      searchPlaceholder: "Find a package",
      searchText: (item) => [item.name, ...item.eligibleProcedureTypeCodes, refundLabel(item.refundPolicy)].join(" "),
      deactivateConsequence: (item) => item.soldCount > 0
        ? `Archive ${item.name}. Existing patient balances and history remain unchanged.`
        : `Archive ${item.name}. It will no longer be available for new sales.`,
    },
  };
}

function refundLabel(policy: PackageDefinition["refundPolicy"]): string {
  return policy === "non_refundable" ? "Non-refundable" : policy === "store_credit_only" ? "Store credit only" : "Prorated cash";
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
