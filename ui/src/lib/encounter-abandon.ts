import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

const CONTENT_LABELS: Record<string, string> = {
  Observation: "findings", Condition: "diagnoses", Procedure: "procedures", DiagnosticReport: "reports",
  DocumentReference: "documents", Media: "images", QuestionnaireResponse: "questionnaires",
  ServiceRequest: "orders", MedicationRequest: "prescriptions", MedicationStatement: "medication history",
  MedicationAdministration: "administered medications", DeviceRequest: "device orders", CarePlan: "care plans",
  ChargeItem: "charges", ChargeProposal: "charge proposals", PlanActionInstance: "plan orders",
};

export async function abandonEncounter(encounterId: string): Promise<void> {
  const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/abandon`, {
    method: "POST", headers: authHeaders(),
  });
  const body = await response.json().catch(() => ({})) as { code?: string; error?: string; content?: Array<{ kind: string; count: number }> };
  if (response.status === 409 && body.code === "encounter-has-content") {
    const kinds = Array.isArray(body.content) ? body.content.map(row => `${CONTENT_LABELS[row.kind] ?? "clinical content"} (${row.count})`).join(", ") : "clinical content";
    throw new Error(`This visit has ${kinds}. Remove them first or sign the visit.`);
  }
  if (!response.ok) {
    const reasons: Record<string, string> = {
      "encounter-signed": "Signed visits cannot be abandoned.",
      "encounter-closed": "This visit is already closed.",
      "encounter-migrated": "Migrated historical visits are read-only.",
    };
    throw new Error(reasons[body.code ?? ""] ?? body.error ?? `Could not abandon the visit (${response.status}).`);
  }
}
