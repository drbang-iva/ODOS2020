import { useMemo, useState } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import {
  procedureFeeScheduleAdapter,
  type ProcedureFeeScheduleItem,
} from "../../lib/procedure-fee-schedule";
import { CatalogEditor, type CatalogDescriptor } from "./CatalogEditor";
import { procedureFeeImportApi } from "../../lib/procedure-fee-import";
import { FeeScheduleImport } from "./FeeScheduleImport";

const CATEGORY_LABELS = {
  exam: "Exams",
  refraction: "Refraction",
  "cl-fitting": "Contact Lens Fittings",
  procedure: "Procedures",
} as const;
const CATEGORY_ORDER: readonly string[] = Object.values(CATEGORY_LABELS);

export function FeeScheduleSettings({ canWrite }: { canWrite: boolean }) {
  const adapter = useMemo(() => procedureFeeScheduleAdapter(), []);
  const descriptor = useMemo(() => feeScheduleDescriptor(adapter), [adapter]);
  const importApi = useMemo(() => procedureFeeImportApi(), []);
  const [catalogRevision, setCatalogRevision] = useState(0);
  return (
    <>
      {!canWrite && (
        <div className="border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
          Read only. Practice-admin access is required to edit the fee schedule.
        </div>
      )}
      {canWrite && (
        <FeeScheduleImport api={importApi} onCommitted={() => setCatalogRevision((value) => value + 1)} />
      )}
      <CatalogEditor key={catalogRevision} descriptor={descriptor} canWrite={canWrite} />
    </>
  );
}

export function feeScheduleDescriptor(
  adapter: CatalogAdapter<ProcedureFeeScheduleItem>,
): CatalogDescriptor<ProcedureFeeScheduleItem> {
  return {
    title: "Fee Schedule",
    singularLabel: "procedure",
    adapter,
    createActionLabel: "+ Add a procedure this practice bills",
    fields: [
      { type: "text", key: "billingCode", label: "Billing code" },
      { type: "text", key: "modifier", label: "Modifier (recorded only)" },
      {
        type: "select",
        key: "routing",
        label: "Routing (recorded only)",
        options: [
          { value: "insurance-billable", label: "Insurance billable" },
          { value: "self-pay", label: "Self-pay" },
        ],
      },
      { type: "currency", key: "priceCents", label: "Fee", min: 0 },
    ],
    createFields: [
      { type: "text", key: "display", label: "Display name", required: true },
      {
        type: "select",
        key: "category",
        label: "Category",
        required: true,
        options: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
      },
      { type: "text", key: "billingCode", label: "Billing code" },
      { type: "text", key: "modifier", label: "Modifier (recorded only)" },
      {
        type: "select",
        key: "routing",
        label: "Routing (recorded only)",
        options: [
          { value: "insurance-billable", label: "Insurance billable" },
          { value: "self-pay", label: "Self-pay" },
        ],
      },
      { type: "currency", key: "priceCents", label: "Fee", min: 0 },
    ],
    createItem: () => ({
      id: "",
      procedureConceptKey: "",
      display: "",
      category: "procedure",
      active: true,
      version: "1",
    }),
    label: (item) => item.display,
    facts: (item, context) => [
      ...(!context?.inFamily && item.billingCode ? [item.billingCode] : []),
      ...(item.modifier ? [`Modifier ${item.modifier}`] : []),
      ...(item.routing ? [`Routing ${item.routing} — recorded only`] : []),
      item.priceCents === undefined ? "Unpriced" : money(item.priceCents),
      `Version ${item.version}`,
    ],
    chips: () => [],
    status: (item) => !item.active
      ? "Inactive"
      : item.billingCode?.trim()
        ? "Chartable"
        : "Not chartable — no code",
    summary: codedSummary,
    groupBy: {
      label: "Category",
      value: (item) => CATEGORY_LABELS[item.category ?? "procedure"],
      order: (group) => CATEGORY_ORDER.indexOf(group),
      values: CATEGORY_ORDER,
      alwaysExpanded: true,
      summary: codedSummary,
    },
    familyBy: {
      key: (item) => item.billingCode,
      update: (item, billingCode) => ({ ...item, billingCode: billingCode || undefined }),
    },
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

function codedSummary(items: readonly ProcedureFeeScheduleItem[]): string {
  const active = items.filter((item) => item.active);
  const coded = active.filter((item) => Boolean(item.billingCode?.trim())).length;
  return `${coded} of ${active.length} coded`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
