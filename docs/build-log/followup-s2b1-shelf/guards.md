# S2b-1 guard mutation evidence

Each mutation was applied alone, produced the named behavioral failures, and was restored byte-for-byte before its green run. G5 changes the actual server refusal. No endpoint change is committed.

## G1

File: `ui/src/components/charting/ExamOverviewBoard.tsx`.

Command:

```sh
cd ui && node --import tsx --test tests/examShelf.test.tsx
```

Red:

```text
exit 1
not ok 1 - S2b1 G1 G2 shelf and drawn lines partition the whole inventory: office-visit
not ok 2 - S2b1 G1 G2 shelf and drawn lines partition the whole inventory: comprehensive
# tests 7
# pass 5
# fail 2
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
```

## G2

File: `ui/src/components/charting/ExamOverviewBoard.tsx`.

Command:

```sh
cd ui && node --import tsx --test tests/examShelf.test.tsx
```

Red:

```text
exit 1
not ok 1 - S2b1 G1 G2 shelf and drawn lines partition the whole inventory: office-visit
not ok 2 - S2b1 G1 G2 shelf and drawn lines partition the whole inventory: comprehensive
# tests 7
# pass 5
# fail 2
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
```

## G3

File: `ui/src/scenes/EncounterCharting.tsx`.

Command:

```sh
cd ui && node --import tsx --test tests/examOverviewBoard.test.tsx
```

Red:

```text
exit 1
not ok 101 - S2b1 G3 shelf opens Macula at its exam position without changing scope visit type or diagnoses
# tests 110
# pass 109
# fail 1
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 110
# pass 110
# fail 0
# cancelled 0
# skipped 0
```

## G4

File: `ui/src/components/charting/ExamOverviewBoard.tsx`.

Command:

```sh
cd ui && node --import tsx --test tests/examOverviewBoard.test.tsx
```

Red:

```text
exit 1
not ok 102 - S2b1 G4 inactive available group pulls in from the shelf and draws lines on the same board
# tests 110
# pass 109
# fail 1
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 110
# pass 110
# fail 0
# cancelled 0
# skipped 0
```

## G5

File: `mcp/src/clinical-graph/finding-section-group-endpoint.ts`.

Command:

```sh
cd mcp && node --import tsx --test tests/findingSectionGroup.test.ts
```

Red:

```text
exit 1
not ok 13 - S1 G1 removal freshly refuses saved custom-section content without writing
not ok 14 - S1 G2 atomic present pins its group
not ok 15 - S1 G2 atomic explicit absent pins its group
not ok 20 - S1 G8 meibography writer image and score each independently pin gland structure
not ok 21 - S1 G8 MCP questionnaire response independently pins symptoms
not ok 22 - S1 G8 MCP questionnaire score independently pins symptoms
not ok 27 - S1b G4 chart atomic writer live then clear unpins and permits removal
# tests 27
# pass 20
# fail 7
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 27
# pass 27
# fail 0
# cancelled 0
# skipped 0
```

## G5-pin

File: `ui/src/components/charting/ExamOverviewBoard.tsx`.

Command:

```sh
cd ui && node --import tsx --test tests/examShelf.test.tsx
```

Red:

```text
exit 1
not ok 4 - S2b1 G5 content-pinned groups retain the pin wording without a removal affordance
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
```

## G6

File: `ui/src/components/charting/ExamOverviewBoard.tsx`.

Command:

```sh
cd ui && node --import tsx --test tests/examShelf.test.tsx
```

Red:

```text
exit 1
not ok 5 - S2b1 G6 unmatched findings keep value eye and date in their row, including an unknown section
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
```

## G7

File: `ui/src/components/charting/ExamOverviewBoard.tsx`.

Command:

```sh
cd ui && node --import tsx --test tests/examShelf.test.tsx
```

Red:

```text
exit 1
not ok 6 - S2b1 G7 both carried states are drawn and unreasserted retains its count
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
```

## G8

File: `ui/src/components/charting/ExamOverviewBoard.tsx`.

Command:

```sh
cd ui && node --import tsx --test tests/examShelf.test.tsx
```

Red:

```text
exit 1
not ok 7 - S2b1 G8 scope determines drawn lines regardless of scheduling category
# tests 7
# pass 6
# fail 1
# cancelled 0
# skipped 0
```

Restored green:

```text
exit 0
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
```

## G5 restoration check

```sh
git diff --stat -- mcp/src/clinical-graph/finding-section-group-endpoint.ts
```

Output: empty (zero lines); exit 0.

## Shelf clearance at 390px

Command: `node docs/build-log/followup-s2b1-shelf/proof/browser.mjs <base-worktree> --clearance-only`. This additional real-browser guard checks the last shelf entry against the existing build-stamp rectangle.

Red with 24px bottom padding:

```text
Shelf clearance: entry bottom 1265; stamp top 1244.4375
AssertionError: The shelf last entry must clear the build stamp
exit 1
```

Green with 72px bottom padding:

```text
Shelf clearance: entry bottom 1217; stamp top 1244.4375
exit 0
```

The test exposed a 20.5625px overlap and verifies a 27.4375px clearance after the spacing correction. No build-stamp or header behavior was changed.
