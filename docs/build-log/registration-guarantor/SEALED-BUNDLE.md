# Registration guarantor DOB and practice age of majority

Status: locally implemented and reverified; NOT EVALUATED. Published as PR #607. Rebased onto merged sibling #606, preserving its RelatedPerson claim fence and K4 editor guard. Final remote CI and bot gates are pending. No merge or Iris write.

Branch: `drbang-iva/registration-guarantor-dob-age-majority`.
Initial base: `6d41a717060fe7d01a185496279ee67f47e82fa5`. Refreshed base: `40c19a9e442015e1d32396958b661394318713d2` (#606 merged). Only rebase conflict was appended editor tests; both K4 and D4 retained. The claim writeConstraint remains intact.
Rebased source tested: `befd48ef2888acf796ad82be7091b09f2b9a17b7`. Final production change: `5f244a9c` corrects the seed client type to declare existing baseUrl/searchUrl pagination requirements; no runtime change. Evidence commits follow. Final publication SHA is recorded in PR #607 and the delivery message.

## Summary and files

- New guarantor DOB is required in registration and create, optional in the chart editor, displayed on both search surfaces, and stored only on Person. Demographic projection, owned hash, and child DOB writes are unchanged.
- Strict coded Basic setting, ageOfMajorityYears 16–21, supplies one shared resolver to registration, statements, and UI. Absent, invalid, or duplicate settings refuse explicitly. Settings UI uses versioned updates and conditional creation.
- MRN backfill was a downstream caller of the UI helper. It now loads the same setting before writes; no implicit age value was retained.
- Seed is idempotent, named-project scoped, and dry-run by default. Existing valid settings remain unchanged.

Main files: `mcp/src/clinic/{age-of-majority-config,patient-registration-endpoint,guarantor-search}.ts`, `mcp/src/statements/statements.ts`, `mcp/src/authz/roles.ts`; `ui/src/lib/{age-of-majority,patient-identity,patient-registration,guarantor-editor,guarantor-link-operations}.ts`; registration, guarantor editor/search, Engage and age-setting UI components; `scripts/{seed-age-of-majority,backfill-patient-mrns}.ts`; registry and Mandate 14 ledger. Tests and exact-output evidence accompany these files. Use `git diff --name-only origin/main` for the full inventory.

## D1–D9: green / mutation red / restored

| Guard | Result and exact evidence |
|---|---|
| D1 registration DOB required | 1 pass / 1 fail / 1 pass, `../registration-guarantor-dob/D1-*.tap` |
| D2 create DOB required | 1 pass / 1 fail / 1 pass, `../registration-guarantor-dob/D2-*.tap` |
| D3 no child DOB projection | 1 pass / 1 fail / 1 pass, `../registration-guarantor-dob/D3-*.tap`; writer-derived two-child history, both DOBs preserved; census suspectedOverwrites=0 |
| D4 editor Person DOB save | 1 pass / 1 fail / 1 pass, `../registration-guarantor-dob/D4-*.tap` |
| D5 card DOB/blank | 1 pass / 1 fail / 1 pass, `../registration-guarantor-dob/D5-*.tap` |
| D6 configured 21 | Server 70/70 green; separate registration and statement age-18 mutants each fail; restored 70/70 (`D6-*-red.txt`, `d6-d7-restored.txt`). Engage mutation fails; restored UI guards pass (`../registration-majority-ui/`) |
| D7 missing setting | Separate server fallback mutants each fail; restored 70/70. UI fallback and duplicate-singleton mutations fail; combined restored UI guards/settings/index 8/8 |
| D8 registry enforcement | Registry deletion: 1 failure; restored config/seed suite 16/16, `../registration-majority/d8-red.txt`, `d8-d9-restored.txt` |
| D9 dry-run writes nothing | Forced write: 1 failure; restored 16/16, `../registration-majority/d9-red.txt`, `d8-d9-restored.txt` |

MRN backfill: 20/20; separate setting-21 and missing-setting guards green/red/restored in `../registration-guarantor-dob/backfill/`.

## RBAC and live authorization

New `Basic` rules are scoped to `age-of-majority-config|odos-age-of-majority-config`: Provider read/search; Staff and Admin read/search/create/update, matching scheduling config. No delete grant.

Live Medplum role proof: 4 tests, 4 passed, 0 failed, 0 skipped (`../registration-majority/local-authz-live.txt`). Provider create/update both 403; Staff/Admin create 201 and update 200; all three read/search 200. The initial local setup failed on disposable-client creation permissions; the successful run used a separate synthetic bootstrap project and cleaned all its temporary resources. This is author-side proof, not independent evaluation or the required CI lane.

## Contract live proof

`live-result.json`, `live-http.json.gz`, `live-final-resources.json`, and screenshots record successful actual UI/FHIR behavior:

1. Seed 18; register minor and nineteen-year-old with new guardian DOB.
2. Person carries guardian DOB; child RelatedPerson has no projected DOB.
3. Actual settings page saves 21 with If-Match. Actual EncounterCharting Engage tab selects the nineteen-year-old's guardian. Statement generation selects the same guardian.
4. Delete setting: registration 422 names ageOfMajorityYears; Engage visibly reports not configured and exposes no recipient list.

The harness uses real clinic, guarantor and communications routes, default education catalog, real Medplum resources, and actual app routes. Ancillary clinical-graph endpoints are outside the fixture and visibly unavailable. No education is dispatched. Earlier `live-failure.*` and preliminary logs preserve harness diagnosis; `live-result.json` is the successful result.

Fixture: `registration-majority-live`, loopback Medplum 29160, PostgreSQL 29161, Redis 29162, temporary Vite 29164. Reproduction wrapper: `node --import tsx docs/build-log/registration-guarantor/fixture.mjs <up|seed|sync|audit-smoke|stop>`; proof: `node --import tsx docs/build-log/registration-guarantor/live-proof.mjs`. Credentials remain only in gitignored `.odos/registration-majority-live/`.

All three fixture containers were stopped, not removed; `fixture-stopped.txt` records each as exited. Their volume and network remain available.

## Regression and build

- Full MCP, owned PostgreSQL fixture: 5,076 tests; **5,024 passed, 0 failed, 52 skipped**. Command: `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test`, with ODOS_POSTGRES_URL injected from the private fixture. Exact output: `mcp-full-restored.txt.gz`. Skipped credentialed lanes are explicitly not an authz gate.
- Full UI from `ui/`: **1,566 passed, 0 failed, 0 skipped**, `npm test`, `ui-full-final.txt.gz`.
- Merged targeted registration/statements/census/guarantor tests: **114/114**, `merged-focused.txt`; final phone recovery **11/11**, `phone-recovery-restored.txt`.
- MCP build, UI build and script typecheck: exit 0, respective `*-build-final.txt` logs.
- Preflight: **0 warnings, 0 hard blocks**, `preflight-final.txt`.
- `.gz` files preserve output with workstation paths normalized and can be read with `gzip -dc FILE`.

## Mandate 14 and follow-ups

Only the approved South Carolina value 18 is seeded. Both primary sources were accessed 2026-09-15 and agree: [S.C. Code §15-1-320(a)](https://www.scstatehouse.gov/code/t15c001.php) and [S.C. Constitution art. XVII §14](https://www.scstatehouse.gov/scconstitution/A17.pdf). Ledger: `data/code-bindings/age-of-majority-ledger.md`. No new medical code values. No new design decision or PerformanceOD INDEX change; implementation follows the existing kickoff.

Remaining gates: coordinating task publishes the verified rebased head to PR #607 and reports final-head CI including live authorization, CodeRabbit commit status, PR-Agent check-run, and zero unresolved threads; separate Claude Opus evaluation. Do not post an Evaluated-by marker from this author session. Retain NOT EVALUATED in PR body.

## Rebase verification

All mutations ran in isolated worktrees, separate from full regressions. D1–D5 each green 1 / red 1 failure / restored 1, with restored editor 11/11 including both K4 and D4 (`../registration-guarantor-dob/rebased/`). D6/D7 server combined suite 71/71 green and restored; four individual mutants each fail (`*-rebased-red.txt`). UI D6, D7 fallback, and duplicate-singleton mutants each fail; restored guards 8/8 (`../registration-majority-ui/rebase/`). D8/D9 each red 1 failure, 16/16 green/restored (`../registration-majority/rebase/`). Local live authz repeated: 4/4, zero skipped; scoped Provider denial and Staff/Admin grants proved alongside the merged policy rules.

Live walkthrough repeated successfully with current policies (`live-rebased.txt`, refreshed request trace/final resources/screenshots). MCP rebase regression: 5,077 tests, 5,025 passed, 52 skipped, zero failures. Script typecheck initially found the seed client declaration missing baseUrl/searchUrl; corrected typecheck and seed/config suite4/4 pass. The first full UI run encountered educationSequenceReview browser timeouts; that unchanged file passes6/6 in isolation. Full restored UI rerun: **1,567 passed, 0 failed, 0 skipped**, exit0, `ui-rebased-restored.txt.gz` (187645.420042ms). No production or test change was needed for the browser timeout. The first run’s exact output is retained in `ui-rebased.txt.gz` (1,561 passed, 6 failed).

Rebased fixture shutdown verified all three containers exited; containers and volumes were not removed (`fixture-stopped-rebased.txt`).

Latest accepted local regression: MCP **5,025 passed / 52 skipped / 0 failed**; UI **1,567 passed / 0 skipped / 0 failed**. Builds and preflight pass. Earlier counts above describe the pre-rebase proof and are preserved for provenance.

## Bot adjudication

Workstation paths in this PR’s text and compressed artifacts are normalized to `<workspace>` or `<home>`; assertions, counts, status codes and other output remain intact. Thus logs are exact except for this disclosed path normalization.

Raw authorized FHIR clients can create duplicate coded Basic resources if they bypass conditional creation. This is the existing practice-config convention, not a storage uniqueness constraint. C3 explicitly requires the existing singleton pattern and matching write grants. The UI and seed use atomic conditional creation; duplicate readers refuse explicitly. The proposed new privileged creation operation and removal of Staff/Admin create grants were not applied because they change the approved contract.

### Bounded bot fixes after the rebased proof

Editor runtime validation now refuses malformed, impossible and future nonblank DOBs before any Person write; today, absent legacy DOB, and explicit clearing remain allowed under C1/R1. Writer-derived JSON guards: 2/2; initial2 failures; deleted validation mutant1 failure; forced-required mutant1 failure; each restored2/2. Focused MCP62/62 and UI52/52; UI typecheck passes. Evidence: `../registration-guarantor-dob/editor-validation/`. Person-only projection and existing claim fence remain unchanged.

The age test uses a valid January1 birth date19 years before the mocked current year. The full6-test age suite passes at a leap-day clock and an ordinary clock; restoring the old fixture fails with the impossible non-leap birth date; restored6/6. Evidence: `../registration-majority-ui/leap-day/`.

The full local regression counts above precede these bounded fixes. Final-head full CI regression and live-authorization results are required and will be attached to PR607 by the coordinating task. No fixture restart was needed for these UI validation/test and evidence-only changes.

Integrated fixback checks: **58/58 UI**, UI production build exit0, preflight0 warnings0 hard blocks (`fixback-ui-integrated.txt`, `fixback-ui-build.txt`, `fixback-preflight.txt`).

### Scope-marker and evidence correction

The actual statements age-setting query now carries its exact `fhir-scope-contract`. The guard runs the real source plus the real search helper through the preflight scanner and proves unrelated Basic grants cannot satisfy it. Guard1/1 green; deleting the marker1 failure; restored config/statements suites **40/40**. No query or role behavior changed. `scope-marker-*.txt` records the proof and refreshed preflight.

`scripts-build-final.txt` was incorrectly named while retaining pre-fix TS2345 output. It now contains the successful current `npm run typecheck:scripts` run. The earlier failure remains explicitly preserved in `scripts-build-rebased.txt`; final script typecheck is exit0.

### Registration search-card display guard

The existing registration attach test now uses a JSON-round-tripped card returned by the actual search handler from a Person produced by the actual registration writer. It asserts DOB on both the candidate card and the selected existing-guarantor summary. Suite3/3 green; separately deleting either DOB render produces1 failure; restored3/3; UI typecheck exit0. Evidence: `card-dob-*.txt`. No production changes.

### CI cleanup failure reproduced and corrected

Final-at-that-time CI at `af7d08a0` passed full MCP (5,029 passed / 51 skipped), credentialed integration (218 passed), and UI (1,567 passed), but live authorization failed56 passed /1 failed: all three new role assertions passed and cleanup of their memberships returned403. The earlier bootstrap-project local proof masked this permission boundary.

A fresh ordinary synthetic project reproduced it using the actual CI operator membership contract: distinct non-admin ClientApplication, no access policy, versus caller human project administrator. Original test3 passed /1 failed with three membership-delete403 responses. Corrected test4 passed /0 failed /0 skipped: identity metadata cleanup uses caller admin; Basic cleanup uses the operator; both groups are attempted and cleanup failures still reject. No production policy changes. Exact evidence and fixture limitations: `../registration-majority/cleanup/verification.md` and `nonadmin-operator-*.txt`.

All temporary proof resources were cleaned. All three task fixture containers are again stopped, not removed (`fixture-stopped-final.txt`). A new final-head CI run is required; the earlier failed lane is not represented as green.
