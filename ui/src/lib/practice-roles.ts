import { fhir } from "./fhir";

export const PRACTICE_ROLE_IDS = ["provider", "staff", "admin"] as const;

export type PracticeRoleId = (typeof PRACTICE_ROLE_IDS)[number];
export const PRACTICE_ROLE_LABELS: Record<PracticeRoleId, string> = {
  provider: "Provider",
  staff: "Staff",
  admin: "Admin / Manager",
};
export interface WhoAmIResponse { roles: PracticeRoleId[] }

export function canStartAppointmentChart(roles: readonly PracticeRoleId[]): boolean {
  return roles.includes("provider");
}

let sessionRequest: { authorization: string; promise: Promise<WhoAmIResponse> } | undefined;

export async function fetchWhoAmI(fetchImpl: typeof fetch = fetch): Promise<WhoAmIResponse> {
  const authorization = fhir.authHeader();
  const response = await fetchImpl("/desk/whoami", {
    headers: {
      Accept: "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });
  const body = await response.json().catch(() => undefined) as (Partial<WhoAmIResponse> & { error?: string; detail?: string }) | undefined;
  if (!response.ok) throw new Error(body?.detail ?? body?.error ?? `Practice role lookup failed with HTTP ${response.status}.`);
  if (!body) throw new Error(`Practice role lookup failed with HTTP ${response.status}.`);
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
