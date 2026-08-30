import { randomBytes, randomUUID } from "node:crypto";
import type { ODOSSmartClientApp } from "../../mcp/src/smart/registration/smart-client-app.js";
import {
  assertObservedProjectMatchesTarget,
  resolveConfiguredInstallationProject,
} from "../../scripts/installation-project.js";

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
  canonicalRecord: ODOSSmartClientApp,
): Promise<ClientApplicationAdapterResult> {
  return defaultAdapter().registerSmartApp(canonicalRecord);
}

export async function revokeSmartApp(canonicalRecord: ODOSSmartClientApp): Promise<void> {
  return defaultAdapter().revokeSmartApp(canonicalRecord);
}

export async function updateSmartAppMetadata(canonicalRecord: ODOSSmartClientApp): Promise<void> {
  return defaultAdapter().updateSmartAppMetadata(canonicalRecord);
}

export function medplumClientApplicationPayload(
  canonicalRecord: ODOSSmartClientApp,
): ClientApplicationAdminRequest {
  return {
    name: canonicalRecord.metadata.clientName,
    description: `ODOS local SMART app registry record ${canonicalRecord.canonicalRecord.resourceType}/${canonicalRecord.canonicalRecord.id ?? "pending"}`,
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
  readonly env?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
} = {}) {
  const env = input.env ?? process.env;
  const target = input.projectId
    ? undefined
    : resolveConfiguredInstallationProject({ env, workingDirectory: input.workingDirectory });
  const baseUrl = input.baseUrl ?? env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const projectId = input.projectId ?? target?.projectId ?? env.ODOS_MEDPLUM_PROJECT_ID;
  const accessToken = input.accessToken ?? env.MEDPLUM_ACCESS_TOKEN ?? env.ODOS_MEDPLUM_ACCESS_TOKEN;
  return {
    async registerSmartApp(canonicalRecord: ODOSSmartClientApp): Promise<ClientApplicationAdapterResult> {
      if (!projectId || !accessToken) {
        const symmetric = canonicalRecord.metadata.tokenEndpointAuthMethod.startsWith("client_secret");
        return {
          client_id: `local-smart-app-${randomUUID()}`,
          client_secret: symmetric ? randomBytes(32).toString("base64url") : undefined,
        };
      }
      const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
      const sessionResponse = await fetch(`${normalizedBaseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!sessionResponse.ok) {
        throw new Error(`Medplum SMART registry session check failed: ${sessionResponse.status} ${await sessionResponse.text()}`);
      }
      const session = (await sessionResponse.json()) as { project?: { id?: string } };
      if (!session.project?.id) {
        throw new Error("Medplum SMART registry session check returned no active project.");
      }
      assertObservedProjectMatchesTarget(projectId, session.project.id, "authenticated SMART registry project");
      const response = await fetch(`${normalizedBaseUrl}/admin/projects/${projectId}/client`, {
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
    async revokeSmartApp(_canonicalRecord: ODOSSmartClientApp): Promise<void> {
      return undefined;
    },
    async updateSmartAppMetadata(_canonicalRecord: ODOSSmartClientApp): Promise<void> {
      return undefined;
    },
  };
}

function defaultAdapter(): ReturnType<typeof createMedplumSmartAppRegistryAdapter> {
  return createMedplumSmartAppRegistryAdapter();
}
