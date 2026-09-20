# S2b-2a Fixback 1 — pending saved-ID retention clarification

NOT EVALUATED. No fixback commit or push. PR #635 remains at `32066b22b2a19ab50a765347ff71b4afd4d73fb2` on `drbang-iva/followup-s2b2a-collapse`.

## Contract conflict

Fixback §3.1 calls for deriving session-saved editor IDs from the keys of `statuses`; §3.4 requires a saved-then-cleared section to remain collapse-only until the encounter is reopened.

At the requested head, `EncounterCharting.tsx:224-243` also contains `handleEncounterCleared`. An encounter clear calls `setStatuses({})` at line 235. A section clear filters the active section and its prefixed keys out of `statuses` at lines 238-240. Thus current status keys are not a retained record of every editor saved during the session. This code predates the fixback; the branch has not moved.

Using only those current keys cannot satisfy §3.4. Changing the existing clear behavior would also change status semantics outside this repair. The proposed resolution is a separate `savedEditorIds` set/array, populated by the same `markSaved` callback and retained until the encounter remounts. Existing status clearing would stay intact. Operator clarification is pending between that resolution and revising §3.4 to allow current-key behavior.

## Q1–Q5

| Premise | Result at 32066b22 |
| --- | --- |
| Q1 | `markSaved` records statuses and refreshes; the named built-in and stable-key callbacks reach it. Qualification: the clear handler deletes statuses, so they are not a complete retained session-save history. |
| Q2 | `App.tsx:581` renders `EncounterCharting` with `key={encounterId}`. The scene remounts per encounter. |
| Q3 | The board's shelved branch returns on data/active state before the opened-editor check. Confirmed. |
| Q4 | `holdsData` returns false only for projection-backed evidence. Registry unknown remains collapse-only. Confirmed; the map is unchanged. |
| Q5 | `changeBoardView` currently checks active sheet, editor, projection and `holdsData` before shelving. Confirmed. |

## Local work retained, not submitted

- `ExamOverviewBoard.tsx`: optional `savedEditorIds` prop; only a saved editor's false evidence is raised to unknown. No registry change.
- New `ui/tests/examStaleShelve.test.tsx`: inverted evaluator repro with all three steps, never-saved shelving roundtrip, and existing data/unknown precedence.
- `ui/tests/examOverviewBoard.test.tsx`: added G-FB2 test explicitly labelled fault injection and unreachable through the UI. It invokes the actual scene's handler after its IOP save callback, with a stale projection. No existing assertion is changed.
- Proof harness under this evidence directory: explicit Fixback 1 mode with `odos-s2b2a-fb1-proof`, separate runtime, ports and subnet. Existing proof mode is preserved.
- `EncounterCharting.tsx` is unchanged while the retention clarification is pending. The current partial tree is not a completed fix and must not be merged.

## Check summaries

```text
BASELINE: npm --prefix ui test
exit 0
# tests 1800
# pass 1800
# fail 0
# cancelled 0
# skipped 0
# todo 0

BASELINE: (cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx tests/examViewState.test.tsx)
exit 0
# tests 21
# pass 21
# fail 0
# cancelled 0
# skipped 0
# todo 0

BASELINE: (cd ui && npx tsc --noEmit)
exit 0; no diagnostics

BASELINE: npm run preflight
exit 0
ODOS preflight complete: 0 warning(s), 0 hard block(s).

REPRO: (cd ui && node --import tsx --test tests/examStaleShelve.test.tsx)
before board adjustment: exit 1; tests 3, pass 2, fail 1, skipped 0
failing: S2b2a G-FB1 a session-saved IOP stays drawn and collapse-only on a racing projection, then data wins after refresh
after board adjustment: exit 0; tests 3, pass 3, fail 0, skipped 0

HANDLER: (cd ui && node --import tsx --test --test-name-pattern='G-FB2' tests/examOverviewBoard.test.tsx)
exit 1; tests 1, pass 0, fail 1, skipped 0
failing: S2b2a G-FB2 fault injection: direct shelve handler for a session-saved editor is unreachable through the UI and writes nothing
```

The scene-handler test remains red until the scene implementation is completed. Full after-suite, final typecheck/preflight, G-FB1–G-FB5 mutation/restoration, and real-UI Fixback 1 screenshots are not claimed. The 21 existing map/view tests have not been edited.

## Scope, risks and cleanup

No file outside §4 was needed or edited. No new decision or Mandate 14 ledger row. No server, registry, SpineNav, search/census, profile, Procedure-projection, or read-after-write-race repair is claimed. Those remain out of scope. The original Procedure blocker/probe and prior sealed bundle are preserved.

The new synthetic stack was prepared, bootstrapped and seeded. Its containers were stopped with:

```sh
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs stop --fixback1
docker ps --filter name=odos-s2b2a-fb1- --format 'table {{.Names}}\t{{.Status}}'
```

```text
NAMES     STATUS
```

The clean comparison checkout at the parent head was built but not served. No Fixback 1 application processes remain running. No push, merge or deployment.

blocked
