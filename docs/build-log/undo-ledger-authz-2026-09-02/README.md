# Undo ledger has never been granted — authz fix (2026-09-02) — evidence

Finding: `performance-od/decisions/2026-09-02-odos-undo-ledger-never-granted-403.md`.
Deploy sequence: `performance-od/decisions/2026-09-02-odos-policy-sync-is-a-required-deploy-step-and-it-is-broken.md`.
Base: `568d8253` (origin/main at branch time; PR #505 and PR #509 merged).

## The defect, reproduced before anything was changed

`red-base.log` is the new lane run against the CI contract container (Medplum 5.1.8, ephemeral
project, canonical policies repaired and synced from **base** `roles.ts`). Both roles fail on the
same entry the operator's diagnostics named:

```
Void transaction applied-partial: entry 3 of 4 (POST Basic) answered HTTP 403;
1 of 4 entries refused, 0 without a usable status, 2 of 2 changes applied,
1 creates accepted (rolled back by the client). First outcome: Forbidden (forbidden)
…
one persisted undo ledger per cleared encounter
0 !== 2
```

The two applied changes are the Observation flip and the Encounter version bump. The ledger
POST is the refused one. Zero ledger rows on the server.

## What is in this folder

| File | What it is |
|---|---|
| `red-base.log` | The new lane at base `roles.ts` + synced policy: RED, the 403 on `POST Basic` for Provider and for Staff. |
| `sync-fixed.log` | `sync-practice-role-policy-rules --apply` after the grant: the composite policy reports the six missing `Basic` interactions for the undo-ledger criteria, then `Policies updated: 3` (provider, staff, composite). |
| `green-fixed.log` | The lane at the fixed policy: `pass 3, fail 0, todo 2`, exit 0. The two `todo` rows are the undo subtests (see below). |
| `mandate17-cycle.log` | Mandate 17, explicit: delete the criteria line → re-sync (policy reports the six grants as `unexpected`, removes them) → RED with the 403 → `git checkout` the file → re-sync (`missing` ×6, `Policies updated: 3`) → GREEN → `git status --porcelain` empty. |
| `undo-e2e-server-state.txt` | What the server holds after the undo subtests were refused: two ledger rows with **empty** slots and two Observations still `entered-in-error`. |
| `clinicalWriteAuthzLive-lane.log` | The existing blocking lane (`ODOS_PRELIMINARY_OBSERVATION_AUTHZ_ONLY=1`) in the same container after its disposable-role-client mechanic moved to `liveRoleClient.ts`: `pass 4, fail 0`. |
| `harness/` | The re-runnable lane: `lane-bootstrap.sh` (dr-drill compose bootstrap → throttle wait → repair → sync, the CI order), `lane-env.sh`, `lane-sync-super.sh`, `lane-run-undo-test.sh`. Set `ODOS_ROOT` and `EVIDENCE_SCRATCH`. |

## How the lane was reproduced locally (and where it differs from CI)

The CI job runs `docker compose -f docker-compose.dr-drill.yml` on `localhost:18103`, bootstraps
the contract project via the smoke lane, waits 61 s for the login throttle, runs
`repair-practice-roles`, then `sync-practice-role-policy-rules --apply --bootstrap-service-identity`.
The harness does exactly that against the same compose file. Two local-only deviations, both
because the lane had to be flipped between policy states several times without tearing the
container down:

- `repair-practice-roles` refuses `MEDPLUM_CONTRACT_BOOTSTRAP=1` outside GitHub Actions; the
  harness sets `GITHUB_ACTIONS=true` for that one step. The script's second guard, base URL
  exactly `http://localhost:18103`, still holds — this never touches a real project.
- After the repair step the contract admin is policy-bound (composite) and cannot `PATCH` an
  AccessPolicy, so CI's sync step only ever *creates* policies from the repair (it always reports
  MATCH). To re-sync after editing `roles.ts`, `lane-sync-super.sh` signs in as the fresh
  container's seeded Medplum super admin (`admin@example.com`, Medplum's public default). In CI
  the repair step builds the policies from the PR's `roles.ts` directly, so no PATCH is needed.

One observation worth keeping: with the grant present in `roles.ts` but the policy **not yet
re-synced**, the lane stayed RED with the same 403. The guard is bound to the policy Medplum
enforces, not to the source file — which is the point, and also why deployment needs the
`--apply` step and not just the merge.

## Undo, end to end — it does not work yet, for a second reason

With the ledger grant in place the clear persists its slot and the strip can read it. The undo
itself is refused on its first entry, for both roles:

```
Void transaction applied-partial: entry 0 of 4 (PUT Observation/…) answered HTTP 403;
1 of 4 entries refused, 0 without a usable status, 2 of 3 changes applied,
1 creates accepted (rolled back by the client). First outcome: Forbidden (forbidden)
```

The refused entry is the restore `entered-in-error → preliminary`. Neither role's Observation
write constraint has a transition out of `entered-in-error`:
`policy/observation-status-machine.ts` calls it terminal (`OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION`
has no `%before.status = 'entered-in-error'` branch), and the Staff constraint requires
`%before.status = 'preliminary'`. The undo design (§4b.4, restore the recorded prior status) and
the status-machine canon disagree; resolving that changes canon and is not this slice's call.

The consequence on this non-atomic stack is worse than "undo fails": the Encounter PUT and the
ledger PUT beside the refused restore still apply, so **a refused undo clears the slot** — the
Undo strip disappears and the value stays voided (`undo-e2e-server-state.txt`). The undo route
also has none of the void's outcome diagnostics; it answers a bare 500.

The undo subtests stay in the lane as node:test `todo` rows naming this refusal. They run on
every CI pass and report without failing the lane; the day the restore is granted they flip to
`ok … # TODO` on their own and the marker comes off.

## Checks at the PR head

Both mcp runs without live credentials (`ODOS_ALLOW_UNGATED_MCP=1`, `ODOS_POSTGRES_URL` pointed at the
lane's ephemeral postgres), so the live lanes skip and the skip list can be compared.

| Check | Result |
|---|---|
| mcp suite, branch | `# tests 4096 / pass 4052 / fail 0 / skipped 44`, exit 0 |
| mcp suite, base `568d8253` | `# tests 4095 / pass 4052 / fail 0 / skipped 43`, exit 0 |
| skip-list parity | base skips 20 live surfaces; branch skips the same 20 plus `encounterUndoLedgerAuthzLive`. Nothing else changes. |
| ui suite | `# tests 1225 / pass 1225 / fail 0`, exit 0 |
| preflight | `0 warning(s), 0 hard block(s)`, exit 0 |
| typecheck | mcp `tsc --noEmit` 0 · `npm run typecheck:scripts` 0 · ui `tsc --noEmit` 0 |
| contract lane, this head | new lane `pass 3 / fail 0 / todo 2`; `clinicalWriteAuthzLive` (`ODOS_PRELIMINARY_OBSERVATION_AUTHZ_ONLY=1`) `pass 4 / fail 0` |

The one non-live test that moved: `schedulingRbacGrants.test.ts` pins Staff's `Basic` criteria
exhaustively and went red on the deliberate widening; the undo-ledger criteria was added to its
write tier. That pin catches silent growth of the allow-list; it does not prove the grant works —
the lane does.
