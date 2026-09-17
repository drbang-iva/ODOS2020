# R10 A3.1 sealed stop bundle — BLOCKED at §7

NOT EVALUATED. HELD OPEN posture; no A3.1 PR exists and nothing was merged.

Coded-by: Codex — GPT-6 Astra, high effort

## Blocking result and required ruling

The real MCP process, using the project-scoped synthetic admin password fallback, receives **Observation PATCH 200 / Provenance PUT 404** for `amend_observation` on a canonical fact in a closed encounter. Readback confirms **final → amended**, a new version, byte-identical identifier/components/extensions, and **Provenance GET 404**. The required two-entry success/Provenance-presence assertion remains red. The non-atomic partial write is retained in the evidence, not presented as success.

Identity: `r10-a3-1-live-admin@example.invalid`, `Practitioner/3bd8ef2d-cf96-463b-baa7-bbb3e24e7c23`; active project `14e0ec2a-cc7f-4ce6-be82-49d9417f3e95`; membership admin=true, no AccessPolicy references. Clinician session was the synthetic provider; its policy was `AccessPolicy/95fa2233-96b0-49df-850b-f34981c88326`.

A diagnostic comparison with the **recorded G-h service principal** (`r10-a3-1-seeder@example.invalid`, `Practitioner/46f92fa0-7944-420e-8dc8-ab2448c2dca7`) authenticates into **`b4bd13e9-a825-4edd-aaca-e1967d59c28c`**, and the live suite refuses the project mismatch before MCP dispatch. The existing password fallback calls login without selecting the requested project (`mcp/src/fhir-client.ts:206`); the recorded G-h probe did not assert its active project. These are additional §7 observations, not a rerun or rewrite of G-e–G-h.

**Required adjudication:** establish the intended MCP service identity in the synthetic target project and its authorized Provenance PUT/create behavior, or explicitly revise the scope. No roles/policies, project features, service authentication implementation, or scribeAttestation builders were changed to make this pass. The current evidence does not establish the server-side reason for the 404 beyond the identity/project difference. A successful cross-project super-admin probe cannot substitute for this project-scoped real-dispatch row.

## Implementation and source seal

Rev 2.4 carry Step5 implemented without relabeling unchanged. The preserved first `[applied, unconfirmed]` / replan `[unchanged, applied]` probe is now W125 coverage with exact version witness and not-edited behavior, plus auditPending/missing-version controls. Library, diagnosis doors, Ocular Health, carry/previous exams, void/undo, overview/completeness, protocols, release checker, T22 registry/census and MCP guards are implemented within §4. No UI, seeds, policy, roles or net scribeAttestation builder changes.

Branch `drbang-iva/r10-a3-1`; HEAD/base `1706d7c8417b04791471d4332b4ecd712883bf11`. Work is **preserved uncommitted in the requested worktree**, including all evidence. No new commit, push or PR; PR number/head: **not created**. Refreshed origin/main `c742b2e4b543e0706b24f66aec6883a82f0d18a3`, origin/drbang-iva/r10-a2b2 remains the base. Neither moved; no rebase performed. Open PR query still lists only parent #619/#617. Final scope/file inventory is [files-touched.txt](files-touched.txt); SHA256 content seal is [file-sha256.json](file-sha256.json).

## Capability gates and premises retained

No gate rerun in this continuation. Medplum **5.1.30-9b1bd92**, runtime v24.18.1, image digest `sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de`; own project/ports/subnet only. [Runtime](runtime.json), [principals/policies](principals.json), [gate results](gate-results.json), [raw HTTP](gate-http.json), [G-h readback](gate-h-readback.json).

- G-e and G-f retained PASS: conditional Condition/Provenance create/replay. G-f includes provider and staff.
- G-g original no-op setup/finished-Encounter staff403 is preserved; corrected fresh in-progress **provider-only** stale412 result retained PASS. No staff G-g rerun.
- G-h provider PATCH200/Provenance403 attempt preserved as the rev2.3 note. Recorded service fallback outer200/both entries200, final→amended, protected bytes unchanged, Provenance present retained as recorded. Its active-project limitation is now explicit above.
- P1–P26 behavioral verification at base completed before implementation; no moved premise reported. Exact method/results are in [premises](premises/).

Provider login `r10-a3-1-provider@example.invalid`, policy `95fa2233-96b0-49df-850b-f34981c88326`; staff login `r10-a3-1-staff@example.invalid`, policy `2a64dbb9-ffea-4cbe-9647-b0713f422913`. Prior raw/stop artifacts remain intact, including both original G-g runs and provider G-h attempt.

## Executed checks and honest overlap

These are **overlapping scoped runs, not additive totals**. Release scenarios reuse family harnesses; named mutation runs re-execute the same assertions; the live suite's two successful role subtests each contain16 operation rows, not16 tests.

| Suite/evidence | Actual result |
|---|---|
| Library scoped |134/134;50 new focused tests are included |
| Diagnosis read/commands/door integration |97/97 |
| L2 regression |85/85 |
| MCP guards / header refusal / own-PG regression |54/54;1/1;91/91, overlapping |
| Ocular Health focused / broader scoped |94/94;240/240, overlapping |
| Carry focused / credentialed own-stack scoped |157 pass of158,1 credential skip; separate128/128 no skip |
| Void/undo broader scoped |221/221 |
| Overview/protocol combined before supplemental guard |126/126; overview supplemental final27/27; protocol29/29 |
| Parent independent overview/protocol reruns |67/67 and44/44, overlapping |
| W114 diagnosis dependency tests |5/5 |
| Release scenarios final |16/16, no skip/TODO |
| Release checker tests |18/18 |
| T22 endpoint / protocol / MCP runtime |13/3/11 semantic IDs; these are helper rows inside one T22 test, not27 tests |
| T22 MCP additional controls |63 zero-write controls,6 builder variants;5 transport checks |
| §7 final live run |4 tests:2 pass,2 fail (service subtest plus enclosing test);0 skip/TODO |
| Assertion audit / diff check |exit0;2,180 originals accounted for,0 unmapped; git diff --check exit0 |

Scoped family reports/logs are under library/, doors/, mcp/, ocular/, carry/, void-undo/, overview/, protocol/, release/, t22-endpoints/ and mcp-runtime/. Final release TAP: [final-runtime-green.txt](release/final-runtime-green.txt).

**PostgreSQL setup:** own `odos-r10-a3-1-postgres-1`, PostgreSQL16-alpine, loopback29132, test database `odos_a3_test`; Medplum own loopback29131, Redis own compose network `10.249.142.0/24`. SQL test variables in private launchers point to that database; no shared/deployed database. The MCP process live lane uses that local SQL URL with audit adapter disabled for this FHIR policy proof; clinical Provenance remains real. This is not a claim of full SQL audit-lane proof.

**Not completed at this stop:** final `npm --prefix mcp test`, `npm --prefix ui test`, both full builds, `npm run preflight`, and full six-suite `npm --prefix mcp run test:live-authz`. Earlier scoped builds exited0; they do not replace these final checks. Dependency installations were done earlier for all three packages, but no final full-suite result is claimed. Bot review and independent Opus evaluation have not occurred.

## Exact assertion and mutation evidence

[Assertion audit](assertion-audit/REPORT.md): **2,180 original assertions =1,802 context-retained +378 exact mapped rows**,0 gaps/invalid anchors. Each changed/removed assertion has exact base/final file:line, before/after text and V/W mapping in [result.json](assertion-audit/result.json) and referenced ledgers. Reproducible verification exited0 again at this stop. No unsupported assertion change is being waived.

[Guard index](guard-log-index.json), [coverage](guard-coverage.json), [audit](guard-evidence-audit.md): **64/64 required W rows**,125 verified red/green pairs,250 hashed raw logs.114 pairs are TAP runs;11 are standalone MCP assertion probes and are labeled separately. Unique-anchor runners fail loudly on anchor misses. W114 now has25 independent dependency pairs across26 consumer actions; [matrix](w114-consumer-matrix.json). These counts overlap family suites and do not include unexecuted final package tests.

## T22 registry/census and release checker

Fixed27 IDs exactly match registry:13 endpoint phases,3 protocol phases,11 MCP paths. Endpoint helper records33 attempted/33 persisted writes; protocol records5/5 commit,3/3 unapply,1/1 actual compensation restore. MCP records34 actual attempts/34 persisted resources including15 Observation versions;4 decoded patch projections are **not extra writes**. Every Observation is classified against effective definitions. Generic shared-body controls refuse before writes. Carry's five phase rows share one invocation; protocol restore is a real compensation following an enclosing500, with phase-only late-refusal accounting and full invocation traces retained.

Exact AST census: **97 sites in43 files;30 mapped,67 individually reasoned exclusions**, including both Binary JSON Patch entries. [Census output](release/census-output.json), registry `mcp/tests/fixtures/r10/finding-write-paths.json`, exclusions `finding-write-exclusions.json`. Static analysis does not prove arbitrary alias/dataflow. Missing-ID, new write inside registered function, each missing Binary mapping, and extra submitted Binary entry all fail the named T22 test, then restore green: [five results](release/t22-census-mutation-results.json).

Actual `node mcp/scripts/check-r10-a3-release.mjs` exited1 with **only the9 UI slots open** (T4–T6,T15–T18,T21,T22); all16 MCP slots are green. [Exact output](release/checker-stop-output.txt). UI slots are intentionally outside A3.1; this is not a release PASS.

## Live rows and retained failures

[Final33 operation rows](live-stop-results.json), [raw final run](live-stop-readback.txt): staff16/provider16 successful operation rows under stored canonical policies; service amendment entry failure detailed above. Rows carry identity/project/resource/before→after/policy/blocking-lane metadata. Provider pull and identical resend, voidActionId undo, closed/prebuild/signed/superseded refusals, panel/negative/history and mismatched audit checks ran. The service failure prevents the subsequent live generic/append and mismatching-session rows from executing; their in-memory controls do not substitute for live proof.

Earlier runs remain: [seeder metadata403](live-first-run.txt) corrected by reading membership with the existing admin client; [initial transaction failure](live-second-run.txt); [200/404 diagnosis](live-third-run.txt); [recorded service project mismatch](live-recorded-service-run.txt); [whole-suite identity comparison](live-gate-principal-run.txt). No existing assertions were weakened, no identity/project assertion removed, and no gate rerun.

## Risks, follow-up and stopped containers

The material blocker is successful Observation amendment without Provenance under the project-scoped real service dispatch. Resolve identity/project/PUT-create behavior before continuing §7, then execute all deferred full checks, ref/rebase check and normal commit/push/PR workflow. The PR must remain NOT EVALUATED and HELD OPEN for independent Claude Opus; never merge. Writer repair-then-write versus repair-then-unchanged and first-recorded remain the kickoff's existing follow-ups. No new decision document or Mandate14 code ledger is needed: no new medical code claim was introduced; test inputs reuse source terminology constants/definitions.

Stopped, not removed, with the requested project-filtered docker command:
- odos-r10-a3-1-postgres-1
- odos-r10-a3-1-medplum-1
- odos-r10-a3-1-redis-1

All three exited0; no matching container remains running. [Stop evidence](docker-stopped-final.txt). Volumes and synthetic fixture state are preserved.

**Status: BLOCKED — work preserved, NOT EVALUATED, no PR/merge.**
