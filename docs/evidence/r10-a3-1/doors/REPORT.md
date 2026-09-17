# Diagnosis door author checks

Scope: §3.1 ownership/read projection and §3.2 closed-encounter gate in findings, candidates and pick. No UI, policies or scribe builders changed.

- Findings PUT and audit repair reject freshly read closed encounters before writer/repair invocation; pick rejects before catalog tally/Condition/Encounter writes. GET remains readable with `encounterEditable:false`.
- Every owned key uses `ownsFact`; a non-owned key returns `not-a-shared-finding`. Inactive historical rows remain labelled/read-only and grouped in their effective definition's section. Reassert replay passes the authenticated actor.
- Command and audit-repair responses reread the Encounter and add `encounterClosedDuringCommand` when observed closed; pick does the same after execution.
- Existing row-projection functions are exported for the Ocular Health caller to reuse rather than copy.

## Checks

- Initial W90: 3 tests, 0 pass, 3 fail (`initial-red.txt`).
- New door guards: 10 tests, 10 pass, 0 fail/skip/todo (`guards-green.txt`).
- Existing findings suites: 87 tests, 87 pass, 0 fail/skip/todo (`existing-green.txt`).
- Dependent pick/candidates/store suites: initially 139 tests, 136 pass, 3 fail; after mapped fixture migrations 139 tests, 139 pass, 0 fail/skip/todo (`dependents-green.txt`).
- W90 PUT, W90 repair, W90 pick and W111 closure flag individually mutated red exit 1, restored green exit 0 (`mutations.json`, `mutation-results.log`). Additional W93/W94/W117 consumer mutations are in library evidence.

## Existing assertion/fixture mapping

Baseline line numbers are used below.

| File:line | Before | After | V/W row |
|---|---|---|---|
| diagnosisLinkL2.test.ts:2363 | Error prose matches “after the encounter is signed” | Exact structured reason `encounter-closed`; same 409 and zero-write/state preservation assertions | V24 / W90 |
| diagnosisLinkL2.test.ts:2607 | Identifier-only synthetic panel with OD-prefixed numeric component, no strict envelope | Real hashed panel identifier + R10_PANEL_META + typed panel value component; identical candidate and one-support assertions | V21 / W71 / W117 |
| diagnosisLinkL2.test.ts:2742,2748–2749 | Newest of two identifier-only panel owners selected by time | One strict panel owner supplies values; test title states unique ownership | V21 / W71 |
| diagnosisLinkL2.test.ts:2756 | Only equal-time duplicate panel tested as ambiguous | Older second strict owner also refuses with same 502, unavailable, zero-transaction assertions | W71 |
| diagnosisFindingsCommands.test.ts:66–67 | Post-Provenance outage affected all searches | Only Observation encounter refresh fails; all outcome assertions preserved | W83 / W109; detailed library ledger |

All other existing assertions in these files remain unchanged. New tests are labelled with their W-row. These are author checks using synthetic in-memory transports; real stored-policy proof remains in §7.

## Credentialed regression

`node .odos/r10-a3-1/run-live.mjs docs/evidence/r10-a3-1/doors/live-regression.txt tests/r10DiagnosisDoorAuthzLive.test.ts`: exit 0; **4 tests, 4 pass, 0 fail/skip/todo**. Provider and Staff use stored canonical policies in synthetic project `14e0ec2a-cc7f-4ce6-be82-49d9417f3e95`, Medplum `http://127.0.0.1:29131`; diagnostic rows retain policy IDs/versions, resource references and before/after. PostgreSQL env points only to own `odos_a3_test` on port 29132; this particular suite uses FHIR, not SQL assertions. This is the existing regression lane, not a claim that the new A3.1 §7 suite is complete.

## W114 real store dependency completion

Five new isolated tests exercise default stored-definition loading for finding read, write, repair, mapping candidates and diagnosis pick. A practice-only checkbox option and mapping are persisted as a Basic definition; no findingDefinitions injection substitutes for the store path. All5 pass. Each dependency was replaced separately with compiled seeds: all5 mutants fail their named consumer assertion, then pass after byte-exact restoration. Recipes/results and central raw red/green logs are retained. No existing assertion changed. A reusable fixture export was added to the test-only T22 endpoint harness.
