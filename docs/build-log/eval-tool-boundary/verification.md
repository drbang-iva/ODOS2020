# Evaluation gate same-tool guard: author verification

Status: NOT EVALUATED. These are author checks, not an independent verdict.

Base: `6f44c050fec9a6269f502a9099fa1bfd77c3d7c5`.
The accepted kickoff was read with `git show origin/main:decisions/2026-09-16-odos-eval-gate-reject-same-tool-signature-codex-kickoff.md`
from performance-od origin/main at `cb4558d558274d78be94d4bae2ed9bf5ee10bf20`; its working tree was not used.

## Commands and counts

From the ODOS task worktree:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/evaluationVerdict.test.ts
```

| Run | Tests | Passed | Failed | Skipped | Exit |
|---|---:|---:|---:|---:|---:|
| Original baseline | 58 | 58 | 0 | 0 | 0 |
| New guards against original implementation | 82 | 66 | 16 | 0 | 1 |
| Implemented and restored | 82 | 82 | 0 | 0 | 0 |

Additional checks, all exit 0:

```sh
npm --prefix mcp run build
node --check .github/scripts/evaluation-verdict.cjs
bash -n scripts/eval-post-verdict.sh
shellcheck scripts/eval-worktree.sh scripts/eval-post-verdict.sh scripts/lib/bot-review-status.sh
./mcp/node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --esModuleInterop --skipLibCheck --types node --typeRoots mcp/node_modules/@types mcp/tests/evaluationVerdict.test.ts
git diff --check
```

The dedicated test-file typecheck initially found missing optional fields in the test-case union.
An explicit `CoderCase` type fixed those six diagnostics; the command above then exited 0.
ShellCheck's JavaScript-template false positive was removed with ordinary string concatenation;
the full CI ShellCheck invocation above then exited 0.

## Mandate 17: deliberate breaks and restores

Each mutation ran alone in a disposable worktree using the complete 82-test command above.
Every changed byte was asserted present before the RED run. Each source file was then restored
byte-for-byte, and the entire suite reran GREEN. The final implementation diff matched its
pre-mutation bytes. Removing that patch left `git status --porcelain` empty before worktree removal.
All RED runs exited 1; all restored runs exited 0; every run had zero skips.

| Break | RED passed / failed | Restored passed / failed |
|---|---:|---:|
| same-tool-comparison | 74 / 8 | 82 / 0 |
| fenced-lines | 80 / 2 | 82 / 0 |
| bot-exemption | 79 / 3 | 82 / 0 |
| ambiguous-first-token | 79 / 3 | 82 / 0 |
| ordering | 78 / 4 | 82 / 0 |
| sol-token | 81 / 1 | 82 / 0 |
| edited-event | 81 / 1 | 82 / 0 |

Two kickoff rows needed companion fixtures, without changing the production contract:

- S3's `Codex (gpt-5.6-sol)` still identifies Codex through `Codex` and `GPT` if `Sol` is deleted.
  The required S3 replay remains, while the S3 token-only companion directly tests all seven
  whole-word aliases and ambiguous/unknown classifications. Removing `Sol` turns that companion red.
  `Sol` alone remains untrusted by the unchanged model allowlist.
- S16's stale Opus marker with a Codex coder has no tool conflict, so moving the new check early
  still returns stale. The required S16 case remains; a stale same-tool S16 companion makes the
  ordering mutation red alongside S15.

Exact mutations and failing test names:

### same-tool-comparison

Replace:

```text
if (coders.has(tool)) {
```

With:

```text
if (false && coders.has(tool)) {
```

RED output:

```text
not ok 17 - S17 the posting script and real gate agree on signatures and coder checks in a dry run
not ok 59 - S1 Codex (GPT-6) returns same-tool-evaluator
not ok 60 - S2 Astra returns same-tool-evaluator
not ok 61 - S3 Codex (gpt-5.6-sol) returns same-tool-evaluator
not ok 63 - S5 Opus 5 returns same-tool-evaluator
not ok 65 - S7 Codex returns same-tool-evaluator
not ok 66 - S7 Opus 5 returns same-tool-evaluator
not ok 81 - the workflow uses the fetched PR body and author type with the real parser
# tests 82
# pass 74
# fail 8
# skipped 0
```

Restored output:

```text
# tests 82
# pass 82
# fail 0
# skipped 0
```

### fenced-lines

Replace:

```text
if (fence) {
```

With:

```text
if (false && fence) {
```

RED output:

```text
not ok 68 - S9 Opus 5 returns missing-coded-by
not ok 78 - coder declarations ignore fenced examples and use only each declaration's first word
# tests 82
# pass 80
# fail 2
# skipped 0
```

Restored output:

```text
# tests 82
# pass 82
# fail 0
# skipped 0
```

### bot-exemption

Replace:

```text
if (prAuthorType === "Bot") {
```

With:

```text
if (false && prAuthorType === "Bot") {
```

RED output:

```text
not ok 17 - S17 the posting script and real gate agree on signatures and coder checks in a dry run
not ok 71 - S12 Codex returns passing-verdict
not ok 81 - the workflow uses the fetched PR body and author type with the real parser
# tests 82
# pass 79
# fail 3
# skipped 0
```

Restored output:

```text
# tests 82
# pass 82
# fail 0
# skipped 0
```

### ambiguous-first-token

Replace:

```text
  if (codex === claude) return undefined;
  return codex ? "codex" : "claude";
```

With:

```text
  const first = /\b(Codex|GPT|Astra|Sol|Claude|Opus|Fable)\b/i.exec(signature)?.[1];
  if (!first) return undefined;
  return /^(Codex|GPT|Astra|Sol)$/i.test(first) ? "codex" : "claude";
```

RED output:

```text
not ok 17 - S17 the posting script and real gate agree on signatures and coder checks in a dry run
not ok 70 - S11 Opus (GPT-6) returns ambiguous-evaluator-tool
not ok 77 - S3 token-only companion classifies every whole-word alias without widening model trust
# tests 82
# pass 79
# fail 3
# skipped 0
```

Restored output:

```text
# tests 82
# pass 82
# fail 0
# skipped 0
```

### ordering

Replace:

```text
    const independenceFailure = evaluateToolIndependence({ evaluator, prBody, prAuthorType });
    if (independenceFailure) return independenceFailure;

```

With:

```text

```

Replace:

```text
  const shaLines = headShaLines(latestComment.body);
```

With:

```text
  if (!isOverride) {
    const independenceFailure = evaluateToolIndependence({ evaluator, prBody, prAuthorType });
    if (independenceFailure) return independenceFailure;
  }

  const shaLines = headShaLines(latestComment.body);
```

RED output:

```text
not ok 17 - S17 the posting script and real gate agree on signatures and coder checks in a dry run
not ok 74 - S15 Codex returns failing-verdict
not ok 76 - S16 stale same-tool companion Codex returns stale-head-sha
not ok 80 - existing failure reasons win even when the coder declaration is missing
# tests 82
# pass 78
# fail 4
# skipped 0
```

Restored output:

```text
# tests 82
# pass 82
# fail 0
# skipped 0
```

### sol-token

Replace:

```text
(?:Codex|GPT|Astra|Sol)
```

With:

```text
(?:Codex|GPT|Astra)
```

RED output:

```text
not ok 77 - S3 token-only companion classifies every whole-word alias without widening model trust
# tests 82
# pass 81
# fail 1
# skipped 0
```

Restored output:

```text
# tests 82
# pass 82
# fail 0
# skipped 0
```

### edited-event

Replace:

```text
[opened, synchronize, reopened, edited, labeled, unlabeled]
```

With:

```text
[opened, synchronize, reopened, labeled, unlabeled]
```

RED output:

```text
not ok 47 - evaluation-gate keeps every trigger and filters current or previous marker bodies
# tests 82
# pass 81
# fail 1
# skipped 0
```

Restored output:

```text
# tests 82
# pass 82
# fail 0
# skipped 0
```

## Direct before/after behavior

The original parser was loaded from `git show 6f44c050:.github/scripts/evaluation-verdict.cjs`.
Both implementations received identical synthetic current-head PASS inputs:

| Input | Before | After |
|---|---|---|
| Codex coder / Codex PASS | `passing-verdict` | `same-tool-evaluator` |
| Codex coder / Opus PASS | `passing-verdict` | `passing-verdict` |
| Human without coder / Opus PASS | `passing-verdict` | `missing-coded-by` |
| Bot without coder / Codex PASS | `passing-verdict` | `passing-verdict` |

## Limits and follow-ups

The PR body and marker use one shared GitHub login. This catches honest mistakes, not forgery:
someone can deliberately edit Coded-by. The trusted-model allowlist and operator OVERRIDE path
are unchanged. No clinical codes, FHIR artifacts, or regulatory claims changed, so no Mandate 14
ledger rows were needed. No new design decision was made; performance-od canon repair remains
with the Claude session named by the accepted kickoff.

The workflow test executes the embedded GitHub-script with the real parser and synthetic GitHub
responses, including body edits and Bot authorship. Its checkout/trigger assertions are static.
This proves local wiring, not delivery of GitHub's live edited event. The requested three-state
throwaway-PR live proof is deferred until after merge and operator initiation.

No test stacks were started. No evaluation marker was posted. This branch must be evaluated by
Claude (Opus 5, extra) in a separate session before merge. CodeRabbit and PR-Agent results are
recorded on the PR after they finish at its final head.
