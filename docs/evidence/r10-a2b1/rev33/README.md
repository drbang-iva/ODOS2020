# Rev 3.3 authorized capture-hook retirement

Operator authorized exactly one removed hook entry in capture-baseline.mjs and one README sentence; no other changes to either file. Existing assertion bodies are unchanged. Mapping: W-c (findings GET now uses the reader) and rev3.3 §4; saved atomic/section captures still compare through compatRows.

Guard: misspell the still-existing buildExamOverviewProjection hook as buildExamOverviewProjectionMisspelled. The capture-wrapper test fails:1 test,0 pass,1 fail,exit1 (`capture-hook-red.tap`). Restore the spelling: full parity170 tests,170 pass,0 fail/skip/todo,exit0 (`parity-green.tap`). Other named hooks remain strict; no ignore-missing fallback was added.

Both immutable files match origin/main byte-for-byte; exact SHA256 values in `immutable-hashes.txt`. The 17 replay probes and all five divergences still assert.

Full MCP rerun uses private local synthetic credentials and test Postgres; MEDPLUM_PROJECT_ID is explicitly unset so live helpers derive their own project. No assertion relaxation or new skip was introduced.
