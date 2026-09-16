# Coded-by fixback author proof

Status: NOT EVALUATED. Codex — GPT-6 Astra (high) authored this change.

Base: `4b3f6d7c25fb40268e216dcd22ad03a866d03643`.
The authoritative PerformanceOD kickoff was read from freshly fetched origin/main.

## Reproduce

With locked MCP dependencies installed, from the repository root:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/evaluationVerdict.test.ts
npm --prefix mcp run build
```

Baseline: 82 passing / 0 failing. The six first-written guards on unchanged main:
83 passing / 5 failing (G1, G2, G5, G6, G7); G9 already passed.
Final: 101 passing / 0 failing / 0 skipped. MCP TypeScript compilation exits 0.
`node --check .github/scripts/evaluation-verdict.cjs` and `git diff --check` exit 0.

All original 82 tests remain, with one required contract correction: the former
first-word-only test explicitly accepted `Codex — helper Opus 5` with an Opus PASS.
That exact input now asserts rejection; its other fence and declaration cases remain.

## Break and restore

All mutations ran in a separate disposable worktree; `proof.json` records exact
failing test names and counts. Every restore passed 101/101 and matched the source
parser bytes. The seven mutations were:

1. Replace the coder-value token union with `coders.add(coder[1].toLowerCase())`.
2. Remove the complete HTML-comment handling block.
3. Omit inline span stripping while recognizing only unclosed openers as opening
   multi-line comments. This leaves inline contents in the scanned declaration.
   In the initial regex version, simply deleting the replace line also misclassified
   closed comments as unclosed;
   that alternate mutation fails G8 and template tests but masks G9 by truncation.
4. Close active comments only when `line.trim() === "-->"`.
5. Move comment handling before the existing fence handling.
6. Remove Sonnet from the shared token table.
7. Add Sonnet to the trusted-model allowlist.

G4 as literally specified already begins with Claude, so removal of Sonnet cannot
change its outcome. Its companion uses `Codex — Sonnet 5` and asserts rejection.
G8's same-line span does not exercise closing an active multi-line comment; its
companion closes one with `note -->`. Both literal kickoff cases are retained.
G14 extends the existing S17 script dry-run agreement test with G1/G6/G3.

Fixtures preserve the merged PR template and the PR #614 body fetched via
GitHub CLI. One incidental ten-digit GitHub issue-comment link ID in the PR body
is normalized to the existing synthetic value `0123456789` to satisfy the fixture
privacy guard; declaration and HTML-comment bytes are unchanged. CodeRabbit's summary in that body has same-line HTML boundary comments;
it is not one continuous multi-line HTML comment. G6/G11 cover the latter explicitly.

The trusted-model allowlist, marker parsing, posting script and workflow are unchanged.
No new medical terminology or FHIR artifacts: Mandate 14 ledger additions are N/A.
No new design decision: decisions/INDEX.md changes are N/A. The original kickoff
amendment in PerformanceOD remains owned by the Claude session.
No test stacks were started. Live parser/workflow proof is not required by the kickoff.
CI and final-head bot results are reported in the PR and sealed handoff, after settling.

## Static analysis follow-up

CodeQL flagged the initial inline-comment regex as HTML sanitization and multiline
filtering. This code scans declarations, not HTML output, and receives one line at
a time. The final implementation uses explicit delimiter scanning, preserving the
same strip-then-check-unclosed semantics without an HTML-filter regex. The focused
suite and all seven mutation/restore pairs were rerun on this implementation with
the same counts above. A boundary case also covers a comment opener reconstructed
by removing a completed span; the subsequent unclosed-comment step still hides it.

The final fixture privacy check passes: the initial full CI run exposed the real
GitHub comment ID as a non-synthetic ten-digit value (5,488 pass / 1 fail / 51 skip).
Only that incidental link ID was normalized; no privacy guard or allowlist changed.
