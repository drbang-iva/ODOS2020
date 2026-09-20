# Guard mutation evidence

Command: `node docs/build-log/followup-s2b2a-collapse/mutations.mjs`.

Each mutation was applied alone, the named test command ran against it, the original bytes were restored in `finally`, and the same command ran again. No guard survived. Outputs below are summaries, not full logs. The runner checks the restored source SHA-256.

An initial attempt ran the browser fixture from the repository root instead of the UI package, giving five unrelated CSS/geometry failures in both states. Running from `ui/`, matching the package command, restored the correct stylesheet context. The final results below supersede that attempt; no assertion was weakened.

## G1

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 2
# fail 12
# cancelled 0
# skipped 0
# todo 0
not ok 2 - S2b2a G1 G8 real save/read/clear and writer pin: iop
not ok 3 - S2b2a G1 G8 real save/read/clear and writer pin: cup-disc
not ok 4 - S2b2a G1 G8 real save/read/clear and writer pin: auto-refraction
not ok 5 - S2b2a G1 G8 real save/read/clear and writer pin: cover-test
not ok 6 - S2b2a G1 G8 real save/read/clear and writer pin: manual-keratometry
not ok 7 - S2b2a G1 G8 real save/read/clear and writer pin: color-vision
not ok 8 - S2b2a G1 G8 real save/read/clear and writer pin: stereopsis
not ok 9 - S2b2a G1 G8 real save/read/clear and writer pin: hpi
not ok 10 - S2b2a G1 G8 real save/read/clear and writer pin: ocular-health:anterior:cornea
not ok 11 - S2b2a G1 G8 real save/read/clear and writer pin: dry-eye:tear-volume
not ok 12 - S2b2a G1 G8 real save/read/clear and writer pin: custom:synthetic
not ok 13 - S2b2a G4 unregistered, registered unknown, and Other findings fail closed
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G2

`ui/src/components/charting/ExamOverviewBoard.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examViewState.test.tsx)
RED: exit 1
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 3 - S2b2a G2 G7 view controls never fetch or call chart mutation props; shelf opening restores the line
RESTORED: exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G2-active

`ui/src/components/charting/ExamOverviewBoard.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examViewState.test.tsx)
RED: exit 1
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 7 - S2b2a G2 active empty sheets cannot be shelved; collapsed preferences do not draw an absent line
RESTORED: exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G3

`ui/src/components/charting/ExamOverviewBoard.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examViewState.test.tsx)
RED: exit 1
# tests 7
# pass 2
# fail 5
# cancelled 0
# skipped 0
# todo 0
not ok 2 - S2b2a G3 collapsed data stays in order, summarizes values, survives remount and expands
not ok 3 - S2b2a G2 G7 view controls never fetch or call chart mutation props; shelf opening restores the line
not ok 4 - S2b2a G6 persisted shelving loses to saved data and unknown evidence, even outside scope
not ok 5 - S2b2a G10 absent and throwing storage keeps the board open and collapse works in-session
not ok 6 - S2b2a G3 collapsed empty rows stay drawn, unmapped values use the fallback, and the editor still opens
RESTORED: exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G4-default

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 13 - S2b2a G4 unregistered, registered unknown, and Other findings fail closed
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G4-other

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 13 - S2b2a G4 unregistered, registered unknown, and Other findings fail closed
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G5-iop

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 12
# fail 2
# cancelled 0
# skipped 0
# todo 0
not ok 1 - S2b2a G5 every inventory entry has an explicit evidence decision, including unknown procedures
not ok 2 - S2b2a G1 G8 real save/read/clear and writer pin: iop
error: 'Missing registry decision: iop'
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G5-procedure

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 1 - S2b2a G5 every inventory entry has an explicit evidence decision, including unknown procedures
error: 'Missing registry decision: procedure:synthetic'
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G5-new-entry

`ui/src/components/charting/SpineNav.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 1 - S2b2a G5 every inventory entry has an explicit evidence decision, including unknown procedures
error: 'Missing registry decision: synthetic-unregistered'
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G6

`ui/src/components/charting/ExamOverviewBoard.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examViewState.test.tsx)
RED: exit 1
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 4 - S2b2a G6 persisted shelving loses to saved data and unknown evidence, even outside scope
RESTORED: exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G7

`ui/src/components/charting/ExamOverviewBoard.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examViewState.test.tsx)
RED: exit 1
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 3 - S2b2a G2 G7 view controls never fetch or call chart mutation props; shelf opening restores the line
RESTORED: exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-cover-test

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 5 - S2b2a G1 G8 real save/read/clear and writer pin: cover-test
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-color-vision

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 7 - S2b2a G1 G8 real save/read/clear and writer pin: color-vision
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-stereopsis

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 8 - S2b2a G1 G8 real save/read/clear and writer pin: stereopsis
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-iop

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 2 - S2b2a G1 G8 real save/read/clear and writer pin: iop
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-cup-disc

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 3 - S2b2a G1 G8 real save/read/clear and writer pin: cup-disc
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-manual-keratometry

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 6 - S2b2a G1 G8 real save/read/clear and writer pin: manual-keratometry
Missing writer pin: manual_keratometry -> manual-keratometry
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-auto-refraction

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 4 - S2b2a G1 G8 real save/read/clear and writer pin: auto-refraction
Missing writer pin: auto_refraction -> auto-refraction
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-hpi

`ui/src/lib/exam-editor-map.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 9 - S2b2a G1 G8 real save/read/clear and writer pin: hpi
Missing writer pin: hpi_ros -> hpi
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G9

`ui/src/components/charting/SpineNav.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx)
RED: exit 1
# tests 14
# pass 13
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 14 - S2b2a G9 SpineNav renders every entry of the board inventory, including on-demand entries
error: 'SpineNav missing iop'
RESTORED: exit 0
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G10

`ui/src/lib/exam-view-state.ts`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examViewState.test.tsx)
RED: exit 1
# tests 7
# pass 5
# fail 2
# cancelled 0
# skipped 0
# todo 0
not ok 1 - S2b2a G10 storage is scoped by encounter and malformed or inaccessible storage opens everything
not ok 5 - S2b2a G10 absent and throwing storage keeps the board open and collapse works in-session
RESTORED: exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G11

`ui/src/components/charting/ExamOverviewBoard.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/examShelf.test.tsx)
RED: exit 1
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 7 - S2b1 G8 scope determines drawn lines regardless of scheduling category
RESTORED: exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## assertion-migration

`ui/src/components/charting/ExamOverviewBoard.tsx`

```text
(cd ui && node --import tsx --test --test-concurrency=1 tests/entrySheets.test.tsx)
RED: exit 1
# tests 50
# pass 49
# fail 1
# cancelled 0
# skipped 0
# todo 0
not ok 34 - the comprehensive worksheet renders all 17 Ocular Health rows in anatomical order
RESTORED: exit 0
# tests 50
# pass 50
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
