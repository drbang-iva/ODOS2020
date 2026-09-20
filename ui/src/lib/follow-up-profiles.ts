import { authHeaders, clinicalGraphApiBase, clinicalGraphResponseError } from "./clinical-graph-client";
export interface ProfileReference { key: string; label?: string; unavailableReason?: string }
export interface ProfileTest {
  orderable: string; label: string; focus?: string; unavailableReason?: string;
  resultSection?: ProfileReference;
  choice?: { name: string; options: Array<{ code: string; unavailableReason?: string }> };
}
export interface FollowUpProfile {
  profileKey: string; label: string; version: number; active: boolean;
  matchesDiagnosisFamilies: string[]; episodeType?: string;
  sectionsOpen: ProfileReference[]; testsQueuedByDefault: ProfileTest[]; priorValuesShown: ProfileReference[];
  historyTemplate: ProfileReference; historyItems: string[]; source: string;
}
export type FollowUpProfileRecord = FollowUpProfile & { versionId: string | null };
export interface FollowUpProfileCatalog {
  canWrite: boolean; profiles: FollowUpProfileRecord[]; shipped: readonly FollowUpProfile[];
  choices: Pick<FollowUpProfile, "sectionsOpen" | "testsQueuedByDefault" | "priorValuesShown" | "historyItems" | "matchesDiagnosisFamilies">;
}

export async function loadFollowUpProfiles(): Promise<FollowUpProfileCatalog> {
  const response = await fetch(`${clinicalGraphApiBase()}/follow-up-profiles`, { headers: authHeaders() });
  const body = await response.json();
  if (!response.ok) throw clinicalGraphResponseError(response, body, "Follow-up profiles could not be loaded.");
  return body;
}

export async function writeFollowUpProfile(profileKey: string | undefined, value: { profile: FollowUpProfile; expectedVersion: string | null } | { action: "reset"; expectedVersion: string | null }): Promise<void> {
  const response = await fetch(`${clinicalGraphApiBase()}/follow-up-profiles${profileKey ? `/${encodeURIComponent(profileKey)}` : ""}`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  const body = await response.json();
  if (!response.ok) throw clinicalGraphResponseError(response, body, "Follow-up profile could not be saved.");
}
