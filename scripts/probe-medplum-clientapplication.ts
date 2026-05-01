#!/usr/bin/env tsx
const baseUrl = (process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103").replace(/\/$/, "");
const projectId = process.env.MEDPLUM_PROJECT_ID ?? process.env.OSOD_MEDPLUM_PROJECT_ID;
const accessToken = process.env.MEDPLUM_ACCESS_TOKEN ?? process.env.OSOD_MEDPLUM_ACCESS_TOKEN;

export async function probeMedplumClientAppEndpoint(input: {
  readonly baseUrl?: string;
  readonly projectId?: string;
  readonly accessToken?: string;
} = {}): Promise<{ path: string; reachable: boolean; status?: number }> {
  const project = input.projectId ?? projectId;
  const path = project ? `/admin/projects/${project}/client` : "/admin/projects/{projectId}/client";
  if (!project || !(input.accessToken ?? accessToken)) {
    return { path, reachable: false };
  }
  const response = await fetch(`${(input.baseUrl ?? baseUrl).replace(/\/$/, "")}${path}`, {
    method: "OPTIONS",
    headers: { Authorization: `Bearer ${input.accessToken ?? accessToken}` },
  });
  return { path, reachable: response.ok, status: response.status };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await probeMedplumClientAppEndpoint();
  console.log(JSON.stringify(result, null, 2));
}
