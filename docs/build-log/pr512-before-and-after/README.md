# Before-and-after skill capture demo

These two 1440 × 900 PNGs were produced by the runnable `playwright-core` snippet in
`.claude/skills/before-and-after/SKILL.md`, using a dedicated local Vite server and installed
Google Chrome. Both pages are the existing synthetic `exam-chart-bar-responsive.html` fixture:
`desktop-before.png` uses `?worst=1`; `desktop-after.png` uses the default fixture state.
The names and demographics originate in that committed synthetic fixture, not patient data.

This is a capture/format/publish demonstration, **not evidence of a change to the ODOS UI**.
No application source changed. The capture snippet reported:

```text
Captured two 1440x900 screenshots; formatted docs/build-log/pr512-before-and-after/block.md
```

The independent evaluator's original Markdown-preservation assertion failed against the
upstream body-replacement function (12 probes: 11 passed, 1 failed). With that assertion routed
to the publishing workflow's `pr-body.mjs` companion, the same 12 probes passed. Reintroducing
suffix trimming into the companion caused the preservation assertion to fail (0 passed, 1
failed); restoring the source returned the full probe set to 12 passed, 0 failed. Seven
additional local boundary/CLI probes passed. These are ad hoc verification probes, not a new
application test suite or CI guard.

`LICENSE` and upstream `format.mjs` remain unchanged. The companion is required for PR body
updates; the upstream formatter's `--body-file` path retains its original normalization behavior
and must not be used. PR #512 records the published demo comment, new-head CI, and independent
fixback evaluation separately from these author checks.

Publication was exercised with GitHub CLI 2.86.0 using the documented `gh pr comment
--body-file` path: [demo comment](https://github.com/drbang-iva/ODOS2020/pull/512#issuecomment-5527430890).
The authenticated Contents API returned bytes identical to both committed PNGs, and the
posted comment matched the generated Markdown. GitHub's rendered HTML contains one table
and two images. The links use commit-pinned GitHub repository URLs (`?raw=true`) so signed-in
reviewers retain private-repository access control; no token is embedded in either URL.
