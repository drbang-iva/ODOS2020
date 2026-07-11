import { fhir } from "./fhir";

export const PRACTICE_ROLE_IDS = [
  "practice-admin",
  "clinician",
  "front-desk",
  "auditor",
  "aesthetics-provider",
] as const;

export type PracticeRoleId = (typeof PRACTICE_ROLE_IDS)[number];
export interface WhoAmIResponse { roles: PracticeRoleId[] }

let sessionRequest: { authorization: string; promise: Promise<WhoAmIResponse> } | undefined;

export async function fetchWhoAmI(fetchImpl: typeof fetch = fetch): Promise<WhoAmIResponse> {
  const authorization = fhir.authHeader();
  const response = await fetchImpl("/desk/whoami", {
    headers: {
      Accept: "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });
  const body = await response.json() as Partial<WhoAmIResponse> & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Practice role lookup failed with HTTP ${response.status}.`);
  const roles = PRACTICE_ROLE_IDS.filter((role) => body.roles?.includes(role));
  if (roles.length === 0) throw new Error("No recognized practice role is assigned to this account.");
  return { roles };
}

export function resolveSessionRoles(
  authorization = fhir.authHeader(),
  load: () => Promise<WhoAmIResponse> = fetchWhoAmI,
): Promise<WhoAmIResponse> {
  if (!authorization) return Promise.reject(new Error("No authenticated session is available."));
  if (!sessionRequest || sessionRequest.authorization !== authorization) {
    sessionRequest = { authorization, promise: load() };
  }
  return sessionRequest.promise;
}
