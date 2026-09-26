# N1 fixback 2 — destination mount and initial Review loading

NOT EVALUATED

Coded-by: Codex — GPT-5.6 Sol, high effort

Same branch `drbang-iva/exam-nav-n1-menu`, PR #672; fixes the HUB FAIL at `6ff3260f3b0e1d58de14bae69d12cb38b4dc429a`. The current pushed head, CI UI counts, overall CI result, and PR-Agent rerun result are recorded in the PR body, so recording CI does not create another untested head.

| Item | Fix and mechanism | Files | Mutation proof |
|---|---|---|---|
| G1 | Ordered effects: reset encounter state first, then activate the destination. Activation also depends on encounterId. G4 opens each of twelve URL keys on a fresh page, settles 500 ms, and checks the current item and its existing §0.5 surface. | ui/src/scenes/EncounterCharting.tsx; ui/tests/examNavigationN1.test.tsx | Restore activation before reset: 0 pass / 1 fail, exit 1. Restore corrected order: 1 pass / 0 fail, exit 0. |
| G2 | A separate initialProjectionLoading flag starts true and clears only when the first projection request settles. Review uses that flag or the existing refresh flag. The board’s refresh initialization and consumers are unchanged. An addInitScript MutationObserver records any unavailable text from the first DOM mutations; the successful Review load must record none. | ui/src/scenes/EncounterCharting.tsx; ui/tests/examNavigationN1.test.tsx | Initialize the new flag false: 0 pass / 1 fail, exit 1. Restore true: 1 pass / 0 fail, exit 0. |

The only other changes are the mutation reproducer and this build evidence. F1/F3/F4 product behavior, R1–R3, protected assertions, and all sign logic are unchanged. No fixture, CSS, or board component changed.

## Commands and results

Operator files remained absent; the runner verified absence and stripped ODOS_/MEDPLUM_ variables. No MCP types changed or local database/container actions were needed. Navigation retains 30 seconds; locators retain 5 seconds. Full UI tests use the unchanged npm package command. Logs remain gitignored; only summaries follow.

```sh
python3 docs/build-log/exam-nav-n1/prove.py fixback2-G1 fixback2-G2
python3 docs/build-log/exam-nav-n1/run.py fixback2-full npm --prefix ui test
python3 docs/build-log/exam-nav-n1/run.py fixback2-build npm --prefix ui run build
```

## fixback2-G1-red

```text
not ok 1 - N1 G4 menu destinations reload from the address and StartExam writes the encounter
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 18133.702042
exit=1
```

## fixback2-G1-green

```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 19793.386125
exit=0
```

## fixback2-G2-red

```text
not ok 1 - N1 fixback2 G2 Review never flashes unavailable before its first load settles
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5360.014291
exit=1
```

## fixback2-G2-green

```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3904.007459
exit=0
```

## fixback2-full

```text
# N1 WIDTH 1280 overview: 1280/1280; items=12; rows=2
# N1 WIDTH 1280 diagnoses: 1280/1280; items=12; rows=2
# N1 BILLING 1280: menu hit targets=12/12
# N1 WIDTH 1188 overview: 1188/1188; items=12; rows=2
# N1 WIDTH 1188 diagnoses: 1188/1188; items=12; rows=2
# N1 WIDTH 1024 overview: 1024/1024; items=12; rows=2
# N1 WIDTH 1024 diagnoses: 1024/1024; items=12; rows=2
# N1 WIDTH 834 overview: 834/834; items=12; rows=2
# N1 WIDTH 834 diagnoses: 834/834; items=12; rows=2
# N1 BILLING 834: menu hit targets=12/12
# tests 1921
# suites 0
# pass 1921
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 263938.146291
exit=0
```

## fixback2-build

```text
exit=0
```

## Status and follow-ups

Needs independent HUB reevaluation. No verdict posted, no CodeRabbit thread resolved, no merge or deployment. The prior bundles remain historical evidence; this record supersedes their destination mount and initial Review-loading behavior.

Existing out-of-scope follow-ups remain unchanged: menu state after closing Billing/Plan & Rx, hard-coded CSS colours, header clipping, stale test props, Billing unsaved input, persisted Tech role. No decision or terminology binding was introduced; no decisions index or Mandate 14 ledger update is needed.
