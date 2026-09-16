# R10 A2b.1 sealed author bundle

**NOT EVALUATED. HELD OPEN through A3. Never merge this slice.** Codex / GPT-6 Astra, high effort, coder. Claude Opus is the independent evaluator; these are author checks only.

## Completed implementation

Rev 3.2 §3.4 reader/writer amendments, digest-independent reassert command witness and W45; findings GET/PUT and audit repair; current-projection candidates and supported Condition-only picks; paged stores; blocking live-authz registration; fixed T1–T22 A3 release gate. No UI or production policy edits.

Task branch `drbang-iva/r10-a2b1`; isolated worktree `.worktrees/r10-a2b1`. Fresh origin/main is `4b3f6d7c25fb40268e216dcd22ad03a866d03643`; `git rebase origin/main` reports up to date. All eleven §2 premise groups were verified at that baseline. Main did not move. Source/inventory implementation through `5ba33bf2`, diagnostic evidence checkpoint `a84ef6d8`, and rev3.3 capture retirement `20a0a28c`; the final PR head and bot adjudications are recorded in the PR description and handoff. Earlier implementation commits are preserved in branch history, beginning with the resumed `a8921e9d`.

## Rev 3.3 scope ruling completed

Applied exactly the approved one-line removal of the retired findings hook in `capture-baseline.mjs` and one README sentence. No other changes to either file. Captures remain compared through compatRows. Misspelling the still-existing overview hook made the wrapper test fail1/1; restoring it passed full parity170/170. Both immutable hashes below were rechecked. Evidence: `rev33/README.md`, `capture-hook-red.tap`, `parity-green.tap`, `parity-after-rebase.tap` and `immutable-hashes.txt`.

Existing assertion bodies in the capture test were unchanged. Mapping: W-c and rev3.3 §4. No missing-hook tolerance was introduced. Full MCP runs with MEDPLUM_PROJECT_ID unset, task-local operator state, and a private installation manifest loaded only by the existing live helper configuration. Audit/SMART isolation passed5/5 and setup-wizard177/177 without assertion changes.

## Verification counts

| Suite/check | Actual result |
|---|---|
| Reader | 34/34 |
| Writer, rev3.2 | 50/50 |
| Findings / command / write gate | 112/112 |
| Candidate/pick L1–L3, visit status and demotion | 128/128 |
| Candidate consumer custom-section fixtures | 55/55; all original assertions retained |
| Pagination + existing store/collector | 31/31 |
| A3 checker | 15/15; separate actual scenario file has16 intentional A3 todos |
| Search contract | 5/5 |
| Integrated focused set after rebase | 429 tests,429 pass,0 fail/skip/todo |
| Full parity after rebase | 170/170;0 fail/skip/todo |
| E1–E17 replay | 17 emitted probes,17 PASS comparisons; unchanged wrapper passes |
| Full MCP, final fixback clean configuration | 5,740 tests:5,716 pass,0 fail,8 named environment skips,16 intentional A3 todos; exit0 |
| UI full | 1,629 tests,1,629 pass,0 fail/skip/todo |
| Final blocking live-authz lane | 69 tests,69 pass,0 fail/skip/todo |
| Final diagnosis live suite after diagnostic correction | 4 tests,4 pass,0 fail/skip/todo |
| Bootstrap live integration | 218/218 |
| Isolated bulk history | 1/1 after disposable FHIR quota configuration |
| Setup CLI isolation | 22/22 |
| SMART fixture isolation | 4/4 without inherited live project ID |
| MCP build / UI build / scripts typecheck | each exit0 |
| Preflight | exit0;0 warnings,0 hard blocks |
| Diff whitespace | exit0 |

The clean full run has zero failures. Earlier configuration attempts and their diagnosed errors are historical checkpoint evidence; they are superseded by `bot-fixback/full-mcp-counts.txt` (rev3.3 baseline was5,738/5,714; two new regression tests account for the increase). The original blocked capture-wrapper test now passes. No failed assertion was weakened and no skip was added.

Eight full-suite skips remain explicitly unproven in that run: operator-assisted scoped clinician exam-start; two isolated Consent matrix checks; Credit Bank Postgres migration; diagnosis-newness Postgres migration; isolated scheduled-enrollment Medplum; reference-population Postgres migration; installed WeasyPrint PDF/A output. The16 todos are the intentional A3 scenarios, not passing release evidence. See raw counts and logs under integration/.

The private disposable server uses `defaultFhirQuota:1000000` so the pre-existing bulk-history seed can complete; stock50,000 failed even standalone. Rate limiting remains enabled, canonical policies unchanged. Operator state is isolated under the private task directory to avoid contaminating unrelated CLI fixture project resolution. Details in `integration/assertion-ledger.md`.

## Assertions and files

Every changed existing assertion has before/after and V/W mapping in `reader/`, `writer/README.md`, `findings/assertion-ledger.md` (104 entries), `pick/assertion-ledger.md`, and `integration/assertion-ledger.md`. New live assertions map V1/V2/V3/V12/V14, W7 and §7/§8. New gate assertions map W40/§9. Custom-section fixture transport changed; its clinical assertions did not.

Exact changed-file inventory: `integration/files-touched.txt`. Production changes are restricted to §4's reader/writer, three diagnosis endpoints, two stores, FHIR collector, and index wiring. Tests/fixtures/package registration and evidence are within the approved associated test scope. Capture instrumentation has only the rev3.3-authorized one-line removal, with its one-sentence README record; the old proposed patch remains historical evidence.

Immutable hashes (same as origin/main):
- `legacy-baseline.json`: `d6bab6c1b64f898b6a40f8911e5f2f2f83bd14438246a0a9d99125c549936235`
- `parity-divergences.json`: `38a1cbbfc325394580d356b80c549c05e717a389409f5ec5096e80afa7a59d76`

## Mutation guards

All23 required IDs were demonstrated red exit1 then restored green exit0: **W4,W7,W8,W10,W26,W27,W28a,W28b,W29,W30,W31,W32,W33,W34,W35,W38,W39,W40,W41,W42,W43,W44,W45**. W7 includes unit and live proof. W38 uses the operator-approved writer-library `[legacy-retire,fact]` fixture; the two-fact partial-failure test remains. W40 includes delete-test, delete-test-and-manifest, skip, and cross-suite path traversal mutations. W45 includes handler409/one-audit and writer classifier proof. Exact paired commands/counts: `integration/guard-index.md` and each evidence README. Route/search inventory amendments also have red→green evidence.

## Live authorization results

Local synthetic project `ea11fe06-da39-47f4-9e18-d5ed6df92652`, pinned Medplum5.1.30-9b1bd92. Staff policy `AccessPolicy/79ded5d9-e554-4106-8c14-c724dd39ec7e`, provider policy `AccessPolicy/d12b563d-f347-4383-b679-492fd80efbea`; stored resources were compared with current canonical compiler output.

Both roles: assert absent→preliminary; clear preliminary→entered-in-error; revive entered-in-error→preliminary; move/link persisted extension changes; final/cancelled→422 unchanged; pre-rebuild→409 unchanged. Staff pick and direct Condition update→403. Both roles also prove two-tab differing-eye409/zero writes and dropped-response Retry→one owner/one clinical write. `integration/live-results.jsonl` and `live/final-diagnosis-live.tap` name role, project, resource/reference, before→after, policy/version and blocking lane. The registered lane has zero silent skips.

## A3 gate and risks

`node mcp/scripts/check-r10-a3-release.mjs` exits1, expected, listing **T1–T22**. Exact output: `integration/a3-release-red.txt`. UI slots are absent until A2b.2;16 MCP scenario todos remain until A3. T21/T22 require broader consumer/write-path inventories in A3; bounded probes do not establish those universal claims. No release claim is made.

Existing measurement/catalog validation statuses are retained under the contract's unchanged-path rule; pick evidence records that interpretation. Historical untagged reassert audits remain valid. No new medical terminology or FHIR artifact URL was introduced, so no Mandate14 clinical ledger rows. No new strategy decision was authored, so no decisions/INDEX.md edit. The operator scope ruling is complete; independent Claude Opus evaluation follows this PR. Both A2b slices remain held open through A3.

## Bot and CI fixbacks

CodeRabbit raised14 threads across two reviews:12 addressed,2 explicitly deferred as pre-existing behavior outside the approved amendments. Every thread receives a reasoned reply; the final-head bot/check state is recorded in the PR description. PR-Agent initially completed with no actionable inline findings. Exact comment IDs, fixes, assertion mappings and deferral rationale: `bot-fixback/README.md`.

Two CI fixture differences were corrected: composite-policy selection and ClientApplication teardown identity (strict cleanup retained). Final cleanup fixback live69/69 and diagnosis4/4 are in `ci-fixback/cleanup-live-green.tap` and `cleanup-diagnosis-green.tap`; final full-run and CI confirmation are recorded in the PR description. The CI live fixture selected composite policies as well as canonical ones. It now requires exactly one role tag, as existing live suites do; the unchanged deep policy comparison remains. Mutation regression1 failed→1 passed; live69/69. New A3 path-containment guard fails on traversal that reuses MCP tests as UI proof; restored checker/findings60/60. Test response type now matches its unchanged assertion. Public evidence paths are normalized without changing counts or diagnostics.

**Unresolved risks for Opus/A3:** writer404/410 deletion classification remains the pre-existing A2a behavior; changing ambiguous-write recovery needs a separate contract. The unchanged audit matcher accepts deterministic key+reference without authenticating all audit fields; a stronger matcher and stable reassert timestamp witness require an expanded persistence/compatibility ruling. These are deferred, not repaired or declared safe. Independent evaluation must judge them before release; this PR remains held.

## Containers and status

All four task containers will be **stopped, not removed**, at final handoff with the requested project-filtered command; the final handoff and PR description record their stopped state:
- `odos-r10-a2b1-medplum-server-1`
- `odos-r10-a2b1-test-postgres-1`
- `odos-r10-a2b1-postgres-1`
- `odos-r10-a2b1-redis-1`

`odos-r10-a2b1-medplum-binary-init-1` had already exited0. Volumes and containers are retained. The initialization container requires no stop.

**Status: implementation and author verification complete; NOT EVALUATED; HELD OPEN through A3. Bot review and final head are recorded in the PR description. Independent Claude Opus evaluation remains required. Never merge.**
