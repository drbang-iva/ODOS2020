# Coded-by fixback — revision 2 author proof

Status: NOT EVALUATED. Codex — GPT-6 Astra (high) authored this revision.
The independent Claude Opus session owns reevaluation. No author marker or merge.

Evaluated base: `7d5ea2afb97fff9a385d1ca41b23bdf2b6f52ee4`, PR #616.
The NEEDS-WORK comment is #5701008780. The rev 2 kickoff was read from freshly
fetched PerformanceOD origin/main. N1 is a surviving mutation/guard gap; N2 is
an amendment to the evaluator's F2 contract.

## Reproduce first

At the evaluated base, in the task's disposable mutation worktree:

- N1 without the break: `same-tool-evaluator`.
- Insert `visibleLine += line.slice(cursor); break;` after `cursor = commentEnd + 3;`:
  the old gate suite remains 102 pass / 0 fail, but N1 becomes `passing-verdict`.
- N2 on unchanged code: `passing-verdict`.
- Restore: N1 again returns `same-tool-evaluator`; parser bytes match exactly.

Before changing implementation, adding G16/G17/G18 produced 104 pass / 1 fail
(G17). All 102 tests from the evaluated head remain; no existing expected
outcome was changed for rev 2.

## Change and checks

An active HTML comment closes at the first closing delimiter. Its remaining line
uses the existing inline span handling, so a final unclosed opener restores
comment state. That remainder cannot declare, even with no space before Coded-by.
The active-fence ordering and inline handling are otherwise retained.

From the repository root with locked MCP dependencies installed:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/evaluationVerdict.test.ts mcp/tests/fixturePhiGuard.test.ts
npm --prefix mcp run build
node --check .github/scripts/evaluation-verdict.cjs
git diff --check
```

Results: 106 pass / 0 fail / 0 skip (105 gate + 1 fixture privacy). MCP TypeScript
build, syntax and whitespace checks exit 0. Marker parsing, the token table,
trusted-model allowlist, workflow and posting script are byte-identical to the
evaluated base. No local test stacks were started.

## Mutation proof

`proof.json` records every failing test name and exact counts. All ten requested
breaks ran in a separate disposable worktree, with 105/105 green after each
restore and byte-identical parser restoration. The three added breaks each fail
exactly their new guard: first span only → G16; ignore closing remainder → G17;
any opener on the closing line reopens → G18.

The seven rev 1 breaks were also rerun. Removing HTML handling removes both
active-comment handling and inline handling while retaining fence detection.
The inline-strip break retains completed comment contents without treating a
completed opener as unclosed. The comments-before-fences break moves inline
comment handling before fence processing. The other breaks restore first-word
coder detection, require standalone closes, remove Sonnet, or trust Sonnet.

A supplemental break deletes the closing-line declaration guard; the strengthened
no-space suffix case turns red. Its restoration also passes 105/105.

Historical rev 1 proof (including initial 82/82 and red-on-main results, the G4/G8
companions, CodeQL response and normalized fixture link provenance) is preserved
in this directory at commit `7d5ea2af`. The two fixtures are unchanged in rev 2.

## Handoff boundaries

This revision changes only the parser, its tests, and these two proof files.
No new decision, medical code or FHIR artifact: decisions index and Mandate 14
ledger updates are N/A. The PerformanceOD contract amendment belongs to Claude.
CI counts and settled final-head bot status are recorded in the PR after those
runs finish; the author proof is not an independent evaluation.
