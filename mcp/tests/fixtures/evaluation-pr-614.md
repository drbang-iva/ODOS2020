Coded-by: Codex — GPT-6 Astra (high)

**NOT EVALUATED** — author implementation and checks only. Independent evaluation belongs to Claude Opus 5 (extra), in a separate session. No evaluation marker posted; do not merge from this handoff.

## What this changes

A Codex-authored PR could previously pass the evaluation gate on a Codex signature. The gate now rejects a trusted, current-head PASS when its evaluator tool appears in the PR body's `Coded-by:` declarations. Claude-authored work likewise requires a Codex evaluator. Missing/unknown coders and ambiguous evaluator tools fail closed; existing failure reasons keep their ordering. Bot-authored PRs and operator OVERRIDEs retain their exemptions.

The posting script invokes the same `.cjs` gate via Node and refuses rejected PASS markers with the same message. PR body edits re-run the workflow, which still checks out only the default branch and obtains coder metadata from its existing `pulls.get()` response. The PR template and both AGENTS author/evaluator sections document the enforced tool boundary.

<!-- before-and-after:start -->
## Measured before and after

Direct invocations of the original and proposed parsers with identical synthetic inputs:

| Input | Before | After |
|---|---|---|
| Codex coder / Codex PASS | Accepted | `same-tool-evaluator` |
| Codex coder / Opus PASS | Accepted | Accepted |
| Human without coder / Opus PASS | Accepted | `missing-coded-by` |
| Bot without coder / Codex PASS | Accepted | Accepted |

This change has no application UI surface. The before/after evidence is executable parser behavior.
<!-- before-and-after:end -->

## Files touched

- `.github/scripts/evaluation-verdict.cjs`: coder parsing, fenced-block skipping, evaluator tool classification, ordered rejection.
- `.github/workflows/evaluation-gate.yml`: `edited` trigger and fetched PR metadata.
- `scripts/eval-post-verdict.sh`: shared gate precheck before posting.
- `mcp/tests/evaluationVerdict.test.ts`: S1–S17, alias and ordering companions, real embedded-workflow and script agreement checks.
- `.github/pull_request_template.md`, `CONTRIBUTING.md`, `AGENTS.md`: canon repair and coder declaration.
- [`docs/build-log/eval-tool-boundary/verification.md`](https://github.com/drbang-iva/ODOS2020/blob/70e2ef97f557b31320e022b7402b9ea02e03b098/docs/build-log/eval-tool-boundary/verification.md): exact commands, outputs, and all mutation evidence.

## Verification

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/evaluationVerdict.test.ts
```

- Original baseline: **58 tests, 58 pass, 0 fail, 0 skipped**.
- Expanded guards against the original implementation: **82 tests, 66 pass, 16 fail, 0 skipped** (RED).
- Implemented and restored: **82 tests, 82 pass, 0 fail, 0 skipped** (GREEN).
- `npm --prefix mcp run build`: exit 0 (`tsc`).
- Dedicated strict typecheck of the changed test file: exit 0; full command in the verification record.
- `node --check .github/scripts/evaluation-verdict.cjs`, `bash -n scripts/eval-post-verdict.sh`, and the full CI ShellCheck command: exit 0.
- `git diff --check`: exit 0.

All seven Mandate 17 breaks ran separately in a disposable worktree. Each mutation was verified present; every restoration matched its original bytes. Every run used the entire 82-test suite, with zero skips.

| Break | RED pass / fail | Restored pass / fail |
|---|---:|---:|
| Remove same-tool comparison | 74 / 8 | 82 / 0 |
| Stop skipping fenced lines | 80 / 2 | 82 / 0 |
| Remove Bot exemption | 79 / 3 | 82 / 0 |
| Ambiguous signature uses first token | 79 / 3 | 82 / 0 |
| Move guard before verdict/stale checks | 78 / 4 | 82 / 0 |
| Remove Sol token | 81 / 1 | 82 / 0 |
| Remove edited event | 81 / 1 | 82 / 0 |

The kickoff's S3 signature contains redundant Codex/GPT/Sol tokens, so deleting only Sol cannot change that case's outcome. S3 retains the required replay and adds a direct token-only classification companion that does turn red. S16 retains the requested stale cross-tool case and adds a stale same-tool companion to expose incorrect ordering. The trusted-model allowlist is unchanged; standalone Sol remains untrusted.

The actual embedded workflow runs locally with the real parser and synthetic GitHub responses. This checks body/type wiring; the trigger/checkout guards are static assertions, not live GitHub event-delivery proof.

## Bot review

Final head: `70e2ef97f557b31320e022b7402b9ea02e03b098`. Re-polled at **2026-09-16 15:01:22 UTC**, more than 3 minutes after the completed-bot snapshot.

- **CodeRabbit commit status: success**, "Review completed"; summary reports no actionable comments.
- **[PR-Agent check-run](https://github.com/drbang-iva/ODOS2020/actions/runs/35111560971/job/104846296425): completed / success**; reviewer guide reports no major issues.
- **Unresolved review threads: 0** (all review threads fetched; no pagination remaining).
- The generic docstring-coverage warning was [answered](https://github.com/drbang-iva/ODOS2020/pull/614#issuecomment-0123456789) against the operator's no-boilerplate-comment rule. No code fixback was needed.
- `check-evaluation` is intentionally red with `no-marker`: **NOT EVALUATED**. No evaluation marker was posted.
- **[Full CI](https://github.com/drbang-iva/ODOS2020/actions/runs/35111560804): success** at this head. MCP general suite: 5,521 tests, 5,470 pass, 0 fail, 51 skipped. Separate credentialed live integration: 12/12 bootstrap plus 218/218 tests; live authorization: 65/65. UI: 1,629/1,629, zero failures or skips; build passed. CodeQL, preflight, and ShellCheck also passed. The general-suite skips are reported separately; they are not counted as passes.

## Trust limit and follow-ups

One shared GitHub login supplies the PR body and evaluation marker. **This catches honest mistakes, not forgery**: someone could deliberately edit `Coded-by:`. This is not authentication. Branch protection, the trusted-model allowlist, and the operator OVERRIDE path are unchanged.

No medical codes, FHIR artifacts, or regulatory claims changed; no Mandate 14 ledger rows were needed. No new design decision was made, so `decisions/INDEX.md` is unchanged. PerformanceOD canon repair remains with the Claude session named in the accepted kickoff. Base is `6f44c050fec9a6269f502a9099fa1bfd77c3d7c5`.

The throwaway-PR live proof is explicitly deferred until after merge and operator initiation. No test stacks were started. No evaluation marker will be posted and no merge will be performed in this task.


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

- **New Features**
  - Added coding-tool declarations for human-authored pull requests.
  - Evaluation passes now reject results produced by the same declared coding tool.
  - Pull request edits trigger the evaluation gate again.
  - Bot-authored pull requests and authorized overrides remain exempt.

- **Documentation**
  - Updated contribution and evaluation guidance with declaration requirements, supported tool pairings, and validation rules.
  - Added verification records covering guarded, restored, and edge-case evaluation behavior.

- **Tests**
  - Expanded coverage for declarations, malformed entries, overrides, stale changes, author types, and workflow consistency.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->
