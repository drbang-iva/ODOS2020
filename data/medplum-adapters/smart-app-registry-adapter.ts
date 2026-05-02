import { randomBytes, randomUUID } from "node:crypto";
import type { OSODSmartClientApp } from "../../mcp/src/smart/registration/smart-client-app.js";

export interface ClientApplicationAdapterResult {
  readonly client_id: string;
  readonly client_secret?: string;
}

export interface ClientApplicationAdminRequest {
  readonly name: string;
  readonly description: string;
  readonly redirectUris: readonly string[];
  readonly redirectUri?: string;
  readonly launchUri?: string;
  readonly jwksUri?: string;
  readonly allowedOrigin: readonly string[];
  readonly defaultScope: readonly string[];
}

export async function registerSmartApp(
  canonicalRecord: OSODSmartClientApp,
): Promise<ClientApplicationAdapterResult> {
  return defaultAdapter().registerSmartApp(canonicalRecord);
}

export async function revokeSmartApp(canonicalRecord: OSODSmartClientApp): Promise<void> {
  return defaultAdapter().revokeSmartApp(canonicalRecord);
}

export async function updateSmartAppMetadata(canonicalRecord: OSODSmartClientApp): Promise<void> {
  return defaultAdapter().updateSmartAppMetadata(canonicalRecord);
}

export function medplumClientApplicationPayload(
  canonicalRecord: OSODSmartClientApp,
): ClientApplicationAdminRequest {
  return {
    name: canonicalRecord.metadata.clientName,
    description: `OSOD local SMART app registry record ${canonicalRecord.canonicalRecord.resourceType}/${canonicalRecord.canonicalRecord.id ?? "pending"}`,
    redirectUris: canonicalRecord.metadata.redirectUris,
    redirectUri: canonicalRecord.metadata.redirectUris[0],
    launchUri: canonicalRecord.metadata.launchUri,
    jwksUri: canonicalRecord.metadata.jwksUri,
    allowedOrigin: canonicalRecord.metadata.allowedOrigin,
    defaultScope: [canonicalRecord.metadata.defaultScope],
  };
}

export function createMedplumSmartAppRegistryAdapter(input: {
  readonly baseUrl?: string;
  readonly projectId?: string;
  readonly accessToken?: string;
} = {}) {
  const baseUrl = input.baseUrl ?? process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const projectId = input.projectId ?? process.env.MEDPLUM_PROJECT_ID ?? process.env.OSOD_MEDPLUM_PROJECT_ID;
  const accessToken = input.accessToken ?? process.env.MEDPLUM_ACCESS_TOKEN ?? process.env.OSOD_MEDPLUM_ACCESS_TOKEN;
  return {
    async registerSmartApp(canonicalRecord: OSODSmartClientApp): Promise<ClientApplicationAdapterResult> {
      if (!projectId || !accessToken) {
        const symmetric = canonicalRecord.metadata.tokenEndpointAuthMethod.startsWith("client_secret");
        return {
          client_id: `local-smart-app-${randomUUID()}`,
          client_secret: symmetric ? randomBytes(32).toString("base64url") : undefined,
        };
      }
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/admin/projects/${projectId}/client`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(medplumClientApplicationPayload(canonicalRecord)),
      });
      if (!response.ok) {
        throw new Error(`Medplum ClientApplication adapter failed: ${response.status} ${await response.text()}`);
      }
      const created = (await response.json()) as { id?: string; secret?: string };
      return {
        client_id: created.id ?? `local-smart-app-${randomUUID()}`,
        client_secret: created.secret,
      };
    },
    async revokeSmartApp(_canonicalRecord: OSODSmartClientApp): Promise<void> {
      return undefined;
    },
    async updateSmartAppMetadata(_canonicalRecord: OSODSmartClientApp): Promise<void> {
      return undefined;
    },
  };
}

function defaultAdapter(): ReturnType<typeof createMedplumSmartAppRegistryAdapter> {
  return createMedplumSmartAppRegistryAdapter();
}
