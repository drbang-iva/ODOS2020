import type { LiveAuditRuntimeOptions } from "./authz/liveAudit.js";
import type {
  MedplumClient,
  MedplumServiceAuthenticationOptions,
} from "./fhir-client.js";

export type ServiceAuthenticationClient = Pick<
  MedplumClient,
  "login" | "loginWithClientCredentials"
>;

export type ServiceAuthenticator = (
  client: ServiceAuthenticationClient,
  options: MedplumServiceAuthenticationOptions,
) => Promise<"client-credentials" | "password">;

export interface ServiceAuthEnvironment {
  MEDPLUM_CLIENT_ID?: string;
  MEDPLUM_CLIENT_SECRET?: string;
  MEDPLUM_ADMIN_EMAIL?: string;
  MEDPLUM_ADMIN_PASSWORD?: string;
}

export interface ServiceAuditEnvironment {
  ODOS_POSTGRES_URL?: string;
  ODOS_AUDIT_MEDPLUM_ACCESS_TOKEN?: string;
  ODOS_AUDIT_MEDPLUM_EMAIL?: string;
  ODOS_AUDIT_MEDPLUM_PASSWORD?: string;
  ODOS_AUDIT_DISABLED?: string;
  ODOS_AUDIT_PROJECTION_WORKER_MS?: string;
}

export interface McpServiceAuthentication {
  options: MedplumServiceAuthenticationOptions;
  authenticate(client: ServiceAuthenticationClient): Promise<"client-credentials" | "password">;
}

export interface McpAuditRuntimeCompositionOptions {
  env: ServiceAuditEnvironment;
  baseUrl: string;
  accessToken?: string;
  projectId: string;
  serviceAuthOptions: MedplumServiceAuthenticationOptions;
}

export function resolveServiceAuthOptions(
  env: ServiceAuthEnvironment,
  projectId: string,
): MedplumServiceAuthenticationOptions {
  return {
    projectId,
    clientId: env.MEDPLUM_CLIENT_ID,
    clientSecret: env.MEDPLUM_CLIENT_SECRET,
    email: env.MEDPLUM_ADMIN_EMAIL,
    password: env.MEDPLUM_ADMIN_PASSWORD,
  };
}

export function createMcpServiceAuthentication(
  env: ServiceAuthEnvironment,
  projectId: string,
  authenticateMedplumService: ServiceAuthenticator,
): McpServiceAuthentication {
  const SERVICE_AUTH_OPTIONS = resolveServiceAuthOptions(env, projectId);
  return {
    options: SERVICE_AUTH_OPTIONS,
    async authenticate(fhir) {
      const mode = await authenticateMedplumService(fhir, SERVICE_AUTH_OPTIONS);
      return mode;
    },
  };
}

export function createMcpAuditRuntime<T>(
  input: McpAuditRuntimeCompositionOptions,
  createLiveOdosAuditRuntime: (options: LiveAuditRuntimeOptions) => T,
): T {
  return createLiveOdosAuditRuntime({
    postgresUrl: input.env.ODOS_POSTGRES_URL,
    medplumBaseUrl: input.baseUrl,
    medplumAccessToken: input.env.ODOS_AUDIT_MEDPLUM_ACCESS_TOKEN ?? input.accessToken,
    medplumProjectId: input.projectId,
    medplumClientId: input.serviceAuthOptions.clientId,
    medplumClientSecret: input.serviceAuthOptions.clientSecret,
    medplumEmail: input.env.ODOS_AUDIT_MEDPLUM_EMAIL ?? input.serviceAuthOptions.email,
    medplumPassword: input.env.ODOS_AUDIT_MEDPLUM_PASSWORD ?? input.serviceAuthOptions.password,
    disabled: input.env.ODOS_AUDIT_DISABLED === "1",
    projectionWorkerIntervalMs: Number(input.env.ODOS_AUDIT_PROJECTION_WORKER_MS ?? 60_000),
  });
}
