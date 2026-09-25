# N0 guard evidence

Synthetic data only. All runs used the dedicated `odos-n0-history-examined` Postgres container with `ODOS_POSTGRES_URL` set. `.odos/operator.env` and `.odos/operator-identity.json` were absent in this isolated worktree; no operator configuration was copied from the reader checkout.

Each command ran from `mcp/`:

```sh
node --import tsx --test --test-concurrency=1 --test-name-pattern="N0 G<N> " tests/examNavigationN0.test.ts
```

Each mutation was applied individually to production code, run, restored byte-for-byte, and run again. No existing assertions were edited. Red failures were assertion mismatches, not setup errors.

## G1: Bypass the History rule

Red assertion: expected `partial`, actual `examined`.

RED

```text
not ok 1 - N0 G1 summary plus an unanswered template complaint is partial and unresolved
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 226.756917
exit=1
```

GREEN

```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 198.278833
exit=0
```

## G2: Never mark a complaint row charted

Red assertion: expected `examined`, actual `partial`.

RED

```text
not ok 1 - N0 G2 presentation and every required section resolve History
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 236.674333
exit=1
```

GREEN

```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 205.908875
exit=0
```

## G3: Check only the presentation

Red assertion: expected `partial`, actual `examined`.

RED

```text
not ok 1 - N0 G3 presentation with a missing required section remains partial
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 236.834208
exit=1
```

GREEN

```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 206.151
exit=0
```

## G4: Count entered-in-error and cancelled answers

Red assertion: expected `partial`, actual `examined`.

RED

```text
not ok 1 - N0 G4 an entered-in-error presentation cannot complete History
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 240.066625
exit=1
```

GREEN

```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 210.76225
exit=0
```

## G5: Treat template-less complaints as uncharted

Red assertion: expected `examined`, actual `partial`.

RED

```text
not ok 1 - N0 G5 free-text, no complaint, and absent optional input keep the base result
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 231.004375
exit=1
```

GREEN

```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 207.938791
exit=0
```

## G6: Stop passing rows from the endpoint

Red assertion: expected `partial`, actual `examined`.

RED

```text
not ok 1 - N0 G6 real complaint, capture, and overview handlers change unresolved to resolved
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 231.594625
exit=1
```

GREEN

```text
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 205.366334
exit=0
```
