# R10 A3.1 sealed stop bundle — BLOCKED

NOT EVALUATED. HELD OPEN; no PR has been opened, no merge authorized.

Coded-by: Codex — GPT-6 Astra, high effort

## Blocking contract question

Kickoff rev 2.3 §3.5 Step 5 permits the carry-findings witness only when every target is `applied`/`already-applied`. W125 requires a new-command replan after a partial carry to complete. The approved writer returns `unchanged` for an already-correct target under that new command. That status is not an exact replay of the new command.

The executable [probe](carry-unchanged-probe.ts) and [raw output](carry-unchanged-probe.json) demonstrate: first command `[applied, unconfirmed]`; fresh-baseline/new-command replan `[unchanged, applied]`, writer complete=true, no extra Observation, first target version preserved, but Step 5 predicate=false. A clarification was requested; no ruling had arrived at this checkpoint. Carry implementation and subsequent consumers remain untouched. Required ruling: explicitly permit a verified `unchanged` result (reference/version and no audit debt) at Step 5, or revise the replan contract. No silent status relabeling has been introduced.

## Summary and source seal

Partial implementation completed: ownership/historical identity; strict panel identity; authentic audit matching, selected repair and deleted-target behavior; closed diagnosis doors; MCP generic-write and lifecycle guards; Ocular Health canonical history/save. Later carry, void/undo, overview/completeness, protocol and release registry work is incomplete. The live suite is a registered test-first draft, not a live proof result.

Own worktree: `/Users/ericr.bang/GitHub/ODOS2020/.worktrees/r10-a3-1`.
Branch: `drbang-iva/r10-a3-1`. HEAD/base: `1706d7c8417b04791471d4332b4ecd712883bf11`.
No new commit, push, PR number or authored head exists. Work is retained uncommitted. Remote refs were fetched again at the stop; #619 still has that head. `origin/main` is `c742b2e4b543e0706b24f66aec6883a82f0d18a3`. Before any eventual PR, repeat the required remote movement/rebase checks and affected suites.

## Files and assertion mapping

The exact [files touched](files-touched.txt) are within §4: the three current-finding library files, findings/candidates/pick/custom-section endpoints, new shared-finding-write-guard, index route/tool wiring, package live-lane registration, corresponding tests, capability script and this evidence directory. No UI, role/policy, definition seed, or scribe-attestation builder changes. Full content hashes are sealed separately.

Every migrated old assertion and fixture is accounted for in the [library report](library/REPORT.md), [door report](doors/REPORT.md), Ocular Health [before/after assertion ledger](ocular/assertion-migrations.json), and [diagnosis-link migration report](library/link-l2-report.md)/[exact ledger](library/link-l2-assertions.json). These are author evidence, not an independent evaluation. New tests have their V/W rows in their names or accompanying manifests. The §7 draft changes no old assertions.

## G-e–G-h and P1–P26

[Raw gate results](gate-results.json), [HTTP evidence](gate-http.json), [runtime](runtime.json), and [principals](principals.json) retain exact server, policy versions, resources and version changes. Medplum `5.1.30-9b1bd92`, runtime `v24.18.1`, PostgreSQL16 and Redis7. Synthetic project `14e0ec2a-cc7f-4ce6-be82-49d9417f3e95`; loopback Medplum port29131, own subnet `10.249.142.0/24`.

| Gate | Identity | Result |
|---|---|---|
| G-e | Provider `r10-a3-1-provider@example.invalid`, policy `95fa2233-96b0-49df-850b-f34981c88326` | PASS: concurrent conditional Condition201/200, same id, replay200, one resource |
| G-f | Same provider and Staff `r10-a3-1-staff@example.invalid`, policy `2a64dbb9-ffea-4cbe-9647-b0713f422913` | PASS: conditional Provenance201/200 and byte-identical replay200 |
| G-g | Provider only, fresh in-progress Encounter | PASS: stale If-Match412, unchanged Encounter. Prior no-op setup/finished Encounter and staff403 preserved, not counted as stale-write proof |
| G-h | Actual MCP admin-password fallback; `r10-a3-1-seeder@example.invalid`, Practitioner `46f92fa0-7944-420e-8dc8-ab2448c2dca7` | PASS: outer200, both entries200, final→amended, identifier/every component/every extension identical; Provenance reads back targeting Observation |

No service ClientApplication existed at the G-h gate, hence the real `createMcpServiceAuthentication` fallback. Fresh Encounter `d7edc348-80f6-4874-8bf1-6430a1aa6a14`, Observation `aba3c695-f49f-4846-ad0e-2e11d6f56ef4`, Provenance `0b00be2b-26ba-4a92-a8e5-ab0f404c808b`. Setup asserted in-progress and final, with a real version advance. A later synthetic operator ClientApplication was provisioned for the live suite; it was not the earlier gate principal.

The prior provider-login G-h PATCH200/Provenance PUT403 and retained amendment are preserved in [provider readback](gate-h-readback.json), [rev2.2 results](rev22-gate-results.json) and [prior stop](rev23-provider-stop.md). This is the rev2.3 expected wrong-identity/non-atomic note result, not a failed capability gate. Both earlier G-g runs remain in setup-noop/pre-rev22/rev22 raw files. G-e/f/g were not rerun after the rev2.3 ruling.

P1–P26: all reverified at the base, no premise drift. [Consumer report](premises/consumers-REPORT.md), [consumer probes](premises/consumers-probes.log), [source evidence](premises/consumers-source-evidence.txt), [root probes](premises/root-output.jsonl), [tool probes](premises/tools-output.txt). Synthetic behavioral probes and source-path checks are distinguished from live policy proof.

## Test counts and PostgreSQL setup

All root/MCP/UI dependencies installed with npm ci before checks. Own PostgreSQL16 container exposes localhost29132; isolated database `odos_a3_test`. SQL test environment variables point there, never a shared/deployed database. Credentials remain gitignored. The final MCP focused regression includes the formerly skipped SQL assertion.

| Author suite | Actual count | Evidence |
|---|---|---|
| Library focused and old reader/writer | 134 pass,0 fail/skip/todo | library/green.log |
| Existing diagnosis findings suites | 87 pass,0 fail/skip/todo | doors/existing-green.txt |
| Door guards | 10 pass,0 fail/skip/todo | doors/guards-green.txt |
| Earlier pick/candidates/store checkpoint | 139 pass,0 fail/skip/todo | doors/dependents-green.txt; predates OH wire migration |
| MCP dispatch guards | 54 pass,0 fail/skip/todo | mcp/mcp-guards-green.tap |
| MCP custom POST header | 1 pass,0 fail | mcp/custom-capture-header-green.tap |
| MCP related regression with own PostgreSQL | 91 pass,0 fail/skip/todo | mcp-guards-postgres-regression.txt |
| Final OH/library/door scoped regression | 240 pass,0 fail/skip/todo | ocular/scoped-regressions.tap |
| Final diagnosis-link L2 | 85 pass,0 fail/skip/todo | library/link-l2-green.txt |
| Existing credentialed diagnosis door regression | 4 pass,0 fail/skip/todo | doors/live-regression.txt |

These suites overlap; their counts must not be summed as unique tests. Initial failing and intermediate regression logs are retained alongside restored results. Final MCP TypeScript build exited0 (ocular/mcp-build.log). Final git diff --check exited0. OH mapped207 changed/removed assertions with0 unmapped; the Link L2 follow-up mapped all nine changed assertions with0 unmapped. Earlier door and library migrations are separately recorded.

Full `npm --prefix mcp test`, `npm --prefix ui test`, UI build, preflight, full live-authz lane, and all release scenario bodies are NOT complete at this stop. No claim of full §8 green.

## Live authorization evidence

The existing diagnosis-door regression executed with real Staff/Provider logins and stored canonical policies:4/4. Its raw diagnostic rows include identity, project, resource, before→after, policy reference/version, and blocking lane. It is not a substitute for the new §7 suite.

The new `r10OcularHealthDoorAuthzLive.test.ts` is registered in `test:live-authz`, with real subprocess MCP service identity and matching/mismatching session practitioner coverage. It has NOT RUN because carry/void/undo production paths remain incomplete. See [draft report](live-suite-draft-report.md). Thus all new §7 live rows are pending, including actual dispatch amendment/mismatch. The direct G-h builder gate above is separately complete.

## Guard mutations, registry and release checker

[Guard log index](guard-log-index.json) links every executed red/restored-green pair. Individual manifests and result logs live in library/, doors/, mcp/, ocular/ and mutations/. The shared runner requires exactly one mutation anchor, refuses a no-op, checks designated behavioral failure, restores in finally, and verifies original bytes. No anchor miss is silently accepted. Missing guard rows are explicitly listed in guard-coverage.json; the complete §8 mutation obligation is NOT fulfilled.

T22 registry: not implemented. [Preliminary AST inventory](write-census-inventory.json) has72 candidate call sites; this is reconnaissance, not an enforced final census or zero-unregistered-writes claim. [T22 plan](t22-census-plan.md) records remaining semantic/exclusion/bypass checks.

`node mcp/scripts/check-r10-a3-release.mjs`: exit1, **R10 A3 release BLOCKED**. [Exact output](release-check-at-stop.txt). MCP T1–T3,T7–T14,T17,T19–T22 TODO slots remain open; UI slots remain incomplete. Checker fixes and green fixture are not implemented. No claim of MCP slots green.

## Risks, follow-ups and status

This is a partial uncommitted build, not releasable and not independently evaluated. Resolve the carry Step5/W125 contradiction first; then resume §3.5–§3.8 and §3.11 in order, remaining assertions/guards, live suite, complete tests/builds/preflight, release slots, final remote/rebase checks, PR and bot review. No new clinical terminology was introduced; no new decision or Mandate14 ledger entry was authored in this code checkout. Contract ruling belongs in PerformanceOD; no shared companion checkout was switched, pulled or committed.

Status: **BLOCKED — NOT EVALUATED**. No PR, no merge. Docker shutdown and final file seal are recorded in the adjacent stop artifacts.

## Container shutdown

Executed the operator-specified `docker ps -q --filter "name=^odos-r10-a3-1-" | xargs -r docker stop`, exit0. Stopped (not removed):

```text
odos-r10-a3-1-postgres-1 Exited (0) 35 seconds ago
odos-r10-a3-1-medplum-1 Exited (0) 35 seconds ago
odos-r10-a3-1-redis-1 Exited (0) 35 seconds ago
```

Volumes and synthetic evidence remain for resumption. No shared containers were stopped.
