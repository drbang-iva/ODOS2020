# Coded-by fixback — revision 2.1 author proof

Status: NOT EVALUATED. Codex — GPT-6 Astra (high) authored this guard-only revision.
The Claude Opus session that posted NEEDS-WORK owns independent reevaluation.

Evaluated base: `6ca2d69d2292dcb90c9cdd870866fb4f1f570579`, PR #616.
Read NEEDS-WORK comment #5701417350 and the rev 2.1 kickoff section from freshly
fetched PerformanceOD origin/main. N3 is a guard gap; the parser is correct.

## Reproduce first at the exact evaluated base

A fresh detached worktree was created at `6ca2d69d` before adding G19.

- Exact six-line N3 body + Codex (GPT-6) PASS: `same-tool-evaluator`.
- Replace `} else if (fenceMatch && ` with `}\n      if (fenceMatch && `:
  the complete old gate suite stays 105 pass / 0 fail, while N3 becomes
  `passing-verdict` (fail-open).
- Restore the parser: N3 returns `same-tool-evaluator`; bytes match exactly.

GitHub's render-only `POST /markdown` endpoint, with `mode: gfm`, returned Codex
in a paragraph and Claude inside `pre/code` for that exact six-line body. The
returned HTML is recorded in `proof.json`; G19 cites this behavior in its name.

## Guard and proof

Only G19 is added to the test suite. All existing tests and expectations remain.
The parser file is byte-identical to the evaluated base; its git diff is empty.

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/evaluationVerdict.test.ts mcp/tests/fixturePhiGuard.test.ts
git diff --exit-code 6ca2d69d -- .github/scripts/evaluation-verdict.cjs
git diff --check
```

Results: 107 pass / 0 fail / 0 skip (106 gate + 1 fixture privacy). Parser diff
and whitespace checks are clean. No local test stacks were started.

With G19 present, the N3 break produces 105 pass / 1 fail, specifically G19.
Restoring produces 106 pass / 0 fail. All seven rev 1 and all three rev 2 breaks
were rerun in the disposable worktree, each red then 106/106 green after a
byte-identical parser restore. The supplemental rev 2 closing-line-declaration
guard break was rerun too. Exact failing tests and counts are in `proof.json`.

The equivalent mutants identified by the evaluator (last closing delimiter and
last-opener-after-last-closer handling) require no guard under the kickoff.

## Handoff boundaries

Changes: G19 and these two proof files only. No parser, workflow, token-table,
posting-script, dependency or fixture changes. No new decision, medical code or
FHIR artifact: decisions index and Mandate 14 ledger additions are N/A.

Prior rev 2 proof is preserved in this directory at `6ca2d69d`; rev 1 proof is at
`7d5ea2af`. Final-head CI counts (including live authorization) and settled bot
status are recorded in the PR after completion. The author posts no evaluation
marker, applies no override and does not merge.
