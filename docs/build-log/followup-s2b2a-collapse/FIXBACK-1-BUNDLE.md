# S2b-2a Fixback 1 REV 2 — sealed author bundle

NOT EVALUATED. Independent evaluator: Claude Opus 5 at the final head of [PR #635](https://github.com/drbang-iva/ODOS2020/pull/635), supplied in its description and the handoff.

## Summary

The scene passes `savedEditorIds = Object.keys(statuses)` to the board, with no new state.
A status-backed editor whose projection says empty is treated as unknown and remains collapse-only.
The scene's shelving handler independently refuses that editor; its test is labelled fault injection.
Successful clear handlers remove protection with their status keys; failed clears keep it.
All six guard mutations failed and restored green; the original 21 tests are unchanged.
Full UI: 1,800 before, 1,807 after; zero failures or skips. Typecheck and preflight pass.
Real IOP save/read lag reproduced before and after at 1440 and 390; the fixed line stays drawn without manual refresh.
The disposable stack is stopped. No merge, deployment, or independent acceptance is claimed.

## Identity and scope

- Branch: `drbang-iva/followup-s2b2a-collapse`; existing PR #635.
- Fixback parent: `32066b22b2a19ab50a765347ff71b4afd4d73fb2`. No rebase. Original slice base remains da799f4e.
- Refreshed origin/main: `dbb41241826c5ab5bcce67cc2b1b165e5638c487`. Open PRs #626 and #636 do not overlap these files.
- Requested author marker remains `Coded-by: Codex — gpt-6-astra, high effort` on its own line in the PR.
- REV 2 supersedes §3.4 of Fixback 1. [FIXBACK-1-BLOCKED.md](FIXBACK-1-BLOCKED.md) is preserved as the historical clarification record. The earlier [BLOCKED.md](BLOCKED.md) and Procedure probe are also preserved.

| Files touched | Purpose |
| --- | --- |
| `ui/src/components/charting/ExamOverviewBoard.tsx` | Optional `savedEditorIds` prop, default empty; false-to-unknown adjustment in the local evidence map. |
| `ui/src/scenes/EncounterCharting.tsx` | Derive current status keys, pass them to the board, and refuse shelving in the handler. Only these three additions; clear/save handlers are unchanged. |
| `ui/tests/examStaleShelve.test.tsx` | Three permanent regressions: the inverted evaluator repro, never-saved shelving/return, persisted data/unknown precedence. |
| `ui/tests/examOverviewBoard.test.tsx` | Four added scene tests: handler fault injection, successful section clear, successful encounter clear, failed clear. Reuses the existing scene harness. |
| `docs/build-log/followup-s2b2a-collapse/` | This bundle, historical blocked record, guard runner/summaries, browser results, eight screenshots, served identity, and an explicit Fixback 1 mode in the existing proof harness. |

No existing assertion was removed, shortened or changed. No assertion migration is needed in this fixback. `examEditorMap.test.tsx`, `examViewState.test.tsx`, `exam-editor-map.ts`, `exam-view-state.ts` and `SpineNav.tsx` are unchanged from the parent. No outside-allowlist file was needed. No new clinical codes/rules/artifact claims; Mandate 14 ledger rows added: **0**. No new decision; `decisions/INDEX.md` is unchanged.

## Q1–Q5 re-verification

| Premise | Result at the parent head |
| --- | --- |
| Q1 | `markSaved` writes the section key to `statuses` and refreshes the overview. Built-in entry sheets and the listed whole-page and stable-key callbacks reach it. As corrected by REV 2, successful clear handlers remove keys and `handleEncounterClearFailed` leaves them intact. |
| Q2 | `App.tsx` renders `<EncounterCharting key={encounterId} ...>`. Encounter navigation remounts the scene, so statuses start empty. |
| Q3 | The board's persisted-shelf branch returns before consulting opened IDs. The fix changes only its evidence input, leaving that existing branch intact. |
| Q4 | `holdsData` returns false only for projection-backed registry entries. Its contract and all unknown registry decisions are unchanged. |
| Q5 | `changeBoardView` checks active sheet, editor, projection and `holdsData`. It now also rejects current status keys before updating state or storage. |

The chosen prop/local name is **`savedEditorIds`**. It is recomputed from `Object.keys(statuses)` each render, not retained in a hook, ref, browser storage, or separate scene state. The board creates only a transient lookup Set from that prop. Only a false result is raised to unknown; true and unknown keep their meanings.

**A successfully cleared section becomes shelvable again once its projection is empty; this is intended.** A stale clear-direction projection still showing the finding yields true and remains collapse-only. A failed clear keeps the status key and therefore keeps save-direction protection.

## Guards G-FB1–G-FB6

Full commands, failing names and quoted red/green summaries are in [FIXBACK-1-GUARDS.md](FIXBACK-1-GUARDS.md); exact structured results and verified mutant/restoration hashes are in [fixback1-mutations.json](fixback1-mutations.json).

Command: `node docs/build-log/followup-s2b2a-collapse/fixback1-mutations.mjs` — exit 0, **6 mutations red, 6 restored green**.

| Guard | Broken behavior and actual red | Restored green |
| --- | --- | --- |
| G-FB1 | Remove the saved-ID evidence adjustment: 1/1 fails. | 1/1 passes. |
| G-FB2 — fault injection | Remove the handler refusal: 1/1 fails because the direct call changes view state. | 1/1 passes; no storage write or request. |
| G-FB3 | Treat every inventory entry as saved: 1/1 fails because the never-saved empty control disappears. | 1/1 passes; shelves and returns. |
| G-FB4 | Apply the shelf mark before data/unknown checks: 1/1 fails. | 1/1 passes. |
| G-FB5 | Force `holdsData` false: 17 of the original 21 tests fail. | Original 21/21 pass, zero skips. Full UI 1,807/1,807 separately below. |
| G-FB6 | Retain old keys in a ref after `statuses` removes them: both successful-clear tests fail; failed-clear test still passes. | 3/3 pass. |

G-FB2 is explicitly **fault injection, unreachable through the fixed UI**. It opens the actual scene's IOP editor, invokes its existing successful-save callback, lets the actual refresh receive the stale empty fixture, and directly invokes the scene-owned `onShelve`. It observes actual view state, localStorage writes and fetch calls; it does not substitute the handler.

G-FB6 is proved **through the clear handlers, not merely by inspecting the derivation**. Successful section and encounter clear callbacks reach `handleEncounterCleared`, removing IOP (and, for encounter clear, the other saved key). The now-empty IOP can then be shelved through its control. A separate test drives Clear chart through the actual confirmation UI with a failing endpoint response; `handleEncounterClearFailed` runs, refreshes and retains IOP protection. These scene tests use the existing HTTP/FHIR fixture; the real-Medplum save proof is below.

The evaluator's three-step repro is preserved with its assertions inverted: racing read offers collapse; a persisted shelved mark cannot hide it; after refresh, projected data keeps it drawn. Before the board adjustment: 2 pass/1 fail. After: 3/3 pass. The initial handler repro was 0 pass/1 fail; with the refusal it is 1/1.

## Proof 1–3: real stack and screenshots

The task uses **`odos-s2b2a-fb1-proof`**, isolated runtime, ports and subnet, real Medplum, Postgres, Redis, built MCP/UI and the real front-door route map. The parent UI is built from a separate clean checkout at 32066b22 and served on a distinct port. No response is replaced, delayed, dropped or mocked in this browser proof.

Both revisions chart OD IOP 17 using the actual editor and Save IOP button. They use equivalent fresh synthetic encounters so each captures the save/read race independently, with the same patient, exam scope, viewport and input. They do not reuse an already-indexed encounter and present it as a fresh-save comparison.

| Proof | 1440 and 390 result |
| --- | --- |
| 1 — save without manual refresh | Parent: zero projected IOP finding rows, evidence false, to shelf offered. Fixed: the same zero-row lag, evidence unknown, IOP drawn with collapse and no to shelf. Collapse/expand keeps the line drawn. **Manual refresh click count: 0** in each run. |
| 2 — F10 | Never-saved, proven-empty cornea still offers to shelf, appears in Ocular Health shelf, and opens/returns with its stored shelved mark cleared. |
| 3 — suites | Full before/after UI, typecheck and preflight pass with counts below. |

Browser result summaries: [before](fixback1-before-browser-results.json), [after](fixback1-browser-results.json). Both widths had **0 page errors** and **0 requests from collapse/expand/shelve**. Opening an editor and returning still use their existing read paths.

| Width | Parent after Save IOP | Fixed after Save IOP | Fixed collapsed | Empty cornea shelved |
| --- | --- | --- | --- | --- |
| 1440 | [Before](fixback1-screenshots/1440-before-save-lag.png) | [After](fixback1-screenshots/1440-after-save-lag.png) | [Collapsed](fixback1-screenshots/1440-after-collapse.png) | [Shelf](fixback1-screenshots/1440-after-shelved.png) |
| 390 | [Before](fixback1-screenshots/390-before-save-lag.png) | [After](fixback1-screenshots/390-after-save-lag.png) | [Collapsed](fixback1-screenshots/390-after-collapse.png) | [Shelf](fixback1-screenshots/390-after-shelved.png) |

[fixback1-served-identity.json](fixback1-served-identity.json) records JS/CSS, source and server-image hashes. The build stamp shows the parent because the build preceded the commit; the recorded application source hashes identify the built fix. No application source changed after the build.

```sh
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs prepare --fixback1
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs up --fixback1
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs build --fixback1
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs serve --fixback1
node --import tsx docs/build-log/followup-s2b2a-collapse/proof/seed-collapse.ts --fixback1 --fresh
node docs/build-log/followup-s2b2a-collapse/proof/browser.mjs "$BEFORE_ROOT" --fixback1 --fixback1-before
node docs/build-log/followup-s2b2a-collapse/proof/browser.mjs "$BEFORE_ROOT" --fixback1
node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs stop --fixback1
```

`BEFORE_ROOT` is the clean, separately built parent checkout. Prepare is a one-time step; reuse an existing task runtime rather than overwriting its synthetic identity.

## Before and after checks

| Command | Before at 32066b22 | After fixback |
| --- | --- | --- |
| `npm --prefix ui test` | Exit 0: 1,800 pass; 0 failed/skipped/cancelled/todo; 216598 ms | Exit 0: 1,807 pass; 0 failed/skipped/cancelled/todo; 215967 ms |
| `(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx tests/examViewState.test.tsx)` | Exit 0: 21 pass, 0 fail/skip | G-FB5 restored: exit 0, 21 pass, 0 fail/skip |
| `(cd ui && npx tsc --noEmit)` | Exit 0, no diagnostics | Exit 0, no diagnostics |
| `npm run preflight` | Exit 0, 0 warnings/blocks | Exit 0, 0 warnings/blocks |
| UI / MCP build for real stack | Clean parent UI build exit 0; MCP source unchanged | Both exit 0; existing large-chunk advisory only |

```text
BEFORE: npm --prefix ui test
# tests 1800
# pass 1800
# fail 0
# cancelled 0
# skipped 0
# todo 0

AFTER: npm --prefix ui test
# tests 1807
# pass 1807
# fail 0
# cancelled 0
# skipped 0
# todo 0

BEFORE AND AFTER: npm run preflight
ODOS preflight complete: 0 warning(s), 0 hard block(s).
```

No required local suite was skipped. The final-head CI and bot states accompany this bundle in the PR description/handoff; no independent verdict is supplied by the author.

## Risks, follow-ups and explicitly not done

- The server's read-after-write race remains. Until its projection catches up, the line may still display its empty-row copy or unknown summary; this fix protects visibility and shelving, not value projection freshness. No refresh call was added.
- `ocular-health:` / `custom:` whole-prefix evidence coverage remains the evaluator's Finding 2 for the S2b-2b census. No registry decision is changed.
- A saved Procedure remains undrawn on the overview. Its projection gap remains an unowned follow-up; Procedure editors stay unknown/collapse-only.
- No search box or census (S2b-2b), profiles/shape record (S3), server change, or SpineNav behavior change. Existing browser-local view-state and printed-record limitations remain as described in the initial bundle.
- No cross-repo edit. The kickoff author owns later design-status updates. Independent Claude Opus 5 evaluation at the new head remains required.

## Cleanup

The stop command exited 0. Owned MCP/Caddy/proxy processes, including the parent comparison Caddy, are stopped. Task containers are stopped, retained with their volumes for reproduction; other stacks were not stopped.

`docker ps --filter name=odos-s2b2a-fb1- --format 'table {{.Names}}\t{{.Status}}'`:

```text
NAMES     STATUS
```

needs-review
