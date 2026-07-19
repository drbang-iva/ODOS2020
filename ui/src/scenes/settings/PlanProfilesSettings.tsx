import { useMemo } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import { fhir } from "../../lib/fhir";
import {
  buildPlanProfileResource,
  planProfileAdapter,
  type PlanProfileItem,
} from "../../lib/plan-profile-catalog";
import {
  CatalogScene,
  CatalogSection,
  type CatalogDescriptor,
} from "./CatalogEditor";

export function PlanProfilesSettings({ canWrite }: { canWrite: boolean }) {
  const adapter = useMemo(() => planProfileAdapter(fhir), []);
  const descriptor = useMemo(() => planProfileDescriptor(adapter), [adapter]);

  return (
    <CatalogScene title="Plan profiles" canWrite={canWrite}>
      {!canWrite && (
        <div className="border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
          Read only. Practice-admin access is required to edit plan profiles.
        </div>
      )}
      <CatalogSection
        descriptor={descriptor}
        canWrite={canWrite}
        initialState={canWrite ? undefined : { items: [] }}
      />
    </CatalogScene>
  );
}

export function planProfileDescriptor(
  adapter: CatalogAdapter<PlanProfileItem>,
): CatalogDescriptor<PlanProfileItem> {
  return {
    title: "Plan profiles",
    singularLabel: "plan profile",
    adapter,
    fields: [
      {
        type: "text",
        key: "planKey",
        label: "Plan key",
        required: true,
        unique: true,
      },
      {
        type: "text",
        key: "displayName",
        label: "Display name",
        required: true,
      },
      {
        type: "currency",
        key: "dispensingFeeCents",
        label: "Dispensing fee",
        min: 0,
      },
      {
        type: "currency",
        key: "frameAllowanceCents",
        label: "Frame allowance",
        min: 0,
      },
      {
        type: "currency",
        key: "lensBaseReimbursementCents",
        label: "Lens base reimbursement",
        min: 0,
      },
      {
        type: "currency",
        key: "contactLensPerBoxCents",
        label: "Contact lens per box",
        min: 0,
      },
      {
        type: "toggle",
        key: "active",
        label: "Active",
      },
    ],
    createItem: () => ({
      id: `plan-profile-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
      planKey: "",
      displayName: "",
      active: true,
    }),
    validateItem: (item) => {
      buildPlanProfileResource(item);
    },
    label: (item) => item.displayName,
    chips: (item) => [item.planKey],
    facts: (item) => [
      moneyFact(item.dispensingFeeCents, "dispensing"),
      moneyFact(item.frameAllowanceCents, "frame"),
      moneyFact(item.lensBaseReimbursementCents, "lens base"),
      moneyFact(item.contactLensPerBoxCents, "contact lens / box"),
    ],
    groupBy: {
      label: "Status",
      value: (item) => item.active ? "Active profiles" : "Inactive profiles",
      order: (group) => group === "Active profiles" ? 0 : 1,
    },
    listGrammar: {
      searchPlaceholder: "Search plan profiles",
      searchText: (item) => `${item.planKey} ${item.displayName}`,
      deactivateConsequence: (item) =>
        `${item.displayName || "This plan profile"} remains in historical settings and stops feeding new margin estimates.`,
    },
  };
}

function moneyFact(cents: number | undefined, label: string): string {
  return cents === undefined ? `${label} unpriced` : `${money(cents)} ${label}`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
