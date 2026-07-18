<!--
Thanks for contributing. Please fill out this template so the reviewer can evaluate your PR efficiently. PRs that skip the template may be closed without comment.

Open an issue first for non-trivial changes. Discussion before code saves everyone time.
-->

## What this PR does

<!-- One- or two-sentence summary. Don't paraphrase the diff — explain the intent. -->

## Linked issue

Closes #

## Why this approach

<!-- What other approaches did you consider? Why this one? Note any FHIR / AccessPolicy / AgentOps / audit / DR implications. -->

## Verification

<!-- How did you test this? Include exact commands and tail of output where useful.
At minimum: `npm test`, type-check, and any relevant slice-specific verification (audit drill, preflight, SMART scope check). -->

- [ ] Type-check passes
- [ ] Tests pass
- [ ] No new cloud calls, telemetry, or phone-home
- [ ] No embedded licensed code-set content (CPT / SNOMED / ICD-10-CM / LOINC / RxNorm)
- [ ] AccessPolicy / AgentOps / audit posture unchanged or explicitly justified

## License

By submitting this PR, I agree my contribution is licensed under the project's **AGPL-3.0-or-later** license.

## Anything reviewers should know

<!-- Migration steps, follow-up work, known limitations. -->

## Independent evaluation

The newest well-formed marker decides the `check-evaluation` gate, regardless
of which GitHub account posts it. The named model must be Fable or Opus, and a
passing evaluation must bind itself to the full current PR head SHA:

```text
Evaluated-by: Fable 5 — PASS
Head-SHA: 0123456789abcdef0123456789abcdef01234567
```

The separators `--` and `-` are also accepted. `FAIL`, `BLOCKED`, and
`NEEDS-WORK` keep the gate red. A new commit makes every earlier marker stale.
The `evaluated` label remains the deliberate operator override and bypasses
the marker and head-SHA checks. Author != evaluator remains a procedural
expectation stated in coding kickoffs, not a mechanically enforced login rule.
