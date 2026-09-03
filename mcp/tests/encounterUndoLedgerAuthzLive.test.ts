import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  AccessPolicy,
  Basic,
  Encounter,
  Observation,
  Patient,
  Practitioner,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { ODOS_PRACTICE_ROLE_SYSTEM, type PracticeRoleId } from "../src/authz/roles.js";
import {
  handleEncounterUndoLedgerRequest,
  handleEncounterUndoRequest,
  type EncounterUndoResponse,
} from "../src/clinical-graph/encounter-undo-endpoint.js";
import {
  ENCOUNTER_UNDO_LEDGER_CODE,
  ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM,
  FhirEncounterUndoLedgerStore,
  type EncounterUndoLedger,
} from "../src/clinical-graph/encounter-undo-ledger-store.js";
import {
  handleEncounterVoidRequest,
  type EncounterVoidEndpointDeps,
  type EncounterVoidResponse,
} from "../src/clinical-graph/encounter-void-endpoint.js";
import { createStaffRouteFhirClient } from "../src/fhir-client.js";
import { searchAll } from "../src/fhir-search.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";
import { createAuthenticatedFhirClient, requireMedplumAdmin } from "./integration-helpers.js";
import { cleanupReferences, createRoleClient } from "./liveRoleClient.js";

/**
 * The encounter Undo ledger, proven against the AccessPolicy Medplum actually enforces.
 *
 * Every clear writes the encounter's Undo ledger — a `Basic` coded
 * `odos-encounter-undo-ledger` — in the void's own transaction. From the day the ledger shipped
 * until decision 2026-09-02 (undo ledger never granted), no practice-role AccessPolicy granted
 * that code: the ledger POST was refused 403 on every clear, every tier, every chart, and zero
 * ledger rows ever existed. It hid because the in-memory fake behind every void/undo test does
 * not evaluate AccessPolicy criteria, and because on this non-atomic stack the Observation writes
 * ahead of the ledger entry applied anyway, so the clear looked fine.
 *
 * This lane therefore does NOT read `roles.ts` and assert the code is in a list — that would be
 * the same fact written in a second file. Each role charts one preliminary VA value on its own
 * visit with its own real client_credentials token bound to the synced canonical policy, clears
 * it through the real void handler, and the test asserts on running Medplum that the ledger row
 * is persisted and reads back under that same role — Provider first, then Staff (staff may
 * clear, so staff must be able to write the slot). Remove the grant from `roles.ts`, re-sync the
 * policy, and this goes red with the 403 the operator saw.
 *
 * Runs blocking in CI against the ephemeral contract project after the canonical policies are
 * repaired and synced; skips when no Medplum admin credentials are configured. Like the other
 * live lane it borrows the synthetic Patient the contract smoke lane seeds, because after the
 * repair step the admin session is itself policy-bound and cannot register a Patient.
 */

const baseUrl = process.env.MEDPLUM_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8103";
const CLEAR_ROLES = ["provider", "staff"] as const satisfies readonly PracticeRoleId[];
const VA_SECTION_KEY = "va";

test("a clear persists the encounter undo ledger under the synced Provider and Staff policies on running Medplum", async (t) => {
  const credentials = requireMedplumAdmin(t, "encounterUndoLedgerAuthzLive");
  if (!credentials) {
    return;
  }
  const { fhir: adminFhir, accessToken: adminToken } = await createAuthenticatedFhirClient({
    baseUrl,
    email: credentials.email,
    password: credentials.password,
  });
  const meResponse = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(meResponse.status, 200, "GET /auth/me for the seeding admin.");
  const me = await meResponse.json() as { project?: { id?: string }; profile?: Resource };
  assert.ok(me.project?.id, "Authenticated Medplum session has no active project id.");
  // CI exports the ephemeral contract project as MEDPLUM_PROJECT_ID; otherwise the session's own.
  const projectId = process.env.MEDPLUM_PROJECT_ID?.trim() || me.project.id;
  assert.equal(me.profile?.resourceType, "Practitioner", "Live authorization seeder profile must be a Practitioner.");
  assert.ok(me.profile.id, "Live authorization seeder Practitioner requires an id.");
  const practitionerReference = `Practitioner/${(me.profile as Practitioner).id}`;

  const runId = randomUUID();
  const cleanup: string[] = [];
  const track = <T extends Resource>(resource: T): T => {
    assert.ok(resource.id, `${resource.resourceType} create response requires an id.`);
    cleanup.push(`${resource.resourceType}/${resource.id}`);
    return resource;
  };

  try {
    const policies = await searchAll<AccessPolicy>(adminFhir, "AccessPolicy", { _project: projectId, _count: "1000" });
    const rolePolicies = new Map<PracticeRoleId, AccessPolicy>();
    for (const roleId of CLEAR_ROLES) {
      const matches = policies.filter((policy) => {
        const roleTags = policy.meta?.tag?.filter((tag) => tag.system === ODOS_PRACTICE_ROLE_SYSTEM) ?? [];
        return roleTags.length === 1 && roleTags[0]?.code === roleId;
      });
      assert.equal(matches.length, 1, `Expected one synced canonical ${roleId} AccessPolicy in Project/${projectId}.`);
      rolePolicies.set(roleId, matches[0]!);
    }
    const patient = (await searchAll<Patient>(adminFhir, "Patient", { _count: "1000" }))
      .filter((candidate) => candidate.name?.some((name) => name.family?.startsWith("ContractSearch")))
      .sort((left, right) => (left.meta?.lastUpdated ?? "").localeCompare(right.meta?.lastUpdated ?? ""))
      .at(-1);
    assert.ok(patient?.id, "Live authorization lane requires the synthetic Patient seeded by its contract smoke lane.");
    const patientReference = `Patient/${patient.id}`;
    const encounterReferences: string[] = [];

    for (const roleId of CLEAR_ROLES) {
      await t.test(`${roleId} clears one VA value and the ledger slot persists and reads back`, async (roleTest) => {
        // --- The role's own principal: a real token, the real synced policy ------------------
        const policy = rolePolicies.get(roleId)!;
        const { token } = await createRoleClient({
          baseUrl,
          roleId,
          policyReference: `AccessPolicy/${policy.id}`,
          patientReference,
          practitionerReference,
          projectId,
          runId: `${roleId}-${runId}`,
          adminToken,
          track,
        });
        const roleFhir = createStaffRouteFhirClient({
          baseUrl,
          accessToken: token,
          staffReference: practitionerReference,
          actorRole: roleId,
          audit: TEST_FHIR_AUDIT_RECORDER,
        });
        const authHeader = `Bearer ${token}`;
        const deps: EncounterVoidEndpointDeps = {
          authenticate: async (header) => header === authHeader
            ? { staffReference: practitionerReference, actorRole: roleId, fhir: roleFhir }
            : null,
        };

        // --- The role charts: one in-progress visit with one preliminary VA value -----------
        const encounter = track(await roleFhir.create<Encounter>({
          resourceType: "Encounter",
          status: "in-progress",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
          subject: { reference: patientReference },
          participant: [{ individual: { reference: practitionerReference } }],
        }));
        const encounterId = encounter.id!;
        encounterReferences.push(`Encounter/${encounterId}`);
        const observation = track(await roleFhir.create<Observation>({
          resourceType: "Observation",
          status: "preliminary",
          code: {
            coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "VISUAL_ACUITY", display: "Visual acuity" }],
            text: `Synthetic VA ${roleId} ${runId}`,
          },
          subject: { reference: patientReference },
          encounter: { reference: `Encounter/${encounterId}` },
          valueString: "20/20",
        }));
        const observationReference = `Observation/${observation.id}`;
        const params = { encounterId };

        // --- The clear: the same handler, the same transaction, the operator's per-value × ----
        const voided = await handleEncounterVoidRequest(deps, {
          authHeader,
          params,
          body: { scope: "observation", observationReference },
        });
        assert.equal(voided.status, 200, `${roleId} clear: ${JSON.stringify(voided.body)}`);
        const voidBody = voided.body as EncounterVoidResponse;
        assert.deepEqual(voidBody.voided, [observationReference]);
        const responseSlot = voidBody.ledger.sections[VA_SECTION_KEY];
        assert.ok(responseSlot, `${roleId} clear response carries the VA slot`);
        assert.deepEqual(responseSlot.voided, [{ ref: observationReference, priorStatus: "preliminary" }]);

        // --- Persisted: a second session finds the ledger Basic on the server ---------------
        const persisted = await new FhirEncounterUndoLedgerStore(adminFhir).readRow(encounterId);
        assert.ok(persisted, `${roleId} clear left no undo ledger row for Encounter/${encounterId} on the server`);
        track(persisted.resource);
        assert.ok(
          persisted.resource.code?.coding?.some((coding) =>
            coding.system === ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM && coding.code === ENCOUNTER_UNDO_LEDGER_CODE
          ),
          "the persisted row carries the undo-ledger code",
        );
        assert.deepEqual(persisted.ledger.sections[VA_SECTION_KEY]?.voided, [{ ref: observationReference, priorStatus: "preliminary" }]);
        assert.equal(persisted.ledger.encounter, null);
        const cleared = await adminFhir.read<Observation>("Observation", observation.id!);
        assert.equal(cleared.status, "entered-in-error", "the value the clear reported voided is voided on the server");
        for (const provenance of await searchAll<Provenance>(adminFhir, "Provenance", { target: observationReference })) {
          track(provenance);
        }

        // --- Reads back under the SAME role: the strip the operator sees is built from this ---
        const read = await handleEncounterUndoLedgerRequest(deps, { authHeader, params });
        assert.equal(read.status, 200, `${roleId} ledger read: ${JSON.stringify(read.body)}`);
        assert.deepEqual((read.body as { ledger: EncounterUndoLedger }).ledger, persisted.ledger, `${roleId} reads the ledger it wrote`);

        // --- Undo, end to end: the value comes back, the slot is gone, the same row is reused --
        // TODO, deliberately visible: on real Medplum the restore is refused today. Both roles'
        // Observation write constraints (`policy/observation-status-machine.ts`, `%before.status
        // = 'preliminary'` for Staff) have no transition out of `entered-in-error`, so the PUT
        // that puts the value back answers 403 — and on this non-atomic stack the Encounter and
        // the ledger PUTs beside it still apply, clearing the slot. Whether undo restores through
        // the status machine or the machine gains a pre-sign restore edge changes canon and is
        // the operator's decision (decision 2026-09-02, undo ledger never granted, follow-up).
        // node:test runs a todo subtest and reports it without failing the lane; the day the
        // restore is granted, this flips to `ok … # TODO` on its own and the marker comes off.
        await roleTest.test(`${roleId} undoes the clear and the VA value is preliminary again`, {
          todo: "restore entered-in-error → preliminary is refused by the Observation status write constraint on real Medplum",
        }, async () => {
          const undone = await handleEncounterUndoRequest(deps, {
            authHeader,
            params,
            body: { scope: "section", sectionKey: VA_SECTION_KEY },
          });
          assert.equal(undone.status, 200, `${roleId} undo: ${JSON.stringify(undone.body)}`);
          const undoBody = undone.body as EncounterUndoResponse;
          assert.deepEqual(undoBody.restored, [observationReference]);
          assert.deepEqual(undoBody.skipped, []);
          const restored = await adminFhir.read<Observation>("Observation", observation.id!);
          assert.equal(restored.status, "preliminary", "undo restores the recorded prior status, not a constant");
          const afterUndo = await new FhirEncounterUndoLedgerStore(adminFhir).readRow(encounterId);
          assert.ok(afterUndo, "undo updates the one ledger row rather than deleting it");
          assert.equal(afterUndo.resource.id, persisted.resource.id, "the same Basic is reused, version-guarded");
          assert.equal(afterUndo.ledger.sections[VA_SECTION_KEY], undefined, "the slot is cleared: undo is not itself undoable");
          for (const provenance of await searchAll<Provenance>(adminFhir, "Provenance", { target: observationReference })) {
            track(provenance);
          }
        });
      });
    }

    // The two roles wrote two ledgers; both exist on the server at once.
    const rows = await searchAll<Basic>(adminFhir, "Basic", {
      code: `${ENCOUNTER_UNDO_LEDGER_CODE_SYSTEM}|${ENCOUNTER_UNDO_LEDGER_CODE}`,
      subject: encounterReferences.join(","),
    });
    assert.equal(rows.length, CLEAR_ROLES.length, "one persisted undo ledger per cleared encounter");
  } finally {
    if (process.env.MEDPLUM_CONTRACT_BOOTSTRAP !== "1") {
      await cleanupReferences(baseUrl, adminToken, [...new Set(cleanup)]);
    }
  }
});
