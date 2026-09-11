# MATRIX-1 fixback round 2 — author evidence

Reviewed parent: `659008585fc134971f37e56cd44be085116467aa`. Fix commit: `4f9e41298a39068cb38cbc18fbe246fbdf3399d7`. Patient-version fixture follow-up: `b655287aca9b8a0fdcd7ae3f0f2c9c2340b1461c`. Same branch `drbang-iva/comms-matrix-1`, same PR #577. This is author verification, not independent evaluation.

The staff email path now sends, persists the sent Communication, updates the recipient contact, flips the withheld preference using a fresh Patient read, and records send Provenance. `withheldEducationEmail` is still computed before sending. The flip catch and G19/G19b failure semantics are unchanged.

The shared API fixture now rejects a Patient update whose If-Match does not match its stored version, using `fhirWriterError(412, "PUT")`. With this enforcement alone, all 73 existing tests passed, exit 0: [output](fixture-existing.log). No existing assertion changed.

Two new F1 tests combine staff email, a changed recipient override and `alsoUpdateChart: true`, with withheld and already-ON controls. Both require 200/sent, no chartUpdate or preferenceUpdate property, one provider call, one contact update, and the saved address. The withheld case requires explicit ON with `staff-manual-send`; the control preserves its original cell exactly and performs no flip. The whole API file passes 75/75 after correction.

The F1 mutation moves the flip back before sent persistence and contact update. Only the new withheld case fails, with actual chartUpdate `conflict`; its control and all 73 existing tests pass. Restoration is byte-identical. [Applicable mutation](F1-mutation.diff).

G12/G19/G19b were rerun with `npm --prefix mcp test -- '--test-name-pattern=G12|G19' tests/commsApi.test.ts`: 3/3, exit 0. [Output](G12-G19-G19b.log).

| Guard | Mutated | Restored | Evidence |
|---|---|---|---|
| F1 | 74/75, exit 1 | 75/75, exit 0 | [proof](F1-proof.log) · [red](F1-red.log) · [green](F1-green.log) · [result](F1-result.json) |
| G13 | 3/5, exit 1 | 5/5, exit 0 | [proof](G13-proof.log) · [red](G13-red.log) · [green](G13-green.log) · [result](G13-result.json) |
| G14b | 4/5, exit 1 | 5/5, exit 0 | [proof](G14b-proof.log) · [red](G14b-red.log) · [green](G14b-green.log) · [result](G14b-result.json) |
| G18 | 7/9, exit 1 | 9/9, exit 0 | [proof](G18-proof.log) · [red](G18-red.log) · [green](G18-green.log) · [result](G18-result.json) |
| G21 | 9/10, exit 1 | 10/10, exit 0 | [proof](G21-proof.log) · [red](G21-red.log) · [green](G21-green.log) · [result](G21-result.json) |

The four regenerated diffs are [G13](../mutations/G13-mutation.diff), [G14b](../mutations/G14b-mutation.diff), [G18](../mutations/G18-mutation.diff) and [G21](../mutations/G21-mutation.diff). Every diff passes standard `git apply --check` against the corrected source. Their earlier companion proof/output/result files were refreshed to match. Apply only one mutation at a time and restore before the next.

Commands are captured independently; no reported command is piped. Full-suite comparison and final head are included in the PR author seal. No new vocabulary, dependencies, or strategy decisions. Independent re-evaluation remains with Claude Opus 5 (extra).

## Full suites and failure comparison

| Run | Total | Passed | Failed | Skipped | Exit |
|---|---:|---:|---:|---:|---:|
| Initial branch, alongside UI | 4640 | 4618 | 17 | 5 | 1 |
| Clean base 78a8ef6f, sequential | 4578 | 4565 | 8 | 5 | 1 |
| Final branch, sequential | 4640 | 4627 | 8 | 5 | 1 |
| UI | 1341 | 1341 | 0 | 0 | 0 |

The initial run had nine additional HTTP 429 failures in unchanged profile and Provenance fixtures. The same branch code was rerun alone after a fresh clean-base run. The final failure-name sets match exactly: **8 common, zero branch-only, zero base-only**. No rate limit, scanner, shared retry, or unrelated test was changed. The initial result is retained; local quota timing remains a verification limitation.

Captured commands, own exit statuses and exact failure names: [initial MCP](mcp-initial-summary.log), [clean base](base-summary.log), [final MCP](mcp-final-summary.log), [UI](ui-summary.log). MCP build exited 0: [output](build.log). The base worktree remained clean. The full list and prior comparison history remain in [the failure table](../failure-comparison.md).

Files: `mcp/src/comms/comms-api.ts`, `mcp/tests/commsApi.test.ts`, the four regenerated mutation packets, and their author evidence/index documents. No other executable source changed in this fixback.

## Patient-version fixture follow-up

The bot correctly identified that the same Patient update fixture derived its next version from the Communication store. The authorized conditional-write fixture now advances the version from the current Patient record. No existing assertion changed. All 75 API tests, including the 73 pre-existing tests, pass with this stronger enforcement: [output](version-fixture-existing.log).

The two new F1 cases additionally require version 3 after contact plus preference flip, and version 2 after contact alone. Resetting successful Patient updates to version 1 makes those two cases fail: 73/75, exit 1; restoration passes 75/75, exit 0. [Mutation](Patient-version-mutation.diff) · [proof](Patient-version-proof.log) · [red](Patient-version-red.log) · [green](Patient-version-green.log) · [result](Patient-version-result.json). F1 and G12/G19/G19b were rerun and remain red/restored-green and 3/3 green respectively; their outputs above were refreshed.

After the Patient-version fixture follow-up, full MCP was rerun: **4,640 total, 4,627 passed, 8 failed, 5 skipped, exit 1**. The failure set still matches the clean base exactly, with zero branch-only failures. [Final output](mcp-final-summary.log). The UI source is unchanged and its full 1,341/1,341 run remains valid.
