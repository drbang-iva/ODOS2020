# Guard evidence

All mutations were temporary and restored before final checks. Outputs below are test summaries, not full logs.

## UI-new-edit-error

Command: `node --import tsx --test --test-name-pattern=G1 Settings deactivate ui/tests/findingSectionGroups.test.tsx`

Red (exit 1):
```text
not ok 1 - G1 Settings deactivate sends its loaded version and displays the shared conflict message
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G1 Settings deactivate sends its loaded version and displays the shared conflict message
# tests 1
# pass 1
# fail 0
# skipped 0
```

## UI-new-create-error

Command: `node --import tsx --test --test-name-pattern=G1 Settings edit ui/tests/findingSectionGroups.test.tsx`

Red (exit 1):
```text
not ok 1 - G1 Settings edit sends its loaded version and displays the shared conflict message
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G1 Settings edit sends its loaded version and displays the shared conflict message
# tests 1
# pass 1
# fail 0
# skipped 0
```

## UI-create-version

Command: `node --import tsx --test --test-name-pattern=S1b G6 settings ui/tests/findingSectionGroups.test.tsx`

Red (exit 1):
```text
not ok 1 - S1b G6 settings creates edits and deactivates without category controls
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - S1b G6 settings creates edits and deactivates without category controls
# tests 1
# pass 1
# fail 0
# skipped 0
```

## UI-edit-version

Command: `node --import tsx --test --test-name-pattern=G1 Settings edit ui/tests/findingSectionGroups.test.tsx`

Red (exit 1):
```text
not ok 1 - G1 Settings edit sends its loaded version and displays the shared conflict message
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G1 Settings edit sends its loaded version and displays the shared conflict message
# tests 1
# pass 1
# fail 0
# skipped 0
```

## UI-active-version

Command: `node --import tsx --test --test-name-pattern=G1 Settings deactivate ui/tests/findingSectionGroups.test.tsx`

Red (exit 1):
```text
not ok 1 - G1 Settings deactivate sends its loaded version and displays the shared conflict message
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G1 Settings deactivate sends its loaded version and displays the shared conflict message
# tests 1
# pass 1
# fail 0
# skipped 0
```

## UI-conflict-message

Command: `node --import tsx --test --test-name-pattern=G1 Settings edit ui/tests/findingSectionGroups.test.tsx`

Red (exit 1):
```text
not ok 1 - G1 Settings edit sends its loaded version and displays the shared conflict message
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G1 Settings edit sends its loaded version and displays the shared conflict message
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G1

Command: `node --import tsx --test --test-name-pattern=G1 mcp/tests/findingSectionGroupConcurrency.test.ts`

Red (exit 1):
```text
not ok 1 - G1 stale Settings caller receives concurrent-edit and cannot overwrite a newer label
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G1 stale Settings caller receives concurrent-edit and cannot overwrite a newer label
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G2

Command: `node --import tsx --test --test-name-pattern=G2 mcp/tests/findingSectionGroupConcurrency.test.ts`

Red (exit 1):
```text
not ok 1 - G2 G4 concurrent catalogue creates have one accepted winner
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G2 G4 concurrent catalogue creates have one accepted winner
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G3

Command: `node --import tsx --test --test-name-pattern=G3 mcp/tests/findingSectionGroupConcurrency.test.ts`

Red (exit 1):
```text
not ok 1 - G3 concurrent first seed overlays have one accepted winner
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G3 concurrent first seed overlays have one accepted winner
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G4

Command: `node --import tsx --test --test-name-pattern=G2 mcp/tests/findingSectionGroupConcurrency.test.ts`

Red (exit 1):
```text
not ok 1 - G2 G4 concurrent catalogue creates have one accepted winner
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G2 G4 concurrent catalogue creates have one accepted winner
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G5

Command: `node --import tsx --test --test-name-pattern=G5 mcp/tests/findingSectionGroupConcurrency.test.ts`

Red (exit 1):
```text
not ok 1 - G5 concurrent first override writes leave exactly one physical row
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - G5 concurrent first override writes leave exactly one physical row
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G6

Command: `node --import tsx --test --test-name-pattern=stale group and encounter-override writes mcp/tests/findingSectionGroup.test.ts`

Red (exit 1):
```text
not ok 1 - stale group and encounter-override writes fail instead of overwriting concurrent versions
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - stale group and encounter-override writes fail instead of overwriting concurrent versions
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G7

Command: `node --import tsx --test --test-name-pattern=S1 G1 removal mcp/tests/findingSectionGroup.test.ts`

Red (exit 1):
```text
not ok 1 - S1 G1 removal freshly refuses saved custom-section content without writing
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored green (exit 0):
```text
ok 1 - S1 G1 removal freshly refuses saved custom-section content without writing
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G8 — verification only

From ui: `node --import tsx --test tests/findingSectionGroups.test.tsx tests/clinicalGraphRouting.test.tsx`

```text
ok 2 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
# tests 21
# pass 21
# fail 0
# skipped 0
```

The inventory assertion is still 57 and every per-caller assertion ran. That test file is unchanged.

G7 scheduling-category behavior: catalogue and override runtime paths contain no Appointment/HealthcareService reads or category-resolution calls. All S1/S1b tests remain present and passing. The G7 mutation permits populated removal; the saved-content assertion then fails.

G6 preserves the existing injected version bump between store read and update, the unchanged-data assertions, both override assertions, and the two exact If-Match headers. The catalogue rejection now expects 409 because the requested store translates 412; the override still expects 412. Its mutation swallows that catalogue refusal and returns success, making assert.rejects fail.
