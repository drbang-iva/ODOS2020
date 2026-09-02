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

The newest marker decides the `check-evaluation` gate, regardless of which
GitHub account posts it. For an evaluation, the named model must be Fable, Opus,
or Codex in a form accepted by the parser (including `Codex (gpt-5.6-sol)`;
see CONTRIBUTING.md). A passing evaluation must bind itself to the full current
PR head SHA:

```text
Evaluated-by: Fable 5 — PASS
Head-SHA: 0123456789abcdef0123456789abcdef01234567
```

The separators `--` and `-` are also accepted. `FAIL`, `BLOCKED`, and
`NEEDS-WORK` keep the gate red. A new commit makes every earlier marker stale.
The `evaluated` label alone does not pass. An operator-authorized override
requires that label AND the following evidence in the same newest marker comment:

```text
Evaluated-by: <authorizing operator name> — OVERRIDE
Head-SHA: <40-character current PR head SHA>
Override-Reason: <nonempty reason for the authorized bypass>
```

The Head-SHA must match the current PR head, and each field must appear exactly
once. A newer OVERRIDE deliberately supersedes NEEDS-WORK; older evidence cannot
rescue a newer negative or malformed marker. The typed name is a record, not
authentication. Author != evaluator remains a procedural expectation stated in
coding kickoffs, not a mechanically enforced login rule.
