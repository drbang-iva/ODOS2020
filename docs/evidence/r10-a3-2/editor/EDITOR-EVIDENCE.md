# A3.2 Ocular Health editor: bounded implementation evidence

Status: PARTIAL / NOT EVALUATED. Parent task stops at step2 scope question; this is author evidence, not independent evaluation.

## Files touched

- `ui/src/components/charting/OcularHealthSection.tsx` — canonical per-eye history/save; witness locks; absent selection; panel values; frozen retry; pending-change merge on refresh; encounter lock labels; prior/unscoped display. Legacy snapshot write path removed.
- `ui/src/lib/diagnosis-findings.ts` — preserve causal refusal/conflict reason in reload-choice message, including negative-act outcomes.
- `ui/tests/r10A3OcularEditor.test.tsx` — 13 new focused tests. Existing test assertions were not changed.

## Assertion ledger

| Guard | Before | New assertion |
|---|---|---|
| W130/W147 UI | No dedicated assertion | Signed present fact is checked and locked; Remarks-only request includes it identically in loaded/selected; live absent omitted from loaded. |
| W137 | No dedicated assertion | Recorded absent label; explicit selection carries fromPresence=absent; loaded remains empty. |
| W131 | No dedicated assertion | 502 unconfirmed Retry resends byte-identical JSON, hence same commandId. |
| W132 | No dedicated assertion | Conflict reload retains Remarks and pending selection; subsequent commandId differs and selected claim takes fresh version 2. |
| W133 | No dedicated assertion | Negative conflict reason is visible through shared helper; incomplete negative command never calls onSaved. |
| W134 | No dedicated assertion | Both closed and pre-rebuild labels shown; Save control absent. |
| W138 | No dedicated assertion | Deferred keeps loaded selections checked, disables chips, and sends identical loaded/selected with deferred=true. |
| W136 | No dedicated assertion | Separate OD/OS Remarks plus numeric/select values included in panel state and hydrated from subsequent history response. |
| W145 | No dedicated assertion | Unscoped notice shown at 2, absent at 0. |
| W135 | No dedicated assertion | External diagnosis-door event refreshes history while pending Remarks survives; concurrent sibling survives both loaded and selected in next save. |

## Checks

Command (cwd ui): `node --import tsx --test tests/r10A3OcularEditor.test.tsx`. Final dedicated result: 13 tests, 13 pass, 0 fail, 0 skip, 0 TODO.

Initial baseline: `initial-red.txt` (new suite before implementation). Later expanded requirements demonstrated by guarded mutation runs below.

| Mutation | Red result | Restored result |
|---|---|---|
| W130 | 11 pass / 2 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W131 | 12 pass / 1 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W132 | 12 pass / 1 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W133 | 12 pass / 1 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W134 | 11 pass / 2 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W135 | 12 pass / 1 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W136 | 11 pass / 2 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W137 | 12 pass / 1 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W138 | 12 pass / 1 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W145 | 12 pass / 1 fail; exit 1 | 13 pass / 0 fail; exit 0 |
| W147-ui | 12 pass / 1 fail; exit 1 | 13 pass / 0 fail; exit 0 |

Each mutation was applied with an exact-match anchor count (misses throw), executed, restored in finally, then the full dedicated suite rerun green. All source is restored.

## Remaining work and limits

- No old rows-only UI fixture/assertion migration yet. Those fixtures must be migrated with explicit V/W rows; snapshot fallback was deliberately removed.
- Picker still uses the pre-existing snapshot-reference visibility plumbing; step2 must replace it with facts.
- No served-route harness, browser screenshots, T-slot proof, full-suite result, CI, PR, or independent evaluation supplied by this subtask. Parent coordinates those or records the blocked state.
- Dedicated round-trip test exercises controlled server-response/history hydration, not real FHIR persistence.
- Deferred-off toggle and reverse event consumer are not separate new dedicated assertions here. Existing shared outcome helper dispatches confirmed events.
- No Docker containers started or stopped by this subtask.

## Final bounded follow-up

After the parent's full-suite run, two additional assertions exposed defects: the unscoped notice could persist after a fresh zero count; an inactive owned option was hidden despite a live read-only witness. `refresh-inactive-red.txt`: 15 tests, 13 pass, 2 fail. The editor now derives the count once from the current non-aborted prior-history batch and includes inactive options with live present facts. `refresh-inactive-green.txt`: 15 tests, 15 pass, 0 fail, 0 skip, 0 TODO.

Additional assertion ledger:

| Guard | Before | After |
|---|---|---|
| W145 | Separate 0 and 2 mounts only | A rendered count-2 notice disappears after same-editor refresh returns 0. |
| W147 UI | Active signed fact lock only | An inactive option with a live present read-only fact remains visible, checked and locked. |

Final focused count supersedes the earlier 13-test count. The earlier 11 mutation red/restored-green pairs remain the recorded mutation runs; the two new assertions were observed red immediately before their fixes and green after. No later mutation remains applied. No other screen or old fixture migration was added.
