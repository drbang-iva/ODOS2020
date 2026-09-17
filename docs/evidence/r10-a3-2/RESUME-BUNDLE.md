# R10 A3.2 resumed build — BLOCKED at picker scope

**Status: BLOCKED, partial implementation, NOT EVALUATED.** No PR, commit, push, merge, deployment or independent evaluator marker.

## Summary and scope decision needed

The operator’s W147 ruling is implemented in the permitted server loop. Unchanged signed or inactive loaded facts remain witnesses: fresh claim matching remains mandatory, attempted changes remain refused. Ocular Health editor migration is partially implemented and focused tests/mutations are preserved, but the full UI suite is not green.

Next, §9 and W140 require the picker to use a shared pick → bodySite → finding-link helper. At this base that orchestration is local to `ui/src/components/charting/DiagnosisWorkspace.tsx` (`linkSupports` at 365, `finishLink` at 376, `addDiagnosis` at 391). It is not exported as a shared helper. The file is outside §9/§13’s permitted files, including the W147 exception. AGENTS.md duplication control requires extraction when the mechanic reaches its second caller.

**Pending operator question:** include `DiagnosisWorkspace.tsx` solely to extract that existing sequence into an already-permitted library and make both callers use it? No edits to that file or duplicate implementation were made. This is a scope question grounded in the task’s explicit stop-and-report rule, not an independent evaluation finding. The authorized editor work continued while awaiting the answer.

## Identity and files

Worktree `/Users/ericr.bang/GitHub/ODOS2020/.worktrees/r10-a3-2`; branch `drbang-iva/r10-a3-2`; base/current committed HEAD `a211b36887b49139ab29cf2d811a5a30f261034d`. All changes remain uncommitted.

Production files changed:

- `mcp/src/clinical-graph/custom-section-endpoint.ts`: only the W147 loaded-claim loop.
- `ui/src/components/charting/OcularHealthSection.tsx`: canonical per-eye hydration/save, frozen retries, choice-preserving refresh, panel fields, locks, absent rows, priors notice; incomplete broader screen integration.
- `ui/src/lib/diagnosis-findings.ts`: retain causal negative-act reason in conflict/reload message.

Tests: `mcp/tests/r10A3OcularDoor.test.ts` (five new W147 tests) and `ui/tests/r10A3OcularEditor.test.tsx` (new focused editor tests). Evidence only under this directory. No existing assertion changed or removed; no before/after assertion migration is claimed. New editor assertions are mapped in `editor/EDITOR-EVIDENCE.md`.

No new design decision or Mandate 14 terminology was introduced. No decisions/INDEX.md or terminology ledger change. Cross-repo follow-up is the narrowly scoped permission above.

## W147 proof

Command: `node --import tsx --test --test-name-pattern=W147 mcp/tests/r10A3OcularDoor.test.ts`.

Five test cases: unchanged signed witness with Remarks; signed deselection; signed regrade; stale signed witness version; inactive option witness with Remarks and refused deselection. Final focused run **5 pass / 0 fail**.

Initial four-case run before implementation: **2 pass / 2 fail**. Final mutations use all five cases:

- Restore editability refusal for witnesses: red, then restored green.
- Skip claimMatches for witnesses: red, then restored green.

Exact counts in `w147-summary.json`; raw TAP in matching logs. `w147-mutations.py` checks unique anchors, raises `ANCHOR_MISS` loudly, restores source in finally and verifies restoration bytes.

Combined real-handler suites: `r10A3OcularDoor`, `r10A3DoorGuards`, `r10A3ReleaseScenarios`: **92 tests / 92 pass / 0 fail / 0 skipped / 0 todo**, `w147-scoped.log`. These are in-memory handler checks, not live policy or browser proof. Author-side bounded inspection found no additional W147 issue; this is not independent evaluation.

## Editor mutation proof and limits

Final focused suite: **15/15**. The two additional tests first failed (**13 pass / 2 fail**) and then passed after correcting stale-notice reset and inactive-witness visibility. W130–W138, W145, and signed-row W147 UI mutation each red then restored green; exact per-test counts in `editor/EDITOR-EVIDENCE.md`, results in `editor/mutation-results.json`. W135 includes preserving a colleague’s new finding through refresh while saving pending Remarks; W136 verifies per-eye numeric/select/Remarks rehydration using a controlled history fixture.

W139–W144 and W146: not implemented or mutation-tested. The final two tests are recorded in `editor/refresh-inactive-red.txt` and `editor/refresh-inactive-green.txt`. No claim that the reverse door, complete screen integration, or persisted live round-trip is proven by these focused editor fixtures.

## Broader checks

- MCP build after W147: exit 0 (`w147-build.log`).
- UI build after initial editor migration: exit 0 (`resume-ui-build.log`).
- Preflight: exit 0, **0 warnings / 0 hard blocks** (`resume-preflight.log`). A first run flagged the word naming the permitted-file list in a progress note as vendor marketing; reworded that note, unchanged checker then passed.
- Full UI, before final two bounded editor follow-ups: **1,698 tests / 1,648 pass / 46 fail / 4 todo / 0 skipped**, exit 1, 236,263.785833 ms (`resume-ui-full.log`). Named failures: `resume-ui-failures.txt`. This is worse than the initial 8 carried failures: older snapshot-format fixtures and incomplete picker/void/overview migration remain. Do not treat focused green tests as completion.
- Strict release checker: exit 1 (`resume-release.log`), missing UI T4–T6/T21/T22 and remaining TODO T15–T18. No release clearance.
- Full MCP suite in CI environment/live authorization: not run in this resumed slice.
- `git diff --check`: clean at checks recorded; final check below.

## Outstanding deliverables

The eight carried failures are not fixed. UI T-slots remain open. Picker/Assessment/Previous exams/void-Undo migration is outstanding. No served-route harness (a)–(h), resource/version record, served build identity or before/after screenshots has been produced. No CI run/job counts or URL; no A3.2 PR exists, so no bot terminal review or thread dispositions. No merge/deployment.

**Docker started: 0. Docker stopped: 0.** No test containers need stopping. Files and worktree remain preserved. Resume from this diff after the scope ruling; do not recreate or overwrite the worktree.

## Final partial-work verification

- UI build after the two final editor corrections: exit 0 (`final-partial-ui-build.log`).
- Focused editor command run from `ui/`: `node --import tsx --test tests/r10A3OcularEditor.test.tsx`, **15/15**, exit 0 (`final-partial-editor.log`). An initial root-directory invocation used the wrong JSX configuration and failed 14 cases; preserved as `editor-wrong-cwd.log`, then rerun from the package working directory without code changes.
- Final preflight: exit 0, 0 warnings / 0 hard blocks (`final-partial-preflight.log`).
- Final `git diff --check`: exit 0.
- Full UI suite was not repeated after those two bounded corrections; the 46-failure full run above is a preceding snapshot, not a passing final-head result.
- Scope reply has not arrived. No dependent extraction was performed.
