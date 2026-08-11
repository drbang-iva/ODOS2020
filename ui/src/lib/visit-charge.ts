import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export interface VisitChargeOption {
  procedureConceptKey: string;
  display: string;
  billingCode?: string;
}

export interface VisitChargeResponse {
  options: VisitChargeOption[];
  selectedProcedureConceptKey?: string;
  proposal?: {
    id: string;
    procedureConceptKey: string;
    state: "accepted" | "removed" | "finalized";
  };
}

export interface VisitChargeApi {
  read(encounterId: string): Promise<VisitChargeResponse>;
  save(
    encounterId: string,
    procedureConceptKey: string | null,
  ): Promise<Partial<VisitChargeResponse>>;
}

export function visitChargeApi(fetchImpl: typeof fetch = fetch): VisitChargeApi {
  return {
    async read(encounterId) {
      const response = await fetchImpl(endpoint(encounterId), { headers: authHeaders() });
      const body = await response.json() as VisitChargeResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Visit charge failed: ${response.status}`);
      return body;
    },
    async save(encounterId, procedureConceptKey) {
      const response = await fetchImpl(endpoint(encounterId), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ procedureConceptKey }),
      });
      const body = await response.json() as Partial<VisitChargeResponse> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Visit charge update failed: ${response.status}`);
      return body;
    },
  };
}

function endpoint(encounterId: string): string {
  return `${clinicalGraphApiBase()}/clinical-graph/protocols/encounters/${encodeURIComponent(encounterId)}/visit-charge`;
}
