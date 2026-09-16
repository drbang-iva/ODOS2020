# A2b.2 table and findings client evidence

Owned files: ui/src/lib/diagnosis-findings.ts, ui/src/components/charting/DiagnosisFindingsTable.tsx, ui/tests/r10DiagnosisTable.test.tsx.

No existing assertions changed in this subtask; new tests cover the canonical command contract. The separately owned existing-test migration records its own before/after ledger.

Validation from the ui directory: `node --import tsx --test tests/r10DiagnosisTable.test.tsx`: 16 tests, 16 pass, 0 fail, 0 skip (unit.txt). `npx tsc --noEmit --skipLibCheck`: exit 0, no diagnostics (typecheck.txt). Scoped `git diff --check`: exit 0.

Mutation proof:
- W9: replaced `rows.map(target)` with `rows.slice(0,1).map(target)`; OU real-component click failed its two-target assertion (exit 1), restored source passed (exit 0).
- W48: removed the encounterEditable predicate from canMutateDiagnosisFinding; real-component pre-rebuild control test failed (exit 1), restored source passed (exit 0).
- W50: removed the excluded-retained-eye filter from eye-change targets; real-component OU to OD test failed on target length 2 versus 1 (exit 1), restored source passed (exit 0).
- Per-guard full TAP is in W9/W48/W50-red.txt and -green.txt.

Additional tests exercise offered assert, grade, search reassert, move/standalone tray commands, grouping refusal, row read-only reasons, unknown eye selection, retired owner revival, live-home filtering, non-2xx body/status preservation, repair body/route, and shared outcome branches. W46 and W53 named tests are additional checks; their mutation proof is owned by the parent task.

No server changes, commits, pushes, Docker containers, or independent evaluation were performed by this subtask. NOT EVALUATED. Full suites, visual evidence and PR finalization are parent-owned.
