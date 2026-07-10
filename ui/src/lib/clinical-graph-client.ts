import { fhir } from "./fhir";

export function authHeaders(): Record<string, string> {
  const authorization = fhir.authHeader();
  return authorization ? { Authorization: authorization } : {};
}

export function clinicalGraphApiBase(): string {
  return import.meta.env.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}
