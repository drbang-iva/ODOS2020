#!/usr/bin/env tsx
import {
  assertObservedProjectMatchesTarget,
  formatInstallationProjectTarget,
  resolveInstallationProject,
} from "./installation-project.js";
const baseUrl = (process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103").replace(/\/$/, "");
const projectId = process.env.MEDPLUM_PROJECT_ID ?? process.env.ODOS_MEDPLUM_PROJECT_ID;
const accessToken = process.env.MEDPLUM_ACCESS_TOKEN ?? process.env.ODOS_MEDPLUM_ACCESS_TOKEN;

export async function probeMedplumClientAppEndpoint(input: {
  readonly baseUrl?: string;
  readonly projectId?: string;
  readonly accessToken?: string;
} = {}): Promise<{ path: string; reachable: boolean; status?: number }> {
  const project = input.projectId ?? projectId;
  const path = project ? `/admin/projects/${project}/client` : "/admin/projects/{projectId}/client";
  const token = input.accessToken ?? accessToken;
  if (!project || !token) {
    return { path, reachable: false };
  }
  const normalizedBaseUrl = (input.baseUrl ?? baseUrl).replace(/\/$/, "");
  const sessionResponse = await fetch(`${normalizedBaseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!sessionResponse.ok) {
    throw new Error(`Medplum client-application probe session check failed: ${sessionResponse.status} ${await sessionResponse.text()}`);
  }
  const session = (await sessionResponse.json()) as { project?: { id?: string } };
  if (!session.project?.id) {
    throw new Error("Medplum client-application probe session check returned no active project.");
  }
  assertObservedProjectMatchesTarget(project, session.project.id, "authenticated client-application probe project");
  const response = await fetch(`${normalizedBaseUrl}${path}`, {
    method: "OPTIONS",
    headers: { Authorization: `Bearer ${token}` },
  });
  return { path, reachable: response.ok, status: response.status };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = resolveInstallationProject({ args: process.argv.slice(2) });
  console.log(formatInstallationProjectTarget(target));
  const result = await probeMedplumClientAppEndpoint({ projectId: target.projectId });
  console.log(JSON.stringify(result, null, 2));
}
