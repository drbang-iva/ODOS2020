# N1 fixback F1–F4

NOT EVALUATED

Coded-by: Codex — GPT-5.6 Sol, high effort

Fixback to the HUB FAIL at `06a5c83eb937c684198fb631d7ccba32cfec05a9`, on the same branch and PR #672. The original bundle remains historical evidence. This record supersedes its raw-state Review behavior and its completed local counts. CI and PR-Agent outcomes at the pushed head are recorded in the PR body so recording CI does not create an untested new head.

| Item | Fix | Files | Guard proof |
|---|---|---|---|
| F1 | Review uses the board’s existing sectionStateLabel. Only `export` was added to the board file. G6 checks all six state texts: History In progress; five Not examined. | ExamOverviewBoard.tsx, ExamReview.tsx, examNavigationN1.test.tsx | Raw row.state: 0 pass / 1 fail, exit 1; restored: 1 pass / 0 fail, exit 0. |
| F2 | Loading uses the existing projection-loading flag. Missing projection after loading says Status unavailable; unconfigured scope says Not tracked — no exam scope set; only configured, fully resolved completeness says Nothing open. | ExamReview.tsx, EncounterCharting.tsx, exam-navigation-n1.tsx, examNavigationN1.test.tsx | Each unconfigured and unavailable mutation: 0 pass / 1 fail, exit 1; each restored: 1 pass / 0 fail, exit 0. |
| F3 | A real migrated-encounter fixture reaches Review through its address; the guard asserts both buttons disabled and their titles equal. No finish logic changed. | exam-navigation-n1.tsx, examNavigationN1.test.tsx | disabled={false}: 0 pass / 1 fail, exit 1; restored: 1 pass / 0 fail, exit 0. |
| F4 | Navigation gets a separate 30,000 ms timeout for Vite cold compilation. Locator timeout stays 5,000 ms; no G1 assertions changed. | examNavigationN1.test.tsx | Real G1 runs in focused/full local UI and CI. CI counts and run URL are in the PR body. |

Product paths are under ui/src/components/charting/, except EncounterCharting.tsx under ui/src/scenes/. Tests are under ui/tests/; the fixture is under ui/tests/fixtures/. The other changes are this evidence, the mutation reproducer, and updated synthetic Review captures.

## Verification

Operator files remained absent; the runner verified this and stripped ODOS_/MEDPLUM_ values. No MCP types changed, so no conditional local MCP run was required. No database/container was touched. All mutation runs use the unchanged npm UI command with native Node test sharding; no bare tsx invocation.

```sh
python3 docs/build-log/exam-nav-n1/prove.py F1-labels F2-unconfigured F2-unavailable F3-disabled
python3 docs/build-log/exam-nav-n1/run.py fixback-full npm --prefix ui test
python3 docs/build-log/exam-nav-n1/run.py fixback-build npm --prefix ui run build
```

## F1-labels

red:
```text
not ok 1 - N1 G6 header opens Review without signing and Review preserves advisory signing
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3837.886916
exit=1
```

green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4629.965792
exit=0
```

## F2-unconfigured

red:
```text
not ok 1 - N1 F2 unconfigured Review does not claim Nothing open
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8807.849291
exit=1
```

green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3666.700459
exit=0
```

## F2-unavailable

red:
```text
not ok 1 - N1 F2 failed projection Review reports unavailable
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8838.023209
exit=1
```

green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3774.958166
exit=0
```

## F3-disabled

red:
```text
not ok 1 - N1 F3 migrated Review preserves header sign disable rule and title
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3740.60725
exit=1
```

green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3729.744875
exit=0
```

## fixback-focused

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
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 28821.749542
exit=0
```

## fixback-full

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
# tests 1920
# suites 0
# pass 1920
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 255132.181791
exit=0
```

## fixback-build

```text
exit=0
```

## Captures and follow-ups

[Corrected Review labels](review.png) · [Unconfigured](review-unconfigured.png) · [Projection unavailable](review-unavailable.png). Captured with real components and synthetic data at 1280×1100; reviewed locally. These are fixture evidence, not live-server or AccessPolicy proof. Capture server closed.

The original 15 mutation pairs remain in GUARDS.md. This fixback adds four pairs. The earlier four failures and R3 correction remain documented in README.md.

Unchanged follow-ups: Billing and Plan & Rx menu state after closing; hard-coded CSS colours; header clipping; stale test props; Billing unsaved-input checks; persisted Tech role. No new decision or terminology binding was introduced; no decisions index or Mandate 14 ledger update is required.

Status: needs-review. The coder has not posted a verdict or resolved any CodeRabbit thread. Independent HUB reevaluation is required at the new head. No merge or deployment.
