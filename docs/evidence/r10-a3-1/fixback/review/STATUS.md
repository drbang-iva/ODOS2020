> Historical stop report. The subsequent protocol-cache ruling supersedes this stop; see [the resumed fixback bundle](FINAL.md). Counts below describe the earlier preserved state only.

# PR #620 CodeRabbit fixback — sealed stop report

Status: **BLOCKED — rollback rule needs adjudication. NOT EVALUATED. HELD OPEN.**

Coded-by: Codex — GPT-6 Astra, high effort

Published head remains `ef4882c726039e7c9b30e31cd510486e61d30add`. All new work is preserved, uncommitted, in the same worktree/branch. Nothing was pushed or merged during this turn. The independent evaluator remains Claude Opus.

## Blocking conflict

The new ruling says to load the protocol projection once per request. Existing W108 requires a fresh pre-rebuild check during rollback. Its fixture creates a legacy snapshot after an Observation removal, then causes the following finding-state write to fail. With the cached projection, restoration is permitted and the original failure escapes; the expected 409 refusal is lost.

Executed the exact existing test `W108 actual unapply rollback pre-rebuild refuses Observation restore` both ways:

- [Fresh projection](W108-fresh-projection.txt): **1 test, 1 pass, 0 fail**.
- [Once-per-request projection](W108-once-per-request.txt): **1 test, 0 pass, 1 fail**.

Source was restored to the new request-cache implementation. No W108 assertion was changed. A question is pending: permit a fresh safety projection for rollback while normal command execution uses the request cache? This requires clarification because silently retaining the old fresh read would violate the new cache ruling, while deleting the existing refusal assertion would violate “never loosen one.”

## Preserved implementation

- One best-effort post-command closure helper, used by all five routes; failures retain the exact command status/body without a closure flag. One real-route test per route.
- Definition-scoped priors search includes inactive field/option codes; unscoped contributing rows are counted/skipped; foreign subjects remain 409.
- Completeness loads candidate encounter evidence with a concurrency limit of four; current encounter always included; canonical/panel/negative credit pinned.
- Request-scoped protocol projection cache; fresh Encounter closure/patient checks; removed the immediate duplicate Observation removal guard. Rollback semantics remain blocked as above.
- Inactive unapply is a zero-write no-op before validation.
- Unknown/non-shared panels return 400 `not-a-shared-finding`.
- Census reports missing roots; planted consumer remains visible.
- Usage, exclusion rationale, T20 URL conversion, candidate copying, and both live-test cleanup fixes.
- Ten duplicated pre-rebuild-only tests removed under explicit item 12 authorization; one accurate refusal test retained, with named canonical write coverage in source.
- UI slots and inherited search-mode behavior unchanged under the ruling.

[Files touched](files-touched.json): **24 source/test/script files**, plus this evidence directory and `mutations/review-*` proof logs. [Source hashes](source-sha256.json).

## Verification at the preserved working tree

| Command/check | Actual result |
|---|---|
| Scoped 10-file server suite | **333 tests, 332 pass, 1 fail, 0 skip, 0 TODO**; sole failure W108 above. [Raw](scoped-suite.txt) |
| Mechanical and cleanup source-block tests | **5 tests, 5 pass, 0 fail**. [Raw](small-tests.txt) |
| Mutation runner | **19/19 designated mutants red (exit 1), restored tests green (exit 0)**. [Test names and exact counts](red-green.md), [manifest](mutations.json), [results](mutation-results.json). Repeated/overlapping focused suites are not additive. |
| MCP build | Exit **0**. [Raw](mcp-build.txt) |
| `git diff --check` | Exit **0** |
| Release checker | Exit **1**, expected incomplete A3 release: **16 MCP slots green; 9 UI slots open**. No MCP failure; only UI open-slot diagnostics. [Raw](release-check.txt) |
| Full MCP / full UI / UI build / full preflight / CI-built live lane | **Not rerun for this preserved patch**, pending the W108 rule. No new PostgreSQL or Medplum stack started. |
| New-head hosted CI | **Not triggered**; no new head pushed. |

An initially ambiguous T20 mutation anchor was rejected loudly before mutation execution, then narrowed to the census call site. It is not counted as red proof. The final 19-run manifest uses exact one-occurrence anchors and restores source bytes.

The first release-check attempt rejected the new pick regression test because the release scenario file permits only the fixed scenario set. The regression test was moved to `r10A3DoorGuards.test.ts`; its mutation was re-run red/green and the release checker then reported only the nine open UI slots. No release assertion was weakened.

## Assertion ledger

[AST assertion audit](assertion-audit.json), baseline ef4882c7: **1,008 retained; 31 removed/changed; 52 added/changed; zero unmapped**, across 12 touched test files. [Deleted-test before/after ledger](deleted-assertion-ledger.json) records all ten authorized duplicate removals with V3/W75 and replacement coverage. F1’s unscoped refusal is explicitly superseded by the new V21 ruling. Existing W108 remains unchanged.

## Hosted CI and bots — published ef4882c7 only

These results belong to the published head, **not** the uncommitted fixback:

- [MCP job](https://github.com/drbang-iva/ODOS2020/actions/runs/35213873793/job/105177706497): **5,992 tests, 5,939 pass, 0 fail, 53 skip, 0 TODO**; live bootstrap **12/12**, live integration **218/218**, live authorization **73/73**. CI installs WeasyPrint 69.0; local preceding full run’s only final failure was the base-reproduced WeasyPrint ENOENT. PostgreSQL/live-stack setup and exact environment are in the prior [ruling bundle](../RULING.md).
- [UI job](https://github.com/drbang-iva/ODOS2020/actions/runs/35213873793/job/105177706336): **1,685 tests, 1,673 pass, 8 carried failures, 0 skip, 4 TODO**.
- CodeRabbit **terminal: Review completed**, re-polled well over four minutes after completion at ef4882c7. [Current check snapshot](github-checks.txt). Its 16 inline findings and 3 nitpicks are not claimed resolved by this unpushed patch.
- PR-Agent terminal at ef4882c7; previous dispositions retained. Independent evaluation gate remains red, expected.

## Every CodeRabbit disposition

| Ruling item | Disposition |
|---|---|
| #7, #16, #17 and audit-repair/carry equivalents | Implemented locally; five route tests; common catch-removal mutant red/green. Await final commit and thread replies. |
| #5 and nit 781 | Implemented locally; count/foreign/code/inactive mutants red/green. Await final commit and replies. |
| #6 | Implemented locally; irrelevant-history and bounded-concurrency mutants red/green; three credit modes preserved. Await final commit/reply. |
| #8 | Request cache and live lock implemented/proven; blocked on W108 rollback interpretation. No completion reply posted. |
| #9 | Implemented locally; closed/pre-rebuild inactive no-op tests, mutant red/green. Await final commit/reply. |
| #4 | Implemented locally; unknown/non-shared errors and mutant red/green. Await final commit/reply. |
| #2 | Implemented locally; missing root plus planted consumer and mutant red/green. Await final commit/reply. |
| #3, #11, nit 182, nit 275, #13, #14 | Implemented locally with red/green evidence. Await final commit/replies. |
| #12 | Authorized duplicate-test removal with assertion ledger; retained refusal guard red/green. Await final commit/reply. |
| #15 | No change. [Ruling replied on thread](https://github.com/drbang-iva/ODOS2020/pull/620#discussion_r4036561393). |
| #10 | Separate release follow-up. [Ruling replied on thread](https://github.com/drbang-iva/ODOS2020/pull/620#discussion_r4036562695). |

## Upstream, risks, and remaining work

Fetch completed. `origin/main` remains `c742b2e4b543e0706b24f66aec6883a82f0d18a3`; `origin/drbang-iva/r10-a2b2` remains `1706d7c8417b04791471d4332b4ecd712883bf11`. Neither moved; no rebase.

Remaining after ruling: finish protocol guard semantics and any necessary fresh-rollback mutation, rerun full requested checks/live lane, refresh any permitted read-inventory line anchors, finalize evidence, commit/push, reply to all remaining bot threads with commit, wait new-head CI and CodeRabbit terminal + four-minute re-poll. Full-suite results from ef4882c7 must not be reused as proof of the local patch.

Carried risks/follow-ups: eight UI failures for A3.2; pre-existing project-scoped lifecycle Provenance defect; inherited FHIR search outcome handling needs Medplum reproduction before release merge. No new medical codes, FHIR URLs, credentials, policies, or operator account changes.

## Container cleanup

No Docker containers were started in this turn. Executed the requested `docker ps -q --filter "name=^odos-r10-a3-1-" | xargs -r docker stop`; no matching running containers. **Stopped this turn: none.** Prior six CI/ruling containers remain stopped, not removed.
