import type { CatalogAdapter } from "./catalog-adapter";
import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export interface ProcedureFeeScheduleItem {
  id: string;
  procedureConceptKey: string;
  display: string;
  active: boolean;
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
      return mutate(item, {
        action: "save",
        priceCents: item.priceCents ?? null,
        active: item.active,
      }, fetchImpl);
    },
    async deactivate(item) {
      return mutate(item, { action: "deactivate" }, fetchImpl);
    },
  };
}

async function mutate(
  item: ProcedureFeeScheduleItem,
  body: { action: "save"; priceCents: number | null; active: boolean } | { action: "deactivate" },
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
