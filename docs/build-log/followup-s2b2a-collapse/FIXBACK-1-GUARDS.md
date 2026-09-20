# Fixback 1 REV 2 — guard failure and restoration evidence

Each temporary mutant was verified in place, then restored byte-for-byte before its green run. No persistent saved-ID state is shipped.

G-FB2 is explicitly fault injection: the saved editor has no shelving control in the fixed UI; the test calls the actual scene handler directly. G-FB6 reaches the scene through successful section/encounter clear callbacks and drives an actual failed clear through the confirmation UI and its failure handler.

## G-FB1

Mutation in `ui/src/components/charting/ExamOverviewBoard.tsx`:

```text
data === false && saved.has(editor.id) ? "unknown" : data
→
data
```

Command: `(cd ui && node --import tsx --test --test-concurrency=1 --test-name-pattern=G-FB1 tests/examStaleShelve.test.tsx)`

RED:

```text
exit 1
not ok 1 - S2b2a G-FB1 a session-saved IOP stays drawn and collapse-only on a racing projection, then data wins after refresh
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

RESTORED GREEN:

```text
exit 0
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G-FB2 fault injection

Mutation in `ui/src/scenes/EncounterCharting.tsx`:

```text
savedEditorIds.includes(sectionId) || 
→

```

Command: `(cd ui && node --import tsx --test --test-concurrency=1 --test-name-pattern=G-FB2 tests/examOverviewBoard.test.tsx)`

RED:

```text
exit 1
not ok 1 - S2b2a G-FB2 fault injection: direct shelve handler for a session-saved editor is unreachable through the UI and writes nothing
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

RESTORED GREEN:

```text
exit 0
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G-FB3

Mutation in `ui/src/components/charting/ExamOverviewBoard.tsx`:

```text
const saved = new Set(savedEditorIds);
→
const saved = new Set(editorEntries.map(editor => editor.id));
```

Command: `(cd ui && node --import tsx --test --test-concurrency=1 --test-name-pattern=G-FB3 tests/examStaleShelve.test.tsx)`

RED:

```text
exit 1
not ok 1 - S2b2a G-FB3 a never-saved proven-empty line still shelves and returns
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

RESTORED GREEN:

```text
exit 0
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G-FB4

Mutation in `ui/src/components/charting/ExamOverviewBoard.tsx`:

```text
if (shelved.has(editor.id)) return data !== false || editor.id === activeEditorId;
→
if (shelved.has(editor.id)) return false;
```

Command: `(cd ui && node --import tsx --test --test-concurrency=1 --test-name-pattern=G-FB4 tests/examStaleShelve.test.tsx)`

RED:

```text
exit 1
not ok 1 - S2b2a G-FB4 persisted shelf marks still lose to projected data and registry unknown
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

RESTORED GREEN:

```text
exit 0
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G-FB5

Mutation in `ui/src/lib/exam-editor-map.ts`:

```text
if (editorSheetSection(editor) === "history" && projection.historySummary) return true;
→
return false;
  if (editorSheetSection(editor) === "history" && projection.historySummary) return true;
```

Command: `(cd ui && node --import tsx --test --test-concurrency=1 tests/examEditorMap.test.tsx tests/examViewState.test.tsx)`

RED:

```text
exit 1
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
not ok 16 - S2b2a G3 collapsed data stays in order, summarizes values, survives remount and expands
not ok 17 - S2b2a G2 G7 view controls never fetch or call chart mutation props; shelf opening restores the line
not ok 18 - S2b2a G6 persisted shelving loses to saved data and unknown evidence, even outside scope
not ok 19 - S2b2a G10 absent and throwing storage keeps the board open and collapse works in-session
not ok 20 - S2b2a G3 collapsed empty rows stay drawn, unmapped values use the fallback, and the editor still opens
# tests 21
# pass 4
# fail 17
# cancelled 0
# skipped 0
# todo 0
```

RESTORED GREEN:

```text
exit 0
# tests 21
# pass 21
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G-FB6

Mutation in `ui/src/scenes/EncounterCharting.tsx`:

```text
const savedEditorIds = Object.keys(statuses);
→
const retainedSavedEditorIds = useRef(new Set<string>());
  Object.keys(statuses).forEach(id => retainedSavedEditorIds.current.add(id));
  const savedEditorIds = [...retainedSavedEditorIds.current];
```

Command: `(cd ui && node --import tsx --test --test-concurrency=1 --test-name-pattern=G-FB6 tests/examOverviewBoard.test.tsx)`

RED:

```text
exit 1
not ok 1 - S2b2a G-FB6 successful section clear removes saved-ID protection through the scene handler
not ok 2 - S2b2a G-FB6 successful encounter clear removes saved-ID protection through the scene handler
# tests 3
# pass 1
# fail 2
# cancelled 0
# skipped 0
# todo 0
```

RESTORED GREEN:

```text
exit 0
# tests 3
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
