# Registration guarantor DOB and practice age of majority

Status: locally implemented and verified; NOT EVALUATED. PR publication is pending operator coordination with overlapping PR #606. CI and bot review have not run for this branch. No merge or Iris write.

Branch: `drbang-iva/registration-guarantor-dob-age-majority`.
Base verified by task-worktree fetch: `6d41a717060fe7d01a185496279ee67f47e82fa5` (no anchor drift).
Implementation and integrated evidence commit: `72faa970` (subsequent bundle/fixture documentation commit only).

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
- `.gz` files preserve exact original output and can be read with `gzip -dc FILE`.

## Mandate 14 and follow-ups

Only the approved South Carolina value 18 is seeded. Both primary sources were accessed 2026-09-15 and agree: [S.C. Code §15-1-320(a)](https://www.scstatehouse.gov/code/t15c001.php) and [S.C. Constitution art. XVII §14](https://www.scstatehouse.gov/scconstitution/A17.pdf). Ledger: `data/code-bindings/age-of-majority-ledger.md`. No new medical code values. No new design decision or PerformanceOD INDEX change; implementation follows the existing kickoff.

Remaining gates: operator coordination for PR #606 (overlap in roles.ts and guarantorEditor.test.tsx); open requested PR; final-head CI including blocking live authorization; final-head CodeRabbit commit status and PR-Agent check-run; zero unresolved threads; separate Claude Opus evaluation. Do not post an Evaluated-by marker from this author session. Retain NOT EVALUATED in PR body.
