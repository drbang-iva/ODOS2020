# Contributing to ODOS

ODOS is built by a practicing optometrist and refined at his own practice. The repo is public so others can read, learn, fork, and — if helpful — contribute. Pull requests are welcome but reviewed at the pace of a working clinical practice. Thanks for understanding.

## Before opening an issue

- Check existing issues first.
- One issue = one topic. Don't bundle unrelated bugs/feature requests.
- Use the templates. Issues filed without a template may be closed without comment.

## Before opening a pull request

- Open an issue first for anything non-trivial. Discussion before code saves everyone time.
- One PR = one logical change. Don't bundle unrelated changes.
- Match the existing code style. We use TypeScript / Node, plain FHIR REST, and minimal third-party SDK surface.
- Include tests for new behavior. The repo's verification posture is real, not decorative.
- Don't break the AgentOps governance, audit/DR, or local-only data posture. These are load-bearing.

## Independent evaluation gate

Every PR into `main` needs an independent Fable or Opus evaluation. The review
bots (Greptile + PR-Agent) are a first-pass review, not the final evaluator.
CodeRabbit is retired — suspended account-wide 2026-08-04 for cost. A well-formed final marker from
Fable or Opus passes from any GitHub account. Author != evaluator remains a
procedural expectation stated in coding kickoffs, not a mechanically enforced
login rule.

The marker must include exactly one verdict line and the full current PR head
SHA:

```text
Evaluated-by: Opus 5 — PASS
Head-SHA: 0123456789abcdef0123456789abcdef01234567
```

Once all other gates are green and the head is final, the PR author hands off for
independent evaluation. **There is no bot trigger to post** — Greptile and PR-Agent
auto-run on every PR. Greptile takes 7–13 minutes and PR-Agent about a minute, so
**re-poll at the final head before handing off**: zero threads on a check still
`in_progress` means pending, not clean. Reply to or resolve every existing thread
first. See AGENTS.md "Author ≠ evaluator" for the full rule.

The evaluator runs `scripts/eval-worktree.sh <PR#> --keep` to verify the exact
head and surface all paginated inline comments plus review submissions. Before
posting a verdict, adjudicate every current-head inline comment and acknowledge
the displayed count:

```text
scripts/eval-post-verdict.sh <PR#> PASS "Opus 5" --ack-comments <N>
```

Stale comments remain visible but do not count toward `<N>`. When the
current-head count is zero, omit `--ack-comments`. Use `--dry-run` to inspect
the count and marker without requiring inline-comment acknowledgment or posting
anything.

If no bot review submission exists at the exact head, `eval-post-verdict.sh`
blocks unless the evaluator passes `--ack-no-bot-review`. That flag records
`Bot-review-at-head: NONE (acknowledged)` in the marker and is rejected when an
exact-head bot review does exist, so it cannot become boilerplate. `--dry-run`
enforces and reports this bot-review acknowledgment without posting a marker.

> **⚠️ Known gap, 2026-08-04 — needs a code change, not a doc change.**
> `eval-post-verdict.sh` detects the bot review by looking for **CodeRabbit**
> specifically. CodeRabbit is retired, so that check now finds nothing on every
> PR and forces `--ack-no-bot-review` every time — turning a deliberate gate into
> the boilerplate it was explicitly designed not to become, while a real Greptile
> review sits on the PR unrecognised. The script must be taught to accept a
> Greptile (or PR-Agent) review at the exact head. Until then, treat an
> `--ack-no-bot-review` marker on this repo as **unverified**, not as evidence
> that no bot reviewed the code.

Only Fable or Opus can issue the final verdict. Any new commit requires a new
marker for the new head. The `evaluated` label is an explicit operator override
that bypasses marker and head-SHA enforcement.

## License terms for contributions

ODOS is licensed under **AGPL-3.0-or-later**. By submitting a pull request, you agree your contribution is licensed under the same terms.

The AGPL is intentional. ODOS exists so practices own their software. The AGPL ensures no one — including a future commercial reseller — can take this code, run it as a hosted service, and lock practices out of their own data again. If that's a problem for your use case, ODOS probably isn't the right project for you.

## Things that will get a PR closed without review

- Adding cloud calls, telemetry, "phone home" features, or remote logging by default.
- Embedding licensed code-set content (CPT, SNOMED, ICD-10-CM, LOINC, RxNorm) directly in the repo. ODOS references these; it does not redistribute them.
- Submitting AI-generated PRs with no understanding of the code, no tests, and no engagement with reviewer comments.
- Bypassing AgentOps, audit, or access-policy enforcement.
- Vendoring large third-party SDK surface that creates lock-in to a single backend.

## Reporting security issues

Don't open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## Pace expectations

This is a single-practitioner-led project. PR review may take days to weeks. Issues may sit before triage. If a contribution is time-sensitive for your own deployment, fork it.
