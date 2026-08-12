import type { CatalogAdapter } from "./catalog-adapter";
import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export interface ProcedureFeeScheduleItem {
  id: string;
  procedureConceptKey: string;
  display: string;
  active: boolean;
  billingCode?: string;
  category?: "exam" | "refraction" | "cl-fitting" | "procedure";
  modifier?: string;
  routing?: "insurance-billable" | "self-pay";
  priceCents?: number;
  version: string;
}

export function procedureFeeScheduleAdapter(
  fetchImpl: typeof fetch = fetch,
): CatalogAdapter<ProcedureFeeScheduleItem> {
  return {
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    async list() {
      const response = await fetchImpl(`${clinicalGraphApiBase()}/clinical-graph/fee-schedule`, {
        headers: authHeaders(),
      });
      const body = await response.json() as { items?: ProcedureFeeScheduleItem[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Fee schedule failed: ${response.status}`);
      return body.items ?? [];
    },
    async save(item) {
      if (!item.procedureConceptKey) {
        return createItem(item, fetchImpl);
      }
      return mutate(item, {
        action: "save",
        ...(Object.hasOwn(item, "billingCode") ? { billingCode: item.billingCode?.trim() || null } : {}),
        ...(Object.hasOwn(item, "modifier") ? { modifier: item.modifier?.trim() || null } : {}),
        ...(Object.hasOwn(item, "routing") ? { routing: item.routing } : {}),
        priceCents: item.priceCents ?? null,
        active: item.active,
      }, fetchImpl);
    },
    async deactivate(item) {
      return mutate(item, { action: "deactivate" }, fetchImpl);
    },
  };
}

async function createItem(
  item: ProcedureFeeScheduleItem,
  fetchImpl: typeof fetch,
): Promise<ProcedureFeeScheduleItem> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/clinical-graph/fee-schedule`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create",
      display: item.display,
      category: item.category,
      ...(item.billingCode?.trim() ? { billingCode: item.billingCode.trim() } : {}),
      ...(item.modifier?.trim() ? { modifier: item.modifier.trim() } : {}),
      ...(item.routing ? { routing: item.routing } : {}),
      priceCents: item.priceCents ?? null,
      active: item.active,
    }),
  });
  const payload = await response.json() as { item?: ProcedureFeeScheduleItem; error?: string };
  if (!response.ok || !payload.item) {
    throw new Error(payload.error ?? `Fee schedule creation failed: ${response.status}`);
  }
  return payload.item;
}

async function mutate(
  item: ProcedureFeeScheduleItem,
  body: {
    action: "save";
    billingCode?: string | null;
    modifier?: string | null;
    routing?: "insurance-billable" | "self-pay";
    priceCents: number | null;
    active: boolean;
  } | { action: "deactivate" },
  fetchImpl: typeof fetch,
): Promise<ProcedureFeeScheduleItem> {
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/clinical-graph/fee-schedule/${encodeURIComponent(item.procedureConceptKey)}`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const payload = await response.json() as { item?: ProcedureFeeScheduleItem; error?: string };
  if (!response.ok || !payload.item) {
    throw new Error(payload.error ?? `Fee schedule update failed: ${response.status}`);
  }
  return payload.item;
}
