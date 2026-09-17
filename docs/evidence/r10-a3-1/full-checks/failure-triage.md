# Full-check failure triage

**BLOCKED; NOT EVALUATED.** The full MCP run is red: **6,037 tests, 5,911 pass, 121 fail, 5 skip, 0 TODO**. The UI run is also red: **1,685 tests, 1,673 pass, 8 fail, 0 skip, 4 TODO**. The §4 inventory-file boundary stops repair, but it is **not the only remaining failure**. Successful focused R10 checks do not replace these full-run results.

This is log-only triage of [MCP failures](mcp-failures.json), [MCP raw output](mcp-test.txt), and [UI failures](ui-failures.json). No failure is labeled pre-existing: no base-head comparison was executed. “Fixture” and “setup” classifications identify observed dependencies or likely follow-up lanes, not permission to weaken assertions or evidence that source is correct. No fix or rerun was performed for this report.

## All MCP failures by test source

| Test source | Failures | Triage lane | Recorded cause / limit |
|---|---:|---|---|
| `tests/preflight/fhir-read-grant-check.test.ts` | 6 | Scope-external inventory | Exact service-write exclusion no longer matches `mcp/src/index.ts:3251 fhir.create VisionPrescription`; subsequent CLI assertions receive empty expected output. The inventory lives in `scripts/fhir-read-grant-check.ts`, outside §4. This is the stopping boundary, not the only failure. |
| `tests/preflight/preflight-lint.test.ts` | 1 | Source issue | `diagnosis-carry-provenance.ts:20–21` fails `odos-extension-url-shape`; lint returns hard-block rather than pass. |
| `tests/setup-wizard/migrate-three-role-model.test.ts` | 3 | Disposable setup interference | Derived `.odos/operator.env` identifies the disposable project while fixtures expect `practice-1`, preventing the intended CLI assertions. |
| `tests/setup-wizard/seed-demo.test.ts` | 1 | Disposable setup interference | Same derived operator-project mismatch prevents the intended seed CLI assertion. |
| `tests/setup-wizard/smart-app-registry-adapter.test.ts` | 2 | Disposable setup interference | Explicit fixture project `practice-target` conflicts with configured disposable `MEDPLUM_PROJECT_ID`; refusal precedes intended test behavior. |
| `tests/setup-wizard/sync-practice-role-policy-rules.test.ts` | 3 | Disposable setup interference | Derived operator-project mismatch precedes expected AccessPolicy read, foreign-project policy and non-local URL refusals. |
| `mcp/src/__tests__/plan-carried.test.ts` | 12 | Fixture/behavior compatibility unresolved | All 12 report `Not found` before intended carried apply/unapply/undo/rollback assertions; logs alone do not establish which resource or whether production behavior is correct. |
| `mcp/src/__tests__/plan-glaucoma-integration.test.ts` | 5 | Fixture/behavior compatibility unresolved | All five report `Not found` across shared-order/charge and seed/apply scenarios. |
| `mcp/src/__tests__/plan-materialization.test.ts` | 2 | Fixture/behavior compatibility unresolved | Both materialization/education projections report `Not found`. |
| `mcp/src/__tests__/plan-offered.test.ts` | 3 | Fixture/behavior compatibility unresolved | All three offered/unoffered series/charge scenarios report `Not found`. |
| `mcp/src/__tests__/protocol-phase5.test.ts` | 21 | Fixture/behavior compatibility unresolved | 20 fail missing synthetic Encounter (`enc-1`/`enc-unapply`); one capture control fails `Condition search returned a resource outside the requested patient/encounter scope.` Likely fixture assumptions conflict with new validation, but fixture-only repair is not proven. |
| `mcp/tests/ageOfMajorityAuthzLive.test.ts` | 1 | Disposable live setup incomplete | Synthetic Patient lookup yields no id; `assert.ok(patient?.id)` fails. |
| `mcp/tests/clinicalWriteAuthzLive.test.ts` | 1 | Disposable live setup incomplete | Explicit error: synthetic Patient from contract-smoke seeding is required. |
| `mcp/tests/currentFindingIdentity.test.ts` | 4 | Identity/audit fixture expectations unresolved | Panel expected `panel-context` but classified `invalid`; compiled identity snapshot differs; two audit-coverage expectations omit resources now returned as pending. Must reconcile against contract, not simply update snapshots. |
| `mcp/tests/encounterUndoLedgerAuthzLive.test.ts` | 1 | Disposable live setup incomplete | Explicit error: synthetic Patient from contract-smoke seeding is required. |
| `mcp/tests/findingSectionHelpers.test.ts` | 36 | Outdated fixture transport candidate | All 36 history snapshot cases report `Ocular Health requires the finding read transport.` Fixtures do not supply the required transport; no corrected rerun or base comparison establishes the full fix. |
| `mcp/tests/historyPaginationMedplum.test.ts` | 1 | Disposable runtime throttling | Bulk answer seeding receives HTTP 429 Too Many Requests, consumedPoints 50059 versus limit 50000. Pagination assertion cannot complete. |
| `mcp/tests/profile-validation.test.ts` | 6 | Disposable validation setup/behavior unresolved | Six negative tests return `Missing expected rejection` for invalid Observation/Encounter shapes. Installed profile enforcement must be checked; logs do not prove this is only setup. |
| `mcp/tests/r10-parity.test.ts` | 9 | Outdated snapshot/behavior expectations unresolved | Eight legacy projection fixtures differ (including new `creditsCompleteness: false`); aggregate E1–E17 premise replay exits nonzero. Contract reconciliation and exact assertion mapping remain necessary. |
| `mcp/tests/searchParamContract.test.ts` | 3 | Source/static contract issue | `diagnosis-carry-provenance.ts:40` has unresolved search parameters without a search-contract marker; same error also masks the intended mistyped-override control. |

**Total: 121 failures across 20 test files.** The JSON retains every individual test name, location and diagnostic.

## UI failures and deferred slots

| Test source | Failures | Actual mismatch |
|---|---:|---|
| `ui/tests/customSections.test.tsx` | 2 | Deferred/recorded boundary and fresh-history suggestion cases expect 200 but receive 400 invalid from capture. |
| `ui/tests/encounterVoid.test.tsx` | 2 | Dilation and whole-visit consumer results omit the expected `voidActionId`. |
| `ui/tests/examOverviewBoard.test.tsx` | 3 | Other-only normal/abnormal and schema-blind component writer cases expect 200 but receive 400 invalid. |
| `ui/tests/ocularSweepValueOnly.test.tsx` | 1 | Real-seed Anterior All Normal posts requests rejected by the real capture handler. |

The six Ocular Health cases expose legacy payload/consumer incompatibility with the server contract; the other two expose void-result consumer incompatibility. UI files are outside A3.1 scope and unchanged, but these failures remain actual integration failures, not waived passes. Four separate release TODOs are T15 canonical picker view without one Observation id; T16 evidence through finding homes; T17 fact-target linking; T18 Assessment origin through home sources. They belong to the held A3.2 work and are not included in the eight failures.

## Five MCP skips

- live scoped-clinician exam-start RBAC matrix # SKIP ODOS_TEST_CLINICIAN_TOKEN, ODOS_TEST_OTHER_CLINICIAN_TOKEN, and ODOS_TEST_PATIENT_ID are required for the operator-assisted live RBAC gate.
- isolated Medplum enforces Consent grants and immutable evidence # SKIP Dedicated synthetic matrix live lane only
- isolated evidence HTTP route enforces generated staff Consent grant # SKIP Dedicated synthetic matrix live lane only
- isolated synthetic Medplum enforces scheduled enrollment conditional writes # SKIP
- installed WeasyPrint 69.0 emits a real PDF/A-3u document # SKIP

The last two raw skip annotations have no reason text; this report does not infer one. Skips are unexecuted coverage, not successes.

## Remaining work boundary

Repair requires explicit resolution of the scope-external write-inventory file before continuing. In addition, source lint/search-contract failures, changed-reader/protocol fixture and behavior mismatches, disposable setup/runtime failures, and UI integration failures all remain to be resolved or separately adjudicated with evidence. The full live lane result is recorded below. No claim of PR readiness, full-suite green, or independent evaluation follows from this triage.

## Full live lane and focused release checks

[Full live-authz output](live-authz.txt): **73 tests, 72 pass, 1 fail, 0 skip/TODO**. The enclosing `clinicalWriteAuthzLive` test fails during cleanup: three `ProjectMembership` DELETE requests return 403; its 25 child checks pass. This is a real failed lane with incomplete cleanup, not a successful full authorization run. The new A3 suite passes 4/4 within that lane. No base comparison establishes whether the cleanup failure is pre-existing.

The parent run also reports fresh release scenarios 16/16 and census 97 sites / 30 mapped / 67 excluded. Those focused checks do not erase the 121 MCP failures, eight UI failures, or one live-lane failure. **Final posture: BLOCKED, NOT EVALUATED; no reruns or fixes represented by this triage.**
