import { useMemo } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import {
  procedureFeeScheduleAdapter,
  type ProcedureFeeScheduleItem,
} from "../../lib/procedure-fee-schedule";
import { CatalogEditor, type CatalogDescriptor } from "./CatalogEditor";

export function FeeScheduleSettings({ canWrite }: { canWrite: boolean }) {
  const adapter = useMemo(() => procedureFeeScheduleAdapter(), []);
  const descriptor = useMemo(() => feeScheduleDescriptor(adapter), [adapter]);
  return (
    <>
      {!canWrite && (
        <div className="border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
          Read only. Practice-admin access is required to edit the fee schedule.
        </div>
      )}
      <CatalogEditor descriptor={descriptor} canWrite={canWrite} />
    </>
  );
}

export function feeScheduleDescriptor(
  adapter: CatalogAdapter<ProcedureFeeScheduleItem>,
): CatalogDescriptor<ProcedureFeeScheduleItem> {
  return {
    title: "Fee Schedule",
    singularLabel: "procedure fee",
    adapter,
    canCreate: false,
    fields: [
      { type: "text", key: "billingCode", label: "Billing code" },
      { type: "currency", key: "priceCents", label: "Fee", min: 0 },
    ],
    createItem: () => ({
      id: "",
      procedureConceptKey: "",
      display: "",
      active: true,
      version: "1",
    }),
    label: (item) => item.display,
    facts: (item) => [
      ...(item.billingCode ? [item.billingCode] : []),
      item.priceCents === undefined ? "No fee set" : money(item.priceCents),
      `Version ${item.version}`,
    ],
    chips: (item) => [
      !item.active || item.priceCents === undefined ? "Unpriced" : "Priced",
      item.active ? "Active" : "Inactive",
    ],
    readOnlyFacts: (item) => [
      { label: "Procedure concept", value: item.procedureConceptKey },
    ],
    immediateCommit: true,
    listGrammar: {
      searchPlaceholder: "Find a procedure fee",
      searchText: (item) => `${item.display} ${item.procedureConceptKey} ${item.billingCode ?? ""}`,
      deactivateConsequence: (item) =>
        `${item.display} remains in fee history. Accepted charges will be flagged unpriced until an active fee is available.`,
    },
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
