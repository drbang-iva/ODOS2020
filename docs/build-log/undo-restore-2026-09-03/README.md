# Observation Undo restore — author evidence

Base: `02bf82559edd7c22a495c173f44eaf6af50731be` (merged #510).
Source commit: `82edd3e6963cbdf5dee087eef41fd1eb83c8076a`.
Branch: `drbang-iva/undo-restore`. Author: Codex. **NOT independently evaluated.**

## Result and boundary

Server-side Undo now works for Provider and Staff on the isolated real Medplum stack: chart a
preliminary VA `20/20` -> clear -> persisted/readable ledger -> Undo -> the same principal reads
the restored `preliminary` value `20/20`; the ledger slot is consumed. Finished encounters are
refused by the real Undo handler with HTTP 409 `encounter-closed`, with the Observation, Encounter
version, and ledger unchanged. The two failing TODO subtests from #510 are now blocking tests.

This is handler-to-real-server proof with actual role-bound client-credentials tokens, not an
in-memory policy simulation and not a browser walkthrough. The production route, UI, write
payloads, outcome taxonomy, and styling are unchanged. Iris was neither deployed nor policy-synced.

**The unsigned gate is ENDPOINT-ONLY.** Direct FHIR PUT with the same Provider or Staff credentials
can restore an Observation on a finished chart, bypassing the endpoint. This gap is empirically
confirmed below and documented in source. It is the fallback explicitly authorized in the kickoff,
not a claim that the policy enforces signed-chart terminality.

## Scope

- Runtime table: exactly two `entered-in-error -> preliminary` rows, scribe and clinician.
- Provider expression and Staff expression: the same single edge, independently implemented and
  independently mutation-tested. The expressions remain hand-maintained, not generated from the
  table; no derivation/byte-equality claim is made.
- Both expressions also serve DiagnosticReport. The new branch is restricted by
  `($this is Observation)`, so DiagnosticReport retains its existing transitions. A new test
  rejects every DiagnosticReport exit from entered-in-error; its own mutation goes RED.
- No other Observation edge, role grant, Basic criteria, patient compartment, endpoint payload,
  transaction behavior, or UI is changed. Cancelled/unknown remain terminal and the system actor
  cannot use the new edge.
- Mandate 14: row 52 in the existing v0.5 ledger records two primary sources and access dates for
  the reused status values. The restore workflow is operator policy, not a FHIR-mandated edge.
  The ledger row is documentary, not machine-enforced; deleting that row is not claimed to fail a test.

## Empirical reference-resolution result

The task-owned server returned:

```json
{"ok":true,"version":"5.1.30-9b1bd92","platform":"linux","runtime":"v24.18.1","postgres":true,"redis":true,"redisInstances":{"default":true}}
```

Image: `medplum/medplum-server:5.1.30`, digest
`sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de`.
Each experiment used a disposable AccessPolicy and role client; every principal could directly
GET its referenced Encounter (HTTP 200). There were 28 PUT probes: seven expressions × two
Encounter states × two roles. Full output: [resolve-probe.txt](resolve-probe.txt).

| Restore branch condition | In-progress Encounter | Finished Encounter |
|---|---|---|
| `true` control | 200, restored | 200, restored |
| `%before.encounter.resolve().exists()` | 200 | 200 |
| `%before.encounter.resolve().status.empty()` | 200 | 200 |
| `%before.encounter.resolve().status = 'in-progress'` | 403 | 403 |
| `%before.encounter.resolve().status != 'finished'` | 403 | 403 |
| `%before.encounter.resolve().ofType(Encounter).status = 'in-progress'` | 403 | 403 |
| `encounter.resolve().status = 'in-progress'` | 403 | 403 |

Results were identical for both roles. `exists()` alone is not proof of reference resolution:
the status was empty in this writeConstraint context. The tested reference expressions cannot
implement the unsigned gate on this version. This finding came from HTTP writes, not documentation.

## Mandate 17 — exact source, disposable mutation worktree

Every mutant was inspected with `git diff` or `rg` before its run. Mutations ran in a separate
detached worktree at the source commit above. Each was restored before GREEN; the final worktree
was clean. For policy mutations the canonical test policies were actually re-synced, not stubbed.
Full RED/GREEN output and sync summaries: [mutations.txt](mutations.txt).

| Mutation | RED (exit 1) | Restored GREEN (exit 0) |
|---|---|---|
| Delete both runtime rows | 8 tests: 6 pass, 2 fail | 8 pass, 0 fail |
| Delete Provider branch and sync | Provider restore HTTP 403; Staff still restores; 4 pass, 3 fail including parents | 7 pass, 0 fail |
| Restore Provider source WITHOUT sync | Still Provider HTTP 403; 4 pass, 3 fail | After sync: 7 pass, 0 fail |
| Delete Staff branch and sync | Staff restore HTTP 403; Provider still restores; 4 pass, 3 fail including parents | 7 pass, 0 fail |
| Remove existing endpoint sign gate | Both signed Undo tests return 200 instead of 409; 2 pass, 5 fail including parents | 7 pass, 0 fail |
| Remove Provider Observation-only type guard | DiagnosticReport scope test: 0 pass, 1 fail | 1 pass, 0 fail |

The Provider and Staff policy mutations each updated two stored policies: the individual role
policy and the composite. Restoring source alone left the real authorization guard RED.

Commands from the task checkout (use a disposable worktree for mutations):

```sh
node --import tsx --test tests/observation-status-machine/transitions.test.ts
node --import tsx --test tests/observation-status-machine/transitions.test.ts mcp/tests/threeRoleModel.test.ts
npm run -s sync-practice-role-policy-rules -- --project "$MEDPLUM_PROJECT_ID" --apply --bootstrap-service-identity
# From mcp/ after each deployed-policy mutation and restoration:
node --import tsx --test --test-concurrency=1 tests/encounterUndoLedgerAuthzLive.test.ts
```

## Checks and exact skip parity

Full counts, named skips, baseline live result, and existing-lane output: [checks.txt](checks.txt).

| Check | Result |
|---|---|
| Base MCP, no live credentials | 4096 tests; 4052 pass; 0 fail; 44 skipped |
| Branch MCP, same environment | 4099 tests; 4055 pass; 0 fail; 44 skipped |
| Skip-list diff by NAME | All 44 identical; none added or removed |
| UI suite | 1225 tests; 1225 pass; 0 fail; 0 skipped |
| Focused transition/role tests | 47 tests; 47 pass; 0 fail |
| Existing real preliminary authorization lane | 4 tests; 4 pass; 0 fail |
| Real clear/restore/signed-refusal lane | 7 tests; 7 pass; 0 fail; 0 skipped; 0 TODO |
| Preflight | 0 warnings; 0 hard blocks; exit 0 |
| Scripts / MCP / UI typechecks | exit 0 / 0 / 0 |

```sh
ODOS_ALLOW_UNGATED_MCP=1 ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15432/medplum npm --prefix mcp test
npm --prefix ui test
npm run preflight
npm run typecheck:scripts
npm --prefix mcp exec -- tsc --noEmit -p mcp/tsconfig.json
npm --prefix ui exec -- tsc --noEmit -p ui/tsconfig.json
```

The offline MCP suite does not prove AccessPolicy. The separately credentialed lane above does.
CI still uses the repository's existing 5.1.8 contract backend; the local reference-resolution
experiment and all local live results reported here use 5.1.30-9b1bd92.

## Reproduction environment

The stack used `docker-compose.dr-drill.yml` with a local override selecting 5.1.30, binding port
18103 to loopback, and naming three NEW volumes `odos_undo_restore_postgres`,
`odos_undo_restore_redis`, and `odos_undo_restore_binary`. No existing stack or volume was reused.
The compose project was `odos-undo-restore`; signing keys were generated in this worktree's ignored
`.odos/` directory. Bootstrap order was the existing CI order: search smoke (12 pass), profile
validation (8 pass), repair canonical practice roles, sync with `--apply`, then role-token tests.

For local repair only, the harness set `GITHUB_ACTIONS=true` with `MEDPLUM_CONTRACT_BOOTSTRAP=1`
against the fresh `localhost:18103` project, as #510's documented harness does. Subsequent policy
updates used the fresh container's seeded super-admin because the now-policy-bound contract admin
cannot patch AccessPolicy. No credentials or tokens are recorded here.

The two standalone characterization scripts are in [harness/](harness/). Run from the repo root
with `node --import tsx docs/build-log/undo-restore-2026-09-03/harness/<name>.ts`, exporting the
ephemeral `MEDPLUM_BASE_URL`, contract admin email/password, and `MEDPLUM_PROJECT_ID`.
`resolve-probe.ts` additionally needs `MEDPLUM_SUPER_ADMIN_PASSWORD`. Both scripts refuse any
base URL other than `http://localhost:18103/`. They intentionally retain synthetic evidence in the
throwaway stack; do not point them at a retained practice installation.

## Known consequences — confirmed, not fixed

Full real-server output: [residual-probe.txt](residual-probe.txt).

1. Both roles: finished Encounter -> Undo endpoint 409, but direct FHIR restore 200 and readable
   preliminary `20/20`. Policy-layer signed-chart protection is absent.
2. Both roles: a real concurrent Observation edit after Undo reads its targets produces a 412
   on the restore, while the Encounter and ledger PUTs still apply. The slot goes from present
   to absent. Thus a failed Undo can still consume the safety net for failures other than the
   missing restore permission. The concurrent value (`20/25`) is retained in this probe.
3. The Undo route's generic 500/outcome handling and non-atomic transaction behavior are unchanged.
4. Practice-scoped chart Basics remain a separate, real scope gap, as recorded by #510's
   independent evaluator. This PR changes no Basic grants or scoping.

## Deployment and handoff

**DEPLOYMENT REQUIRES POLICY SYNC `--apply` IN ADDITION TO THE MERGE.** Deploy this slice together
with #510's ledger grant, sync the stored role policies, verify they match, rebuild/restart as
needed, and perform the live application walkthrough. A merge alone leaves the old policy live.
Iris's policy was deliberately left unchanged for that combined rollout.

No new operator decision was made: this implements the supplied ruling and its explicit fallback.
No companion decision/INDEX files were edited; the empirical outcome can be attached to the
existing Undo decision during the independent evaluation/deployment record.

Status: author checks and mutation evidence only. Opus 5 (extra) must independently evaluate the
final PR head before merge. No evaluation marker or `evaluated` label was posted by the author.
