import type { SmartAuthorizationState, SmartClientRegistration } from "../../smart/authorization-server.js";

export const BULK_DATA_BACKEND_SYSTEM_SCOPES = [
  bulkScope("system", "Patient", "read"),
  bulkScope("system", "Group", "read"),
  bulkScope("system", "Observation", "read"),
  bulkScope("system", "Encounter", "read"),
  bulkScope("system", "Condition", "read"),
  bulkScope("system", "Procedure", "read"),
  bulkScope("system", "MedicationStatement", "read"),
  bulkScope("system", "AllergyIntolerance", "read"),
  bulkScope("system", "Immunization", "read"),
  bulkScope("system", "Provenance", "read"),
  bulkScope("system", "DocumentReference", "read"),
  bulkScope("system", "DiagnosticReport", "read"),
] as const;

export async function assertBulkDataBackendClientRegistered(input: {
  readonly state: SmartAuthorizationState;
  readonly clientId: string;
}): Promise<SmartClientRegistration> {
  const client = await input.state.getClient(input.clientId);
  if (!client) {
    throw new Error("Bulk Data backend client is not registered in the local SMART app registry.");
  }
  if (client.clientType !== "confidential" || client.tokenEndpointAuthMethod !== "private_key_jwt") {
    throw new Error("Bulk Data backend clients must use confidential private_key_jwt registration.");
  }
  return client;
}

export function defaultBulkDataBackendScopes(): string {
  return BULK_DATA_BACKEND_SYSTEM_SCOPES.join(" ");
}

function bulkScope(prefix: "system", resourceType: string, permission: "read"): `${"system"}/${string}.${"read"}` {
  return `${prefix}/${resourceType}.${permission}`;
}
