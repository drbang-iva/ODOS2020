# Protocol fixture reconciliation — rev 2.6

Command: `node --import tsx --test mcp/src/__tests__/{protocol-phase5,plan-carried,plan-glaucoma-integration,plan-materialization,plan-offered}.test.ts` (paths expanded explicitly by Python).

Environment: subprocess inherits host environment with all keys beginning `MEDPLUM` or `ODOS_` removed; no env files loaded; no full suite invoked.

- Original focused result: 156 tests, 113 pass, 43 fail, 0 skip/todo (`before.tap`).
- Final focused result: 156 tests, 156 pass, 0 fail/skip/todo (`after-reconciliation.tap`).
- Six fixture files changed: five named tests and `mcp/src/__tests__/helpers/plan-authoring-fhir.ts`.
- Original private snapshots: `.odos/r10-a3-1/rev26-protocol-original/`.
- Fixture mapping: `fixture-ledger.md`. Exact changed search-accounting assertion before/after with line numbers: `assertion-ledger.json`.
- No semantic outcome assertions loosened. Added real in-progress Encounters; fake search now honors patient/encounter parameters. Root corrected the two source regressions rather than changing their expected outcomes.
- Original protocol-work search limits 24/52, definition counts 4/5 and rule limits 6/10 preserved. Added exact guard-query triplets: 3 for tap and 10 for whole. Whole definition prevalidation lookup now precedes seeding, explicitly pinned in the expected prefix.
- Mutation proof: duplicate guard definition lookup fails the exact guard-query assertion; duplicate protocol definition lookup fails the retained definition count. Both unique-anchor mutants failed, then restored 2/2 green. Source restored byte-for-byte; SHA256 in `mutation-summary.txt`. Mutation harness is private `.odos/r10-a3-1/rev26-protocol-mutations.py`.
- Scoped `git diff --check` exit 0. No commits, production edits retained, UI, policies or auth changes. No independent evaluation verdict.

Type-only build follow-up: helper imports `Reference` and narrows the fixture single-subject reference with an erased cast; `guardSearches` is widened back to `typeof searches` at `includes` after Node assert TypeScript narrowing. No runtime expression or assertion text changed. Logs: `types-focused.txt` and `types-build.txt`.
