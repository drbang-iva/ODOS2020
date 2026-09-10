# SEQ-2 timing author evidence

Base: `969526f7`. Branch: `drbang-iva/seq2-timing`.
Scope: pure timing helper, focused tests, this evidence. No dependencies added.

`calculateEducationSequenceTime(row, predecessor?, resolveCalendar?)` returns a UTC
`effectiveAt` or a held calculation with a diagnostic reason. Those diagnostic reasons
are not additions to the persisted scheduling hold-reason union; the worker maps them.
Stage-entry uses the row's own already-authored `notBefore` without applying its offset
again. Predecessor pacing uses explicitly supplied recorded acceptance or clinician
skip, never forecast. `educationLocalDay(instant, timezone)` provides the spacing day.

Calendar offsets preserve wall-clock time. Nonexistent time advances to the first
valid instant; repeated time uses the first occurrence. Business offsets require an
exact id/version definition supplied by the caller, with explicit working weekdays
(Sunday 0) and local-date holidays. Missing, mismatched, or empty calendars hold.
No weekend or holiday policy is assumed. Stage-entry does not recalculate its
already-authored instant using a calendar.

## Executed checks

`npm ci --ignore-scripts` in the isolated worktree's `mcp/`:
exit 0, `added 262 packages, and audited 263 packages in 1s`.
Existing dependency audit reported `10 vulnerabilities (7 moderate, 3 high)`;
no dependency or lockfile changes made.

All focused runs used:

```sh
npm test -- --ui-root /Users/ericr.bang/GitHub/ODOS2020/ui tests/educationSequenceTiming.test.ts
```

- Initial missing-module run: exit 1, tests 1 / pass 0 / fail 1. This was a setup
  failure, not counted as the behavioral RED.
- Behavioral RED with a minimal forecast-returning stub: exit 1,
  tests 10 / pass 0 / fail 10 / skipped 0. Real assertions failed.
- Implementation GREEN: exit 0, tests 10 / pass 10 / fail 0 / skipped 0.
- Break-and-restore: replaced the missing/unknown predecessor hold with a ready
  result using `row.plannedAt`. Exit 1, tests 10 / pass 9 / fail 1 / skipped 0.
  `missing or unknown acceptance holds without using forecast` failed with actual
  `{status: "ready", effectiveAt: "2026-03-01T10:00:00Z"}` versus expected
  `{status: "held", reason: "predecessor-anchor-unavailable"}`.
- Restored GREEN: exit 0, tests 10 / pass 10 / fail 0 / skipped 0.

`./node_modules/.bin/tsc --noEmit` from `mcp/`: exit 2. Root-shared script resolution
failed: `../scripts/access-policy-rules.ts(1,35): error TS2307: Cannot find module
'@medplum/fhirtypes' or its corresponding type declarations.` Consequent TS7006
errors for `rule`, `left`, and `right` on lines 34-35. This isolated checkout has only
its own `mcp` dependencies installed. No timing-file diagnostics were emitted;
this is not a clean full-project typecheck claim.

## Integration boundaries

The caller must supply verified acceptance or clinician-skip evidence. This helper
does not invent a skip from a resolved/not-sent attempt or generic lifecycle event.
Existing rows have only a calendar pin, not the definition. The worker must supply
its actual pinned definition source; absence holds. Clinician skip storage and
calendar resolution are upstream responsibilities. This helper does not dispatch,
change enrollment status, enforce latest-useful-time, or enforce spacing atomically.
Runtime timezone rules come from Node's installed ICU data.

Status: implemented with author test evidence; independent evaluation still required.
No PR, push, merge, or self-evaluation performed.
