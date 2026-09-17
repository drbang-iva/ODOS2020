# R10 A3.1 sealed stop bundle — BLOCKED after rev 2.5 live proof

NOT EVALUATED. HELD OPEN posture. No implementation commit, push, PR or merge at this stop; work is preserved in the requested worktree.

Coded-by: Codex — GPT-6 Astra, high effort

## Blockers and next ruling

The rev 2.5 §7 lifecycle requirement is now proved. The full-check wave is not green. It exposed the following scope boundaries and additional unresolved failures:

1. `npm run preflight` exits 1 because `scripts/fhir-read-grant-check.ts` contains nine exact MCP service call-site inventory entries at their old line numbers. First: VisionPrescription at3251, now3269. All nine old/current anchors are recorded in [preflight-stale-inventory.json](full-checks/preflight-stale-inventory.json). Updating this file is outside §4; it is untouched. The CPT guard passed; the command stopped at FHIR grant inventory before preflight-lint.
2. `npm --prefix ui test` exits1:1685 tests,1673 pass,8 fail,0skip,4TODO. Six failures use the old Ocular Health request/consumer contract; two compare void consumer results that omit the new `voidActionId`. [Exact failures](full-checks/ui-failures.json), [full output](full-checks/ui-test.txt). The four existing A3 release TODOs are separate from these eight failures. No UI code/assertion was edited or marked TODO. A3.2 migration or an explicit ruling is needed for these existing full-suite failures; nine open release-checker UI slots do not make them passing tests.

3. The full MCP suite exits 1: 6037 tests, 5911 pass, 121 fail, 5 skipped, 0 TODO. [All failures](full-checks/mcp-failures.json) and [triage](full-checks/failure-triage.md) separate inventory/source-contract failures, outdated consumer fixtures and disposable-environment setup/throttling. These are unresolved; no claim is made that they all predate A3.1. The main preflight command stopped early, but full-suite tests additionally expose the carry-plan/carry-versions URL-shape lint and an unresolved carry-provenance search-contract call.

Needed continuation scope: authorize the exact preflight inventory maintenance and rule on the A3.1 full-UI-suite requirement versus the deferred A3.2 consumer migration. No guard was bypassed or weakened to satisfy the full checks.

## Implementation and preservation

Rev2.4 carry Step5 accepts applied/already-applied/unchanged outcomes only with reference+version and no auditPending. W125 preserves first `[applied, unconfirmed]` / replan `[unchanged, applied]`, records the unchanged fact's current version and verifies not-edited; missing-version/auditPending controls refuse the witness. Library, diagnosis doors, Ocular Health, carry/previous exams, void/undo, overview/completeness, protocols, release checker, T22 registry/census and MCP guards are implemented within §4.

No net UI, roles/policies, definition seeds, scribeAttestation builder, service-authentication or project-feature changes. This continuation changes the live test and evidence under the rev2.5 ruling; three live mutation guards restored the production sources exactly. No new medical coding claim was introduced, so no new Mandate14 ledger row or decision document was authored. No writes to the performance-od checkout; contract read from fetched origin/main only.

Branch `drbang-iva/r10-a3-1`; HEAD/base `1706d7c8417b04791471d4332b4ecd712883bf11`. Refreshed origin/main `c742b2e4b543e0706b24f66aec6883a82f0d18a3`; origin/drbang-iva/r10-a2b2 remains the base. Neither moved; no rebase. PR number/head: **not created**. File inventory: [files-touched.txt](files-touched.txt); content hashes: [file-sha256.json](file-sha256.json). Earlier stop bundles/raw runs remain intact.

## G-e–G-h and P1–P26

No capability-gate reruns in this continuation. Medplum5.1.30-9b1bd92, runtimev24.18.1, image `sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de`. [Runtime](runtime.json), [principals/policies](principals.json), [raw gate HTTP](gate-http.json), [gate results](gate-results.json), [rev2.5 grading](rev25-gate-adjudication.md).

G-e/G-f retained PASS. G-g original no-op/finished-Encounter staff403 retained as setup evidence; corrected fresh in-progress provider-only stale412 retained PASS. G-h provider PATCH200/Provenance403 and super-admin200/200 retained as recorded, but **super-admin200/200 is NOT accepted evidence**. Rev2.5 accepts G-h JSON Patch field preservation only. Project-scoped200/404 and project-mismatch attempts also remain unchanged. See the adjudication for exact principal/project limitations.

P1–P26 behavioral verification completed before implementation on the base, no moved premises: [premise evidence](premises/). Provider login `r10-a3-1-provider@example.invalid`, policy95fa2233-96b0-49df-850b-f34981c88326; staff login `r10-a3-1-staff@example.invalid`, policy2a64dbb9-ffea-4cbe-9647-b0713f422913.

## §7 live proof and lifecycle limitation

[Live results](rev25-live-results.md), [38 exact operation rows](rev25-live-results.json), [raw TAP](rev25-live-first.txt): **4/4 tests,0skip/TODO**; staff16/provider16/service6 operation rows are not additional tests. Rows retain role/identity, project, resource, before→after, policy reference and blocking lane. Staff closed pull403 is distinguished from provider409; generic-create public-schema refusal is distinguished from downstream guard coverage.

Actual MCP service password fallback: `r10-a3-1-live-admin@example.invalid`, `Practitioner/3bd8ef2d-cf96-463b-baa7-bbb3e24e7c23`, membership admin=true, no policy references. Authenticated active project asserted equal to synthetic project `14e0ec2a-cc7f-4ce6-be82-49d9417f3e95`; superAdmin explicitly false. Session practitioner is the synthetic provider.

Closed canonical amendment: PATCH200, final→amended and versionadvanced; identifier, every component including R10_CURRENT_META/R10_OPERATION, and every extension byte-identical. Provenance entry404/readback404 is recorded as the known defect, neither asserted as required404 nor presented as success. Mismatching practitioner and pre-rebuild canonical amendment refuse with zero writes; remaining generic/append refusals and audit-mismatch rows execute.

Required follow-up: **MCP attest/amend/append write no Provenance under a project-scoped identity (Medplum canSetId = super admin) — pre-existing, separate slice (kickoff rev 2.5 §3.13)**.

## Assertion and guard seal

[Original assertion audit](assertion-audit/REPORT.md):2180 original assertions=1802 retained+378 exact mapped changes,0gaps/invalid anchors; [fresh verification](full-checks/assertion-verification.txt). [Rev2.5 migration audit](rev25-live-assertion-migrations.md) records live checkpoint101→111 direct assertions,97 unchanged,4removed/replaced→14added with exact before/after and V35/W115/§7 mapping. No unsupported assertion migration is waived.

[Guard coverage](guard-coverage.json), [128-pair index](guard-log-index.json), [audit](guard-evidence-audit.md): **64/64 required W rows;128 verified red/green pairs;256 hashed logs**.117 are TAP pairs,11 standalone MCP assertion probes. New live pre-rebuild/session/identity mutants each fail2of4 tests including the enclosing test, then restore4/4. Unique-anchor misses are loud. Mutation runs overlap normal suites; do not sum their test counts.

## T22 and release checker

[Registry/census output](release/census-output.json):27 semantic IDs (13endpoint/3protocol/11MCP),97sites across43files,30mapped,67individually reasoned exclusions including both Binary JSON Patch entries. Endpoint33attempted/33persisted writes; protocol5/5commit,3/3unapply,1/1compensation restore; MCP34actualattempt/34persisted,15Observationversions. Four decoded patch projections are not extra writes.63MCPzero-write controls,6builder variants,5transport checks. T22 is one test invoking these helpers, not27tests. Static census does not prove arbitrary alias/dataflow. Five named-T22 census mutants fail then restore: [results](release/t22-census-mutation-results.json).

[Fresh checker command](full-checks/release-checker.txt) exits1 **only for nine open UI slots** T4–6,T15–18,T21,T22. All16MCPslots are green; no MCPTODO remains. This is not a release PASS.

## Full checks and PostgreSQL setup

Dependencies freshly installed before suites: root10 packages, MCP261, UI150; each npm ci exits0 and reports0 vulnerabilities. No probe files were placed in ui/src, ui/tests or mcp/tests for this full-check wave. Test helpers remain outside discovery or are intentional committed tests.

Own PostgreSQL16-alpine container `odos-r10-a3-1-postgres-1`, loopback29132, dedicated test database `odos_a3_test`; Medplum loopback29131, Redis on own compose network `10.249.142.0/24`. SQL URL/PG variables came from private synthetic fixture files; no shared/deployed database. The live MCP child uses local SQL with audit adapter disabled for this FHIR policy proof; clinical Provenance remains real. No claim of full SQL audit-lane proof.

| Actual command | Result |
|---|---|
| `npm --prefix mcp test` | exit1;6037 tests,5911pass,121fail,5skip,0TODO |
| `npm --prefix ui test` | exit1;1685 tests,1673pass,8fail,0skip,4TODO |
| `npm --prefix mcp run build` | exit0 |
| `npm --prefix ui run build` | exit0; existing large-chunk warning |
| `npm run preflight` | exit1; stale exact inventory; CPT guard clean; preflight-lint not reached |
| `git diff --check` | exit0 |
| `npm --prefix mcp run test:live-authz` | exit1;73 tests,72pass,1fail,0skip/TODO |
| `node mcp/scripts/check-r10-a3-release.mjs` | exit1; only9UIslots open,16MCPslots green |
| Direct final release-scenario suite |16/16,0skip/TODO; census27paths/97sites/30mapped/67excluded |

[Raw command outputs](full-checks/), [parsed counts](full-checks/counts.json), [failure triage](full-checks/failure-triage.md). Live lane failure is the existing clinical-write suite's enclosing cleanup assertion: three synthetic ProjectMembership DELETE requests return403; its25 child checks pass. NewA3suite4/4 also passes inside this full lane. No super-admin substitution or cleanup assertion weakening.

Five full-MCP skips: operator-assisted scoped-clinician RBAC tokens absent; two dedicated consent/evidence matrix tests; isolated scheduled-enrollment lane; installed WeasyPrint69 PDF/A check. These are not counted as passes. The credentialed live-authz run has zero skips.

Counts overlap: full MCP includes release/consumer suites and live tests; the separate live lane re-executes those tests; scoped author runs and128 mutation pairs repeat them. Never add these counts. Prior scoped runs retained: library134/134 (50new subset); doors97/97 andL2 85/85; MCPguards54/54+header1/1+PG91/91; Ocular94/94 and240/240; carry157/158 with1credentialskip then own-stack128/128; void/undo221/221; overview/protocolcombined126/126, then overview27/27 andprotocol29/29; independent reruns67/67 and44/44; W114doors5/5; checker18/18. They do not override the failing final full suites.

## Risks, follow-ups and status

**BLOCKED. NOT EVALUATED.** Production and evidence changes remain preserved uncommitted on the requested branch. No PR/head beyond the base, no bot review, no independent Opus evaluation, no merge. The exact scope expansion and UI/full-suite ruling above are required; all remaining failures must be triaged/fixed and affected tests/guards rerun before normal commit/push/PR. Any changed assertion must retain its V/W mapping. The lifecycle missing-Provenance defect remains a separate follow-up under rev2.5; writer repair-then-write versus repair-then-unchanged and first-recorded remain the kickoff's other deferred items. Independent Claude Opus must evaluate the eventual exact PR head; author checks are not an evaluation.

## Containers stopped, not removed

Executed `docker ps -q --filter "name=^odos-r10-a3-1-" | xargs -r docker stop`. Final states:

```text
odos-r10-a3-1-postgres-1 Exited (0) 16 seconds ago
odos-r10-a3-1-medplum-1 Exited (0) 16 seconds ago
odos-r10-a3-1-redis-1 Exited (0) 16 seconds ago
```

No other Docker project was stopped. Volumes and synthetic resources are retained for continuation.
