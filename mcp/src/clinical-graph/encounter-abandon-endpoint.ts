import { randomUUID } from "node:crypto";
import type { Bundle, Encounter } from "@medplum/fhirtypes";
import { staffHasBusinessAction } from "../authz/roles.js";
import { isMigratedEncounter } from "../clinic/patient-overview.js";
import { encounterContentByEncounter } from "./encounter-content.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { isClosedEncounter } from "./encounter-sign-gate.js";
import { assertSuccessfulTransaction, readId } from "./encounter-void-endpoint.js";
import type { MedplumClient } from "../fhir-client.js";
import type { BusinessAction, PracticeRoleId } from "../authz/roles.js";

export type EncounterAbandonFhirClient = Pick<MedplumClient, "baseUrl" | "read" | "search" | "searchUrl" | "create" | "update" | "executeTransaction">;
export interface EncounterAbandonEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    roles?: readonly PracticeRoleId[];
    businessActions?: readonly BusinessAction[];
    fhir: EncounterAbandonFhirClient;
  } | null>;
  now?: () => string;
}
export async function encounterAbandonContent(fhir: EncounterAbandonFhirClient, encounterId: string): Promise<Array<{ kind: string; count: number }>> {
  return (await encounterContentByEncounter(fhir, [encounterId])).contentByEncounter.get(encounterId)!;
}

export async function handleEncounterAbandonRequest(
  deps: EncounterAbandonEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const encounterId = readId(input.params, "encounterId");
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  let encounter: Encounter;
  try { encounter = await staff.fhir.read<Encounter>("Encounter", encounterId); }
  catch { return { status: 404, body: { error: "Encounter not found." } }; }
  if (isMigratedEncounter(encounter)) return { status: 409, body: { code: "encounter-migrated" } };
  if (isClosedEncounter(encounter)) return { status: 409, body: { code: encounter.status === "finished" ? "encounter-signed" : "encounter-closed" } };
  const content = await encounterAbandonContent(staff.fhir, encounterId);
  if (content.length) return { status: 409, body: { code: "encounter-has-content", content } };
  if (!encounter.meta?.versionId || !encounter.subject?.reference?.startsWith("Patient/")) {
    return { status: 409, body: { error: "The visit needs a patient and version before it can be abandoned." } };
  }
  const provenance = buildProvenance({
    targetReferences: [`Encounter/${encounterId}`], patientReference: encounter.subject.reference,
    recorded: deps.now?.() ?? new Date().toISOString(), activityCode: "UPDATE", activityDisplay: "Update",
    agents: [{ typeCode: "author", typeDisplay: "Author", whoDisplay: "ODOS UI abandon_encounter" }],
  });
  provenance.agent[0].onBehalfOf = { reference: staff.staffReference };
  const transaction: Bundle = {
    resourceType: "Bundle", type: "transaction", entry: [
      {
        resource: { resourceType: "Binary", contentType: "application/json-patch+json", data: Buffer.from(JSON.stringify([
          { op: "replace", path: "/status", value: "cancelled" },
          { op: "add", path: "/reasonCode", value: [{ text: "abandoned" }] },
        ])).toString("base64") },
        request: { method: "PATCH", url: `Encounter/${encounterId}`, ifMatch: `W/"${encounter.meta.versionId}"` },
      },
      { fullUrl: `urn:uuid:provenance-encounter-${randomUUID()}`, resource: provenance, request: { method: "POST", url: "Provenance" } },
    ],
  };
  const response = await staff.fhir.executeTransaction(transaction, { "X-ODOS-Source": "mcp/abandon_encounter" });
  assertSuccessfulTransaction(transaction, response);
  return { status: 200, body: { encounterId, status: "cancelled" } };
}
