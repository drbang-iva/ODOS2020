import type { MedplumServiceAuthenticationOptions } from "./fhir-client.js";

export interface ServiceAuthEnvironment {
  MEDPLUM_CLIENT_ID?: string;
  MEDPLUM_CLIENT_SECRET?: string;
  MEDPLUM_ADMIN_EMAIL?: string;
  MEDPLUM_ADMIN_PASSWORD?: string;
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
