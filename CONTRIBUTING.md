# Contributing to OSOD

OSOD is built by a practicing optometrist and refined at his own practice. The repo is public so others can read, learn, fork, and — if helpful — contribute. Pull requests are welcome but reviewed at the pace of a working clinical practice. Thanks for understanding.

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

## License terms for contributions

OSOD is licensed under **AGPL-3.0-or-later**. By submitting a pull request, you agree your contribution is licensed under the same terms.

The AGPL is intentional. OSOD exists so practices own their software. The AGPL ensures no one — including a future commercial reseller — can take this code, run it as a hosted service, and lock practices out of their own data again. If that's a problem for your use case, OSOD probably isn't the right project for you.

## Things that will get a PR closed without review

- Adding cloud calls, telemetry, "phone home" features, or remote logging by default.
- Embedding licensed code-set content (CPT, SNOMED, ICD-10-CM, LOINC, RxNorm) directly in the repo. OSOD references these; it does not redistribute them.
- Submitting AI-generated PRs with no understanding of the code, no tests, and no engagement with reviewer comments.
- Bypassing AgentOps, audit, or access-policy enforcement.
- Vendoring large third-party SDK surface that creates lock-in to a single backend.

## Reporting security issues

Don't open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## Pace expectations

This is a single-practitioner-led project. PR review may take days to weeks. Issues may sit before triage. If a contribution is time-sensitive for your own deployment, fork it.
