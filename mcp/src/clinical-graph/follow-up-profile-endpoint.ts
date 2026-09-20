import { z } from "zod";
import { staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { FhirFindingDefinitionStore } from "./finding-definition-store.js";
import { FhirFindingSectionGroupStore } from "./finding-section-group-store.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import { listProcedureFeeScheduleSnapshot } from "./procedure-fee-schedule.js";
import {
  BUILT_IN_PROFILE_SECTIONS, FhirFollowUpProfileStore, FOLLOW_UP_PROFILE_SEEDS, followUpProfileSchema,
  FollowUpProfileConcurrentEditError, FollowUpProfileNotFoundError,
  type FollowUpProfile, type FollowUpProfileRecord, type FollowUpProfileFhirClient, type ProfileReference, type ProfileTest,
} from "./follow-up-profile-store.js";

export interface FollowUpProfileEndpointDeps {
  authenticate(header: string | undefined): Promise<{ staffReference: string; actorRole: PracticeRoleId; fhir: FollowUpProfileFhirClient } | null>;
  serviceFhir?: FollowUpProfileFhirClient;
}
export interface FollowUpProfileChoices {
  sectionsOpen: ProfileReference[];
  testsQueuedByDefault: ProfileTest[];
  priorValuesShown: ProfileReference[];
  historyItems: string[];
  matchesDiagnosisFamilies: string[];
}
export interface FollowUpProfileCatalog {
  canWrite: boolean;
  profiles: FollowUpProfileRecord[];
  shipped: readonly FollowUpProfile[];
  choices: FollowUpProfileChoices;
}
const expectedVersion = z.string().min(1).nullable();
const writeSchema = z.object({ profile: followUpProfileSchema, expectedVersion }).strict();
const resetSchema = z.object({ action: z.literal("reset"), expectedVersion }).strict();

class ProfileReferenceValidationError extends Error {}

export async function loadFollowUpProfileChoices(fhir: FollowUpProfileFhirClient): Promise<FollowUpProfileChoices> {
  const [definitions, groups, fees, diagnoses] = await Promise.all([
    new FhirFindingDefinitionStore(fhir).list(), new FhirFindingSectionGroupStore(fhir).list(),
    listProcedureFeeScheduleSnapshot(fhir), new FhirDiagnosisCatalogStore(fhir).list(),
  ]);
  return {
    sectionsOpen: uniqueReferences([
      ...Object.entries(BUILT_IN_PROFILE_SECTIONS).map(([key, label]) => ({ key, label })),
      ...definitions.filter(row => row.active).map(row => ({ key: row.stableKey, label: row.display })),
      ...groups.filter(row => row.active).map(row => ({ key: `group:${row.groupKey}`, label: row.label })),
    ]),
    testsQueuedByDefault: fees.filter(row => row.active).map(row => ({ orderable: row.procedureConceptKey, label: row.display })),
    priorValuesShown: uniqueReferences(FOLLOW_UP_PROFILE_SEEDS.flatMap(row => row.priorValuesShown)),
    historyItems: [...new Set(FOLLOW_UP_PROFILE_SEEDS.flatMap(row => row.historyItems))],
    matchesDiagnosisFamilies: [...new Set([
      ...FOLLOW_UP_PROFILE_SEEDS.flatMap(row => row.matchesDiagnosisFamilies),
      ...diagnoses.filter(row => row.active).map(row => row.clinicalFamily),
    ])],
  };
}

export function profileWithUnavailableContext<T extends FollowUpProfile>(profile: T, choices: FollowUpProfileChoices): T {
  const sections = new Set(choices.sectionsOpen.map(row => row.key));
  const tests = new Set(choices.testsQueuedByDefault.map(row => row.orderable));
  return {
    ...profile,
    sectionsOpen: profile.sectionsOpen.map(row => sections.has(row.key) ? row : { ...row, unavailableReason: row.unavailableReason ?? "This section is no longer available in the practice catalogue." }),
    testsQueuedByDefault: profile.testsQueuedByDefault.map(row => tests.has(row.orderable) ? row : { ...row, unavailableReason: row.unavailableReason ?? "This test is no longer available in the practice catalogue." }),
  };
}

export function assertProfileReferences(profile: FollowUpProfile, choices: FollowUpProfileChoices): void {
  const sections = new Set(choices.sectionsOpen.map(row => row.key));
  const tests = new Set(choices.testsQueuedByDefault.map(row => row.orderable));
  for (const row of profile.sectionsOpen) if (!sections.has(row.key) && !row.unavailableReason) throw new ProfileReferenceValidationError(`Unavailable section ${row.key} requires a reason.`);
  for (const row of profile.testsQueuedByDefault) if (!tests.has(row.orderable) && !row.unavailableReason) throw new ProfileReferenceValidationError(`Unavailable test ${row.orderable} requires a reason.`);
  const priorValues = new Set(choices.priorValuesShown.map(row => row.key));
  for (const row of profile.priorValuesShown) if (!priorValues.has(row.key) && !row.unavailableReason) throw new ProfileReferenceValidationError(`Unknown prior-value choice ${row.key}.`);
  for (const value of profile.historyItems) if (!choices.historyItems.includes(value)) throw new ProfileReferenceValidationError(`Unknown history question ${value}.`);
  for (const value of profile.matchesDiagnosisFamilies) if (!choices.matchesDiagnosisFamilies.includes(value)) throw new ProfileReferenceValidationError(`Unknown diagnosis family ${value}.`);
}

export async function handleFollowUpProfileCatalogRequest(deps: FollowUpProfileEndpointDeps, input: { authHeader: string | undefined }): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  const canWrite = staffHasBusinessAction(staff, "finding-definitions.write");
  if (!canWrite && !staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read or finding-definitions.write required." } };
  const fhir = deps.serviceFhir ?? staff.fhir;
  const choices = await loadFollowUpProfileChoices(fhir);
  const profiles = (await new FhirFollowUpProfileStore(fhir).list()).map(profile => profileWithUnavailableContext(profile, choices));
  return { status: 200, body: { canWrite, profiles, shipped: FOLLOW_UP_PROFILE_SEEDS, choices } satisfies FollowUpProfileCatalog };
}

export async function handleFollowUpProfileWriteRequest(deps: FollowUpProfileEndpointDeps, input: { authHeader: string | undefined; profileKey?: string; body: unknown }): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "finding-definitions.write")) return { status: 403, body: { error: "finding-definitions.write required." } };
  const parsed = z.union([writeSchema, resetSchema]).safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: "Invalid profile request or unknown field." } };
  const profile = "profile" in parsed.data ? parsed.data.profile : FOLLOW_UP_PROFILE_SEEDS.find(row => row.profileKey === input.profileKey);
  if (!profile) return { status: 404, body: { error: "No shipped profile to reset." } };
  if (input.profileKey && input.profileKey !== profile.profileKey) return { status: 400, body: { error: "Profile key is immutable." } };
  try {
    const fhir = deps.serviceFhir ?? staff.fhir;
    const choices = await loadFollowUpProfileChoices(fhir);
    assertProfileReferences(profile, choices);
    const store = new FhirFollowUpProfileStore(fhir);
    const result = input.profileKey
      ? await store.save(profile, parsed.data.expectedVersion)
      : await store.create(profile, parsed.data.expectedVersion);
    return { status: input.profileKey ? 200 : 201, body: { profile: { ...result.profile, versionId: result.versionId } } };
  } catch (error) {
    if (error instanceof ProfileReferenceValidationError) return { status: 400, body: { error: error.message } };
    if (error instanceof FollowUpProfileConcurrentEditError) return { status: error.status, body: { error: error.message, code: error.code } };
    if (error instanceof FollowUpProfileNotFoundError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

function uniqueReferences(rows: readonly ProfileReference[]): ProfileReference[] { return [...new Map(rows.map(row => [row.key, row])).values()]; }
