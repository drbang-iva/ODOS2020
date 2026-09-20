import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic } from "@medplum/fhirtypes";
import { handleFollowUpProfileCatalogRequest, handleFollowUpProfileWriteRequest } from "../src/clinical-graph/follow-up-profile-endpoint.js";
import { FOLLOW_UP_PROFILE_SEEDS, type FollowUpProfileFhirClient } from "../src/clinical-graph/follow-up-profile-store.js";
import type { PracticeRoleId } from "../src/authz/roles.js";

function fixture(role: PracticeRoleId = "admin") {
  const rows: Basic[] = [];
  const writes: unknown[] = [];
  const fhir = {
    baseUrl: "http://synthetic.test/fhir/R4",
    async search(_type: string, params: Record<string, string> = {}) {
      return { resourceType: "Bundle", type: "searchset", entry: rows.filter(r => r.code.coding?.some(c => `${c.system}|${c.code}` === params.code)).map(resource => ({ resource })) };
    },
    async create(resource: Basic, headers: unknown) { writes.push(headers); const saved = { ...resource, id: "profile-1", meta: { versionId: "1" } }; rows.push(saved); return saved; },
  } as unknown as FollowUpProfileFhirClient;
  return { deps: { authenticate: async () => ({ actorRole: role, staffReference: "Practitioner/synthetic", fhir }), serviceFhir: fhir }, writes };
}
const body = () => ({ profile: { ...structuredClone(FOLLOW_UP_PROFILE_SEEDS[0]!), profileKey: "practice-copy" }, expectedVersion: null });

test("G3 strict request rejects root and nested MDM and every unknown field", async () => {
  const { deps, writes } = fixture();
  for (const input of [{ ...body(), mdmSuggestion: "stable" }, { ...body(), profile: { ...body().profile, mdmSuggestion: "stable" } }, { ...body(), unknownField: true }]) {
    assert.equal((await handleFollowUpProfileWriteRequest(deps, { authHeader: "synthetic", body: input })).status, 400);
  }
  assert.equal(writes.length, 0);
});

test("G6 chart-read staff can read but cannot create or update", async () => {
  const { deps, writes } = fixture("staff");
  const catalog = await handleFollowUpProfileCatalogRequest(deps, { authHeader: "synthetic" });
  assert.equal(catalog.status, 200);
  assert.equal((catalog.body as { canWrite: boolean }).canWrite, false);
  assert.equal((await handleFollowUpProfileWriteRequest(deps, { authHeader: "synthetic", body: body() })).status, 403);
  assert.equal((await handleFollowUpProfileWriteRequest(deps, { authHeader: "synthetic", profileKey: "glaucoma", body: { profile: FOLLOW_UP_PROFILE_SEEDS[0], expectedVersion: null } })).status, 403);
  assert.equal(writes.length, 0);
});

test("G7 practice cannot publish a missing section or orderable without a reason", async () => {
  for (const field of ["sectionsOpen", "testsQueuedByDefault"] as const) {
    const { deps, writes } = fixture();
    const input = body();
    if (field === "sectionsOpen") input.profile.sectionsOpen.push({ key: "fictional-section" });
    else input.profile.testsQueuedByDefault.push({ orderable: "fictional-orderable", label: "Synthetic missing test" });
    const result = await handleFollowUpProfileWriteRequest(deps, { authHeader: "synthetic", body: input });
    assert.equal(result.status, 400);
    assert.match(JSON.stringify(result.body), /fictional/);
    assert.equal(writes.length, 0);
  }
});

test("explicit unavailable references persist and retain their exact keys", async () => {
  const { deps } = fixture();
  const input = body();
  input.profile.testsQueuedByDefault.push({ orderable: "synthetic-absent", label: "Unavailable test", unavailableReason: "Synthetic known absence" });
  const result = await handleFollowUpProfileWriteRequest(deps, { authHeader: "synthetic", body: input });
  assert.equal(result.status, 201);
  assert.match(JSON.stringify(result.body), /synthetic-absent/);
});

test("profile history and assessment cannot be removed", async () => {
  const { deps, writes } = fixture();
  const input = body();
  input.profile.sectionsOpen = input.profile.sectionsOpen.filter(row => row.key !== "hpi");
  assert.equal((await handleFollowUpProfileWriteRequest(deps, { authHeader: "synthetic", body: input })).status, 400);
  assert.equal(writes.length, 0);
});

test("retired references retain their keys and show unavailable context", async () => {
  const { profileWithUnavailableContext } = await import("../src/clinical-graph/follow-up-profile-endpoint.js");
  const original = body().profile;
  const choices = { sectionsOpen: [], testsQueuedByDefault: [], priorValuesShown: original.priorValuesShown, historyItems: original.historyItems, matchesDiagnosisFamilies: original.matchesDiagnosisFamilies };
  const display = profileWithUnavailableContext(original, choices);
  assert.deepEqual(display.sectionsOpen.map(row => row.key), original.sectionsOpen.map(row => row.key));
  assert.deepEqual(display.testsQueuedByDefault.map(row => row.orderable), original.testsQueuedByDefault.map(row => row.orderable));
  assert.ok(display.sectionsOpen.every(row => row.unavailableReason));
  assert.ok(display.testsQueuedByDefault.every(row => row.unavailableReason));
  assert.equal(original.sectionsOpen[0]!.unavailableReason, undefined);
});
