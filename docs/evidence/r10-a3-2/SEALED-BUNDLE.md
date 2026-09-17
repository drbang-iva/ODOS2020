# R10 A3.2 evidence bundle — IN PROGRESS

NOT EVALUATED. HELD OPEN. Never merge.

Coded-by: Codex — GPT-6, high effort

Independent evaluator: a separate Claude Opus session. This is author evidence only.

## Summary and scope

The Ocular Health screen and diagnosis door use the same canonical findings. Saves retain loaded baselines, frozen retries and target-specific outcomes; panel Remarks and measurements remain separate. Unchanged signed/inactive facts are fresh-baseline witnesses, checked and locked in the editor. Carry, Assessment origin and void/undo action identity now consume the A3.1 contracts.

Base: `a211b36887b49139ab29cf2d811a5a30f261034d`; branch `drbang-iva/r10-a3-2`. Implementation `3eaba076951d86562fe1287044f3485b0f480703`; closed label follow-up `f9e4bc0f`.

[Files touched](files-touched.json). Allowed scope is kickoff §9 + §13, including the loaded-claim loop exception and extraction-only DiagnosisWorkspace. EncounterCharting changes only pass voidActionId through three callbacks. No other MCP production file changed. No new clinical codes, terminology bindings, regulatory claims or decisions were introduced; Mandate 14 ledger and companion decisions index need no new row. Independent evaluation and any release/deployment remain later work.

## Guard and assertion evidence

- [Every changed assertion: exact before/after and row](all-assertion-ledger.json), with [reproducer](audit-assertions.mjs).
- [Custom section migrations](custom-sections/assertion-ledger.md), [root fixture migrations](root-assertion-ledger.json), [carry](carry/assertion-ledger.md), [carry integration](carry-integration/assertion-ledger.md), [void/undo](void-undo/assertion-ledger.md).
- [W130–W138, W145 and W147 UI mutations](editor/EDITOR-EVIDENCE.md).
- [W139/W140, shared extraction and unchanged workspace counts](picker/PICKER-EVIDENCE.md). Workspace tests are unchanged; 22/22 focused. Disabling scope in the shared helper makes workspace 20 pass/2 fail and picker 1 pass/2 fail; restored combined 25/25 at mutation time.
- [W142/W143/W145 carry mutations](carry/assertion-ledger.md), final carry integration 25/25.
- [W144 exact action identity and superseded mutations](void-undo/assertion-ledger.md).
- [W146 actual generated Caddyfile mutation](harness/setup-summary.md): red exit1 names changed line; restored exit0. Harness tests 2/2.
- [W147 server mutation summary](w147-summary.json): restored editability check gives 2 pass/3 fail; dropped witness claimMatches gives 4 pass/1 fail; each restores 5/5. Scoped A3.1 ocular/door/release suites 92/92.
- Closed diagnosis label follow-up W134: 0 pass/1 fail before, 1/1 after (`closed-label-red.log`, `closed-label-green.log`); existing workspace assertions unchanged.

W147 test names:
1. W147 unchanged signed loaded witness permits Remarks without changing the fact
2. W147 signed deselect remains refused with zero writes
3. W147 signed regrade remains refused with zero writes
4. W147 unchanged signed witness with a moved fresh version refuses stale baseline
5. W147 inactive option is an unchanged witness while active panel Remarks save

The eight carried failures are covered by customSections (2), examOverviewBoard (3), ocularSweepValueOnly (1), encounterVoid (2); final full-UI evidence determines zero failures. UI release slots T4–T6, T15–T18, T21 and T22 are implemented without todo markers. Exact output and counts are indexed in [checks](final-checks.json) and [raw-log inventory](checks-index.json).

## Served-route and screen proof

IN PROGRESS. Step (a) passes at exact #619 `1706d7c8417b04791471d4332b4ecd712883bf11`; [result](served-route/before-result.json) contains canonical resource ids/versions, served bundle hash and both before screenshots. Remaining (b)–(h) must pass before sealing.

Harness: own `odos-r10-a3-2-served` project, Medplum5.1.30, subnet10.249.147.0/24, UI28090, Medplum28103, PostgreSQL25433, Redis26380, MCP23334, proxy23335/control23336. [Setup and W146 proof](harness/setup-summary.md). Runtime service and caller roles are separate; provider/staff stored policies were not relaxed.

## Full checks and release checker

[Recorded counts, commands and exits](final-checks.json). MCP CI-equivalent raw command across423 files: 6005 total, 5952 pass, 0 fail, 53 skipped, exit0. Python recursive glob expansion matches the workflow globs because macOS Bash lacks globstar. PostgreSQL and WeasyPrint69.0 were configured; no inherited project/operator environment entered this non-live run. Separate credentialed live-authz:73/73, no skips, exit0.

The earlier `npm --prefix mcp test` TAP also had 5952 pass/0 fail/53 skip, but wrapper exit1 correctly refused ungated live skips. This is retained explicitly, not reported as a successful wrapper command. An earlier narrower-shell run and an interrupted PostgreSQL run are invalid attempts, not coverage evidence.

Strict checker output:

```
R10 A3 release PASS: T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20, T21, T22
```

Full UI:1728/1728, zero failure/skip/todo, exit0. The unchanged W134 test was then moved from the T-slot-only release file into the editor file; editor17/17 and strict T1–T22 passed after the move. UI build passed333 modules; MCP build and scripts typecheck passed. Preflight:0 warnings/0 hard blocks, exit0.

## PR, CI and review

PENDING: PR number/final head, CI run URL and per-job counts, CodeRabbit terminal status plus delayed repoll, PR-Agent and every finding/thread disposition. No independent evaluation marker has been posted.

## Risks and follow-ups

- Existing lifecycle amendment live test accepts a Provenance404 while Observation amendment persists. The73 passing live tests do not prove that provenance persistence; [details](live-authz/README.md).
- Default synthetic Medplum user quota50000 weighted units/minute was exhausted during browser proof. Harness-only quotas were raised and read back; this proof does not establish performance under default quotas. Caller policies remain unchanged.
- Existing UI bundle size warning remains; no unrelated performance refactor included.
- Author tests and bot review do not replace independent exact-head Claude Opus evaluation.

## Container shutdown and status

IN PROGRESS: containers retained for browser proof. Final delivery must stop, not remove, all three running `odos-r10-a3-2-served-*` containers and list names. No merge or deployment.
