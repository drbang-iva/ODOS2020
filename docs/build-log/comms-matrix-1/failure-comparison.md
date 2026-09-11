# Full MCP failure comparison

Both runs executed `npm --prefix mcp test` with the same privately injected local synthetic-stack environment, including `ODOS_MATRIX_LIVE=1` and serial test-file execution from the package command. Each subprocess exit was captured directly, without a pipeline. No credential values are included here.

The base worktree is detached at `78a8ef6f7691ccffad2a752231f818ae2d9668bd`, with no tracked or untracked source changes. Dependency links point to the identical installed lockfile dependencies. The stack and project were held constant; accumulated synthetic data and request-rate timing are limitations of this comparison, not identical database snapshots.

| Run | Total | Passed | Failed | Skipped | Exit |
|---|---:|---:|---:|---:|---:|
| Initial branch | 4626 | 4598 | 23 | 5 | 1 |
| Clean base, first run | 4578 | 4565 | 8 | 5 | 1 |
| Clean base, repeated command | 4578 | 4565 | 8 | 5 | 1 |
| Branch before quota isolation at 2d4eae38 | 4626 | 4604 | 17 | 5 | 1 |
| Pre-review branch at ee6f1bb1 | 4626 | 4613 | 8 | 5 | 1 |
| Review corrections, ValueSets initially in profiles | 4638 | 4617 | 16 | 5 | 1 |
| Clean base after review corrections | 4578 | 4565 | 8 | 5 | 1 |
| Final review corrections, ValueSets in terminology | 4638 | 4625 | 8 | 5 | 1 |

All 23 initial failures are listed below. “Pass” in the base column means that test was not in its failure list.

| # | Test | Base | Classification and disposition |
|---|---|---|---|
| 1 | live FHIR read grant check covers all four chart resources through compiled role policies | Pass | Branch inventory: approved Consent addition and 29-to-30 count; deletion mutation demonstrated. |
| 2 | FHIR read grant CLI passes only with full coverage and always prints its limits | Pass | Branch inventory: approved Consent addition and 29-to-30 count; deletion mutation demonstrated. |
| 3 | the shipped MCP, UI, and data trees contain no unallowed CPT-shaped literal | Pass | Branch source: report limit now uses a named numeric constant; scanner unchanged. |
| 4 | admin canonicalization ignores rule, interaction, and object-key ordering | Pass | Branch fixture: approved writeConstraint preservation; dropping it fails unchanged canonical assertion. |
| 5 | SMART registration refuses a session project mismatch before POSTing a client | Fail | Also fails at base: configured project conflicts with the existing synthetic fixture project. Existing test unchanged. |
| 6 | SMART registration checks auth/me before creating a client in the configured project | Fail | Also fails at base: configured project conflicts with the existing synthetic fixture project. Existing test unchanged. |
| 7 | synced practice policies enforce all repaired clinical writes on running Medplum | Fail | Also fails at base: privileged fixture requires ODOS_OPERATOR_PROJECT_ID. Existing test unchanged. |
| 8 | a clear persists the encounter undo ledger under the synced Provider and Staff policies on running Medplum | Fail | Shared failing state; traced to this PR’s earlier synthetic policy pollution. New fixture teardown and owned-policy cleanup removed the clones. Final branch reports zero canonical policies rather than the earlier duplicate count; the existing live fixture requires one synced canonical policy. This environment is not configured for that existing lane. |
| 9 | local Medplum seeds 5001 patient answers, paginates reviews, and excludes ROS in the index | Fail | Also fails at base: synthetic server returns HTTP 429 at its request limit. Existing test unchanged. |
| 10 | update_patient MCP write tool integrates with Medplum | Fail | Also fails at base: synthetic server returns HTTP 429 at its request limit. Existing test unchanged. |
| 11 | profile validation accepts conformant v0.3 resources | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 12 | profile validation accepts standard Equivocal cup-disc interpretation | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 13 | profile validation rejects IOP with non-UCUM pressure unit | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 14 | profile validation rejects Observation missing bodySite reference extension | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 15 | profile validation rejects Observation missing encounter | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 16 | profile validation rejects axial length with non-mm UCUM code | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 17 | profile validation rejects comprehensive Encounter with non-AMB class | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 18 | profile validation rejects finished Encounter without period.end | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 19 | clinical MCP write tools default Provenance ON | Pass | Branch-only quota interference from the new live fixture; fixed by isolated-server configuration in ee6f1bb1. Passes in the final full run. |
| 20 | all direct fhir.search call sites are statically resolved or explicitly dynamic | Pass | Branch inventory and code: generated Consent entry/count; follows validated server next links instead of inventing an initial offset search. |
| 21 | static audit finds zero invalid search parameters | Pass | Branch inventory and code: generated Consent entry/count; follows validated server next links instead of inventing an initial offset search. |
| 22 | audit-only boundary AccessPolicy POST round-trip is accepted by Medplum when integration env is available | Fail | Also fails at base: privileged fixture requires ODOS_OPERATOR_PROJECT_ID. Existing test unchanged. |
| 23 | v0.5a audit-only boundary AccessPolicy enforces compartment isolation when bound via ProjectMembership (closes Mandate 8 fixture caveat) | Fail | Also fails at base: privileged fixture requires ODOS_OPERATOR_PROJECT_ID. Existing test unchanged. |

## Throttle-difference investigation

Both clean-base runs had the same eight failures. The first corrected branch run had nine additional HTTP 429 failures: eight profile-validation cases and the default-Provenance integration case. The affected test files and the common FHIR client were byte-identical to base. The profile cases share a single setup promise, so one failed StructureDefinition search makes all eight fail.

The base profile fixture took about twenty seconds to initialize; the shared-server branch fixture encountered the active FHIR rate limit immediately. The existing authentication helper retries login throttling, while ordinary FHIR requests report 429. The new live proof had added authentication traffic to that same server, affecting the timing of those independent quotas. This was not treated as an acceptable branch-only failure.

Commit `ee6f1bb1` moves the new proof to explicitly configured independent Medplum and Redis instances. It refuses the ordinary suite's server, including loopback hostname aliases. The ordinary suite still uses the original synthetic server and unchanged environment; the new matrix-only variables are unused by base code. Live policy proof remains enabled and executed, not skipped. Its isolated run passed 2/2 and left zero owned resources. Final full-suite result after isolation: 4,613 passed, 8 failed, 5 skipped, exit 1. The failure-name sets are identical to both clean-base runs: zero branch-only failures and zero base-only failures. All nine additional throttle failures are gone. No existing test, scanner, shared retry behavior, or rate-limit setting was changed.

## Review correction verification

The intermediate review run had eight additional profile-validation failures from one shared setup promise: a StructureDefinition search received HTTP 429 with 283 ms until quota reset. The clean base was rerun unchanged and again produced the same eight baseline failures. These captured summaries are retained: [intermediate branch](review-intermediate-summary.log), [base recheck](base-recheck-summary.log).

The four new ValueSets were moved from `data/profiles` into `data/terminology`, alongside their CodeSystems. The existing installer handles both directories. This removes eight additional search/create requests from the existing profile integration fixture without modifying that test, the installer, shared retry behavior, or rate limits. Local quota timing remains an environment limitation.

Final repeat after the terminology relocation: **4,638 total, 4,625 passed, 8 failed, 5 skipped, exit 1**. Failure-name sets match the fresh clean-base recheck exactly: zero branch-only and zero base-only failures. All eight profile cases pass. [Captured exact totals and failure list](review-final-summary.log). The intermediate failing result is retained rather than omitted.

## Fixback round 2

The F1 fix adds two API cases and enforces stale Patient If-Match rejection in the authorized fixture. Initial full branch run: 4,640 total, 4,618 passed, 17 failed, 5 skipped, exit 1; nine additional failures returned HTTP 429 while UI ran concurrently. A fresh clean-base run again produced 4,578 total, 4,565 passed, 8 failed, 5 skipped, exit 1. Sequentially rerunning unchanged branch code produced **4,640 total, 4,627 passed, 8 failed, 5 skipped, exit 1**. Exact failure-name sets match: **zero branch-only failures**. All existing API tests passed under the enforced fixture. [Full fixback command record and failure lists](fixback-2/README.md).
