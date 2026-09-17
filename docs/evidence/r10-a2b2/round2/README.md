# Round 2 author fixback: F11–F13

**NOT EVALUATED · HELD OPEN · DO NOT MERGE.** Codex — GPT-6, high effort. Independent Claude Opus must re-evaluate the final head. Starting head: b537668949886f8e7335e8dca4754bc658649ee0. No new design decision or medical terminology binding was introduced; no decisions/INDEX or Mandate 14 ledger change is required.

The unassigned tray now merges candidate views per diagnosis, restricts supports to the grouped rows, deduplicates by rowKey, and retains the first contributing findingInstanceId. Canonical supports make the merged suggestion usable despite legacy linkable flags. Workspace scope choices and the submit boundary enforce the supporting eye union. Both-eye support sends OU with both independent key/baseline pairs. Permission and read-only restrictions remain in place.

## Scope and assertions

Production: DiagnosisFindingsTable.tsx and DiagnosisWorkspace.tsx only. Tests: r10DiagnosisTable.test.tsx and r10DiagnosisWorkspace.test.tsx. Remaining changes are evidence in docs/evidence/r10-a2b2/ and the PR body. No MCP, DiagnosisPicker, AssessmentSection or section-caller changes. Four tests added; no existing assertions changed or weakened. See ../existing-assertions.md for V13/W88 and W89 mapping. The new workspace helper mode leaves earlier modes unchanged.

## Mutation proof

`python3 docs/evidence/r10-a2b2/round2/run-guards.py` restores every mutation in a finally block. W88 reintroduces the previous per-candidate rendering. W89 enables mismatched scopes and removes submit refusal.

| Guard | Red pass/fail | Restored pass/fail |
|---|---|---|
| W88 | 1 / 1 | 2 / 0 |
| W89 | 0 / 2 | 2 / 0 |
| W55 | 2 / 2 | 4 / 0 |
| W56–W61, each | 0 / 1 | 1 / 0 |
| W62 | 0 / 2 | 2 / 0 |
| W63–W64, each | 0 / 1 | 1 / 0 |

The unchanged prior runner `fixback/run-guards.py` was executed again. Fresh TAP is retained here with prior-guard-counts.json; historical round-1 evidence is preserved. W55–W64 total 14 restored passes. W88's unchanged single-eye case stays green under the per-candidate mutation; the OU case is the failing guard. W89 also invokes disabled handlers directly, proving no mismatched request can escape merely by bypassing the DOM disabled state.

## Checks

Exact affected counts: affected-counts.json. Full UI summary: full-ui-counts.txt. UI build: exit 0, existing bundle-size warning. Preflight: exit 0, 0 warnings / 0 hard blocks. git diff --check: exit 0. A3 release checker: exit 1 expected, `R10 A3 release BLOCKED`; exact remaining T1–T22 findings in a3-release.txt. MCP and live suites were not rerun because no mcp/ file changed in this fixback.

## Visual evidence and limits

suggestion-before.png and suggestion-after.png show the real workspace rendered with synthetic per-eye candidate responses: 2 buttons → 1; all eye choices enabled → only OU enabled. visual.json records the browser assertions. prepare.mjs archives b5376689 for before and copies the changed source for after, in isolated temporary directories; capture.mjs uses separate verified loopback ports 15471/15472. No shared app server or database was used. Both screenshots were inspected. These are component/transport checks, not a live clinical route or persistence/AccessPolicy proof.

No Docker containers were started; the two temporary Vite servers were stopped after capture. Final Docker stop result, main refresh, exact head, PR-body Coded-by verification, and final bot states are reported in the PR body/handoff, so a status-only commit cannot stale the reviews. The two adjudicated MCP/A3 review threads stay open; CodeQL pre-existing alerts stay untouched. No author evaluation marker is posted.
