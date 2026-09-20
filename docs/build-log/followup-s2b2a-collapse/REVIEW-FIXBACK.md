# Bot-review fixback

The first CodeRabbit review at `b0717a66068cb024819dcbf05a2f168528c5c741` raised four findings. This is author follow-up, not an independent evaluation.

| Finding | Disposition and evidence |
| --- | --- |
| Writer proof CLI can return success after a failed proof | Fixed: failures set exit code 1 and go to stderr; remaining editors are still checked. Injecting an invalid negative IOP produced one failed editor and ten successful proofs. Before the fix, exit 0; after the fix, exit 1. Restoring the valid value gives exit 0 and eleven successful proofs. The original eleven successful result rows were genuine; the defective aggregate failure signal is now corrected. |
| Cleanup begins after some proof processes have started | Fixed: stack child/proxy startup is inside the cleanup catch boundary; Caddy and Chromium launch are inside the browser lifecycle. Injected Chromium startup failure exits 1 with no before-Caddy listener. Injected proxy startup failure exits 1, terminates the actual spawned MCP child, and stops all task containers. The restored harness is used for the subsequent real browser proof. |
| Collapsed button's accessible name suppresses its displayed data | Fixed: the accessible name now includes editor name, collapsed state, evidence state and the same summary text. New assertion in the existing G3 test: before fix, 6 pass/1 fail; after fix, 7 pass/0 fail. The visible text and layout are unchanged. |
| Locale-sensitive identifier normalization | Confirmed pre-existing in `editorGroupKey` at da799f4e and moved verbatim. Kept unchanged because kickoff §3.1 requires identical existing mapping behavior. Logged as a separate locale-behavior follow-up and replied/resolved with that rationale. |

Commands for the executable checks:

```text
node --import tsx docs/build-log/followup-s2b2a-collapse/writer-probe.mjs
  invalid IOP before fix: exit 0, iop failed, 10 successful editors
  invalid IOP after fix:  exit 1, iop failed, 10 successful editors
  restored valid input:  exit 0, 11 successful editors

node --import tsx --test ui/tests/examViewState.test.tsx
  accessibility assertion before fix: tests 7, pass 6, fail 1, skipped 0
  restored/fixed:                    tests 7, pass 7, fail 0, skipped 0

node docs/build-log/followup-s2b2a-collapse/proof/browser.mjs "$BEFORE_ROOT"
  injected Chromium startup failure: exit 1; before-Caddy listeners 0

node docs/build-log/followup-s2b2a-collapse/proof/stack.mjs serve
  injected proxy startup failure: exit 1; spawned MCP child terminated;
  task containers running 0
```

Failure injections were made temporarily in the task's proof scripts and restored byte-for-byte. They are not permanent flags or production failure paths. Structured summaries are in [review-fixback-results.json](review-fixback-results.json).

G1–G11 were re-mutated against the updated sources; [GUARDS.md](GUARDS.md) and [mutation-results.json](mutation-results.json) contain the final results. The full suite and real-stack evidence in [SEALED-BUNDLE.md](SEALED-BUNDLE.md) are refreshed for the final implementation.

The bot's blanket docstring warning conflicts with the repository's explicit default of no comments unless the reason is non-obvious; no boilerplate was added. The PR description includes the requested template context. The request for an independent PASS marker is intentionally unfulfilled by the author: **NOT EVALUATED**, pending Claude Opus 5.
