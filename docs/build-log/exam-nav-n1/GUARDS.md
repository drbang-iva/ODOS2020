# N1 guard evidence

Every mutation was restored before its green run. No forced clicks, inert removal, direct finish-function invocation, or server changes were used.

G1 exercises all 144 ordered destination pairs and keyboard order. Its Billing exits hide the sheet; the existing open flag controls both active and hidden. G6 uses real clicks on the header, Review, Add findings, and Sign anyway, and checks the short label, unresolved rows, and Nothing open. G8 checks both chart destinations at all four widths plus Billing hit targets at 1280 and 834.

The pinned L3 expressions are `/onClick=\{onReviewAndSign\}/` and `/onSignAndFinish: requestFinishEncounter/`. All other L3 assertions remain verbatim.

## Commands

Run from the repository root with operator files moved aside, Node 22, installed UI dependencies, and Chrome. `run.py` refuses to proceed while either operator file is present. Full logs stay in gitignored `.odos/n1-evidence`; only summaries are committed.

```sh
python3 docs/build-log/exam-nav-n1/run.py final-ui npm --prefix ui test
python3 docs/build-log/exam-nav-n1/prove.py
```

The reproducer obtains the sorted file list using Node’s glob implementation and applies its supported `--test-shard` and `--test-name-pattern` options through NODE_OPTIONS. The package script itself is unchanged. At this checkout N1 is shard 57/159, L3 is 39/159, and encounterVoid is 48/159. G1–G3 were originally proved without sharding; their npm runner counts include nonmatching file workers and three fixture-lifecycle smoke tests. Later pairs execute one named test in one file.

| Mutation | Red: tests/pass/fail; exit | Restored green: tests/pass/fail; exit |
|---|---|---|
| G1 | 160/159/1; exit=1 | 160/160/0; exit=0 |
| G2 | 159/158/1; exit=1 | 159/159/0; exit=0 |
| G3 | 160/159/1; exit=1 | 160/160/0; exit=0 |
| G4 | 1/0/1; exit=1 | 1/1/0; exit=0 |
| G5 | 1/0/1; exit=1 | 1/1/0; exit=0 |
| G6-header | 1/0/1; exit=1 | 1/1/0; exit=0 |
| G7 | 1/0/1; exit=1 | 1/1/0; exit=0 |
| G8-width | 1/0/1; exit=1 | 1/1/0; exit=0 |
| G8-modal | 1/0/1; exit=1 | 1/1/0; exit=0 |
| G8-cover | 1/0/1; exit=1 | 1/1/0; exit=0 |
| L3-slot | 1/0/1; exit=1 | 1/1/0; exit=0 |
| L3-handoff | 1/0/1; exit=1 | 1/1/0; exit=0 |
| G6-short | 1/0/1; exit=1 | 1/1/0; exit=0 |
| G6-stack | 1/0/1; exit=1 | 1/1/0; exit=0 |
| R3-clear | 1/0/1; exit=1 | 1/1/0; exit=0 |

## G1

Remove Entrance from the menu registry; the real 12×12 navigation guard fails.

Red:
```text
not ok 57 - N1 G1 all twelve destinations remain one menu move away from every destination
# tests 160
# suites 0
# pass 159
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 60561.138
exit=1
```

Restored green:
```text
# tests 160
# suites 0
# pass 160
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 67133.26325
exit=0
```

## G2

Restore a read of odos:encounter-chart-view; the storage spy fails.

Red:
```text
not ok 57 - N1 G2 the real exam neither renders the toggle nor accesses its old preference
# tests 159
# suites 0
# pass 158
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 53848.346125
exit=1
```

Restored green:
```text
# tests 159
# suites 0
# pass 159
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 55238.125458
exit=0
```

## G3

Default Doctor to Diagnoses; the real landing guard fails.

Red:
```text
not ok 58 - N1 G3 address wins over Tech, which wins over Overview landing
# tests 160
# suites 0
# pass 159
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 55050.1795
exit=1
```

Restored green:
```text
# tests 160
# suites 0
# pass 160
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 62005.399041
exit=0
```

## G4

Restore StartExam’s bare setView call; encounterId is absent from the address.

Red:
```text
not ok 1 - N1 G4 menu destinations reload from the address and StartExam writes the encounter
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10123.28075
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4914.989083
exit=0
```

## G5

Bypass requestTransition; the real dirty HPI sheet disappears without confirmation.

Red:
```text
not ok 1 - N1 G5 declining a dirty History transition retains its text and sheet
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9839.475958
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3932.273875
exit=0
```

## G6-header

Wire the header slot to requestFinishEncounter; the header no longer only opens Review.

Red:
```text
not ok 1 - N1 G6 header opens Review without signing and Review preserves advisory signing
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8920.970375
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5052.754708
exit=0
```

## G7

Restore Partial examination; the History trace label guard fails.

Red:
```text
not ok 1 - N1 G7 partial History reads In progress
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5216.778625
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3779.84175
exit=0
```

## G8-width

Give the menu a 1400px minimum width; full-label width checks fail.

Red:
```text
# N1 WIDTH 1280 overview: 1280/1280; items=12; rows=2
not ok 1 - N1 G8 all menu labels fit two rows at every required width
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3684.195042
exit=1
```

Restored green:
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
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6460.136875
exit=0
```

## G8-modal

Restore modal Billing; the menu’s centre-point hit checks fail.

Red:
```text
# N1 WIDTH 1280 overview: 1280/1280; items=12; rows=2
# N1 WIDTH 1280 diagnoses: 1280/1280; items=12; rows=2
# N1 BILLING 1280: menu hit targets=0/12
not ok 1 - N1 G8 all menu labels fit two rows at every required width
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4001.723708
exit=1
```

Restored green:
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
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8242.245875
exit=0
```

## G8-cover

Position the Billing sheet over the whole viewport; the centre-point hit checks fail.

Red:
```text
# N1 WIDTH 1280 overview: 1280/1280; items=12; rows=2
# N1 WIDTH 1280 diagnoses: 1280/1280; items=12; rows=2
# N1 BILLING 1280: menu hit targets=0/12
not ok 1 - N1 G8 all menu labels fit two rows at every required width
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3884.302625
exit=1
```

Restored green:
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
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6276.95775
exit=0
```

## L3-slot

Rename onReviewAndSign inside EncounterHeader.tsx; the slot wiring regex fails.

Red:
```text
not ok 1 - diagnosis completeness is called only from the explicit EncounterHeader sign path
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 301.291291
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 265.874875
exit=0
```

## L3-handoff

Rename the onSignAndFinish property at the hand-off; the hand-off regex fails.

Red:
```text
not ok 1 - diagnosis completeness is called only from the explicit EncounterHeader sign path
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 266.836792
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 261.04425
exit=0
```

## G6-short

Restore the short label Sign; G6 fails before its signing flow.

Red:
```text
not ok 1 - N1 G6 header opens Review without signing and Review preserves advisory signing
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3758.889167
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5166.594375
exit=0
```

## G6-stack

Lower the advisory to z-index 50; a real Add findings click is intercepted by the right panel.

Red:
```text
not ok 1 - N1 G6 header opens Review without signing and Review preserves advisory signing
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10517.538542
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4826.597
exit=0
```

## R3-clear

Gate Clear chart on !modal again; the unchanged non-clinical-sheet assertion fails.

Red:
```text
not ok 1 - the visit-level control is disabled with the amendment tooltip after sign and absent from non-clinical sheets
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 425.035458
exit=1
```

Restored green:
```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 368.543458
exit=0
```
