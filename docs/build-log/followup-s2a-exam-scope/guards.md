# Executed mutation guards

Each mutation was restored before its green run. Full output files are deliberately omitted; the following are command/count/failing-name summaries. G6 has separate row and trace mutations.

## G1

### red

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 1
not ok 16 - S2a G1 G3 scheduling categories cannot change default comprehensive content
not ok 17 - S2a G2 G4 G5 persisted scope changes only the scope record and retains every finding
not ok 19 - S2a G7 projection path cannot import or use the scheduling category
# tests 47
# pass 44
# fail 3
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 0
# tests 47
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G2

### red

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 1
not ok 17 - S2a G2 G4 G5 persisted scope changes only the scope record and retains every finding
# tests 47
# pass 46
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 0
# tests 47
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G3

### red

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 1
not ok 2 - derived completeness and prior change survive a fresh reload with zero clinical writes
not ok 16 - S2a G1 G3 scheduling categories cannot change default comprehensive content
not ok 45 - S2a scope store guards first creation and versioned edits
# tests 47
# pass 44
# fail 3
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 0
# tests 47
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G4

### red

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 1
not ok 1 - by-exception board renders exactly one row per performed or deferred finding
not ok 4 - refraction chooses the latest manifest, preserves stored signs, and keeps non-primary blocks collapsed
not ok 5 - refraction uses a manifest when present and otherwise labels the recorded non-final block by type
not ok 6 - refraction distance acuity never renders a code-only machine value
not ok 13 - a newer OD-only Wearing save retains the latest stored OS in the worksheet row
not ok 14 - a newer OD-only Wearing save retains both eyes in the refraction comparison
not ok 94 - S2a G4 G6 office scope retains recorded findings across both switches and uses exact scope copy
# tests 108
# pass 101
# fail 7
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 0
# tests 108
# pass 108
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G5

### red

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 1
not ok 95 - S2a G2 G5 G6 picker saves scope, reloads board and leaves visit billing props unchanged
# tests 108
# pass 107
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 0
# tests 108
# pass 108
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G6-row

### red

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 1
not ok 54 - worksheet rows expose owners and keep Contact Lenses visibly optional
not ok 94 - S2a G4 G6 office scope retains recorded findings across both switches and uses exact scope copy
# tests 108
# pass 106
# fail 2
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 0
# tests 108
# pass 108
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G6-trace

### red

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 1
not ok 63 - completeness moves to the chart bar, opens its trace, and disclaims billing-code meaning
not ok 95 - S2a G2 G5 G6 picker saves scope, reloads board and leaves visit billing props unchanged
# tests 108
# pass 106
# fail 2
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 0
# tests 108
# pass 108
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G7

### red

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 1
not ok 16 - S2a G1 G3 scheduling categories cannot change default comprehensive content
not ok 17 - S2a G2 G4 G5 persisted scope changes only the scope record and retains every finding
not ok 19 - S2a G7 projection path cannot import or use the scheduling category
# tests 47
# pass 44
# fail 3
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 0
# tests 47
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8

### red

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 1
not ok 87 - malformed nested finding, section, and completeness rows use the editor fallback
not ok 96 - S2a G8 unavailable projection retains the full SpineNav inventory and an available scope picker
# tests 108
# pass 103
# fail 5
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test ui/tests/examOverviewBoard.test.tsx
Exit: 0
# tests 108
# pass 108
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## store-version

### red

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 1
not ok 17 - S2a G2 G4 G5 persisted scope changes only the scope record and retains every finding
not ok 45 - S2a scope store guards first creation and versioned edits
# tests 47
# pass 45
# fail 2
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 0
# tests 47
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## store-create

### red

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 1
not ok 46 - S2a concurrent first selections keep one record and refuse the loser
# tests 47
# pass 46
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

### green

```text
Command: node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examOverviewProjection.test.ts mcp/tests/examScopeStore.test.ts
Exit: 0
# tests 47
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

