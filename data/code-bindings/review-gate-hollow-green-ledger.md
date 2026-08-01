# Review-gate hollow-green verification ledger

Scope: CodeRabbit configuration and manual review-command behavior consumed by
`.coderabbit.yaml`, `scripts/eval-worktree.sh`, `scripts/eval-post-verdict.sh`,
`CONTRIBUTING.md`, and `AGENTS.md`.

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| `reviews.auto_review.enabled` | Defaults to `true`; `false` disables automatic reviews but does not disable manual PR-comment review commands. | https://docs.coderabbit.ai/configuration/auto-review | https://docs.coderabbit.ai/reference/review-commands | 2026-08-01 | VERIFIED — sources agree |
| `reviews.auto_review.auto_incremental_review` | Defaults to `true`; `false` suppresses later-push reviews until a manual review is requested. | https://docs.coderabbit.ai/configuration/auto-review | https://docs.coderabbit.ai/reference/configuration | 2026-08-01 | VERIFIED — sources agree |
| `reviews.auto_review.drafts` | Defaults to `false`, so automatic review skips draft PRs; a full review can be requested after a PR moves from draft to open. | https://docs.coderabbit.ai/configuration/auto-review | https://docs.coderabbit.ai/reference/review-commands | 2026-08-01 | VERIFIED — sources agree |
| `reviews.auto_review.description_keyword` | Defaults to an empty string; with automatic review disabled, a non-empty configured keyword opts matching descriptions into review, while an empty value leaves label/manual opt-in. | https://docs.coderabbit.ai/configuration/auto-review | https://docs.coderabbit.ai/reference/configuration | 2026-08-01 | VERIFIED — sources agree |
| `@coderabbitai review` | Requests an incremental review of changes since the last review and uses one review allowance when it runs. | https://docs.coderabbit.ai/guides/commands | https://docs.coderabbit.ai/reference/review-commands | 2026-08-01 | VERIFIED — sources agree |
| `@coderabbitai full review` | Requests a complete review of all PR files from scratch, disregards earlier comments for review scope, and uses one review allowance when it runs. | https://docs.coderabbit.ai/guides/commands | https://docs.coderabbit.ai/reference/review-commands | 2026-08-01 | VERIFIED — sources agree |
