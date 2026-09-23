# Open charts S0 Abandon safety — sealed bundle

**Status:** needs-review. **Base:** `18932ecd53463987172f07b768aa9717fa48c671`. **Branch:** `drbang-iva/open-charts-s0-abandon-safety`. **PR:** #662. **Author:** Codex. **Independent evaluation:** NEEDS-WORK at `e73a0130`; the fixback head requires a new Claude Opus 5.5 verdict before merge.

An unfinished visit with no clinical content or charge can be abandoned through a server endpoint after confirmation. Signed, closed, migrated and content-bearing visits refuse with no write. The Provider Encounter policy now keeps a signed visit `finished` under raw FHIR writes; unsigned raw cancellation remains possible by design. A confirmed UI abandon no longer disappears when Sign's completeness counter changes; switching encounters during confirmation shows a message and sends no old request.

## Files and scope

- Server: `mcp/src/clinical-graph/encounter-abandon-endpoint.ts`, `encounter-abandon-routes.ts`; one import and one registration in `mcp/src/index.ts`; Provider Encounter rule only in `mcp/src/authz/roles.ts`; one transaction exclusion in `mcp/tests/fixtures/r10/finding-write-exclusions.json`.
- UI: `ui/src/lib/encounter-abandon.ts`; abandon path only in `ui/src/components/charting/EncounterHeader.tsx`.
- Tests: new `mcp/tests/encounterAbandon.test.ts`, `encounterAbandonAuthzLive.test.ts`, `ui/tests/encounterAbandon.test.tsx`; A9 plus the R3 composite assertion in `mcp/tests/threeRoleModel.test.ts`; one census in `ui/tests/clinicalGraphRouting.test.tsx`.
- R3 grant scanner correction: nine `line:` values only in `scripts/fhir-read-grant-check.ts`. No source call-site exception was added or removed there.
- Evidence: this directory. No new design decision or Mandate 14 medical-code artifact; `decisions/INDEX.md` and the medical-code ledger are unchanged.

## P1–P7

P1: the former client-side cancelled writer was identified; Start-exam and finish writers remain. P2: live checked-in Appointment → actual Start-exam helper yields an `in-progress` Encounter and zero blocking dependencies across all 16 kinds. P3: void endpoint pattern, closed gate, migration predicate and route wiring verified. P4: Staff unfinished-only Encounter write, Provider rule and practice Basic reads verified. P5: section-content helper is narrower than the abandonment dependency contract and was not reused. P6: the original sweep missed an Admin+Provider composite assertion; R3 replaced exactly that assertion with the new constraint and behavioral checks. P7: finding-write registry rejects missing and stale entries; deletion mutation went red. The old P6 claim in the historical preflight report is superseded.

## Verification

| Command | Base `18932ecd` | Final patch |
|---|---|---|
| `cd ui && npm test` | 1865 tests; 1865 pass; 0 fail; 0 skipped | 1869 tests; 1869 pass; 0 fail; 0 skipped |
| CI direct MCP Node runner with dedicated S0 Postgres and `ODOS_POSTGRES_URL` | 6369 tests; 6314 pass; 0 fail; 55 skipped | 6419 tests; 6362 pass; 0 fail; 57 skipped |
| Root, MCP, UI `npx tsc --noEmit` (UI `--skipLibCheck`) | each exit 0 | each exit 0 |
| `npm run preflight` | 0 warnings; 0 hard blocks; exit 0 | 0 warnings; 0 hard blocks; exit 0 |
| `cd ui && npm run build` | not run | exit 0; 341 modules transformed |
| `git diff --check` | — | exit 0 |

The direct MCP command is recorded in `preflight-blocked.md`. Both live authorization tests are skipped in the full unit run and explicitly enabled below. The operator env and identity files were absent during all unit suites. Preflight initially overlapped the scanner test's temporary injected source mutation and saw a provisional `RiskAssessment`; after the MCP suite restored its source, preflight was rerun alone and passed. No product code was changed for that overlap. After opening PR #662, CodeQL flagged the new abandon write route for missing rate limiting. The route now uses the same 120-per-minute `express-rate-limit` pattern as nearby clinical writes. The new HTTP guard failed with the middleware removed (121st request 401 instead of 429) and passed after restoration (1 red, 1 green). The table's final MCP and UI counts, typechecks, build and preflight are from this amended source.

## Independent-evaluation fixback

The evaluation at `e73a0130` found three narrow defects. A6 now uses a real-shape `finished` migrated Encounter, and the migrated check precedes signed/closed; reversing that order made A6 fail 1/1, while restoration passed 1/1. The retracted Condition fixture now uses only `verificationStatus` and no invalid `status`; removing the Condition-specific branch made its test fail 1/1 (409 instead of 200), while restoration passed 1/1. The route now logs the server error through `options.log ?? console.error`, returns the same safe 502 body, and does not send after headers are sent; removing the log call made the new route guard fail 1/1, while restoration passed 1/1. The complete endpoint test file passed 47/47. The three red/green outputs are in [the mutation table](mutations.md).

After these edits, the direct MCP suite passed 6362/6419 with 57 skips, UI passed 1869/1869, three typechecks exited 0, preflight reported 0 warnings and 0 hard blocks, and UI build exited 0 with 341 modules transformed. The MCP suite used a dedicated `odos-s0abandon-fixback` Postgres container with `ODOS_POSTGRES_URL`; the operator files were absent for both unit suites, then restored. No new files or changes outside §4 were made.

## A1–A13 and live proof

[Mutation table](mutations.md) records red and green counts for A1–A11, all 16 A2 dependency kinds, R3's three corrected guards, and A13's two UI branches. A13 restored silent counter exit: 1 fail → 1 pass; removed encounter-change guard: 1 fail → 1 pass. The A8 mutant on a fresh R5 policy installation removed the Provider constraint; signed raw PATCH returned **200** where the test expected **403**, producing 1 fail / 0 pass / 0 skipped. Source was restored after the mutant test. A fresh R6 policy installation with the restored source made A8 green: 1 pass / 0 fail / 0 skipped. A12 is a live Start-exam path check, rather than a source guard with a specified mutation; its actual request and readback passed.

Fresh R4b live lane on `http://localhost:18103/`: health attempt 15/90 at two-second intervals; server baseUrl byte-identical to MEDPLUM_BASE_URL. Smoke 12/12, integration 218/218, authorization 78/78, all zero fail/skips; repair and policy sync exit 0 (`GITHUB_ACTIONS=true` only for repair). Staff and Provider evidence callers each had one role; synthetic admin and service clients served setup/inspection. A8 signed Provider raw PATCH refused 403 with `finished` readback; unsigned Provider raw PATCH succeeded 200 with `cancelled` readback (1 pass). A12 actual Start-exam empty visit abandoned 200 with `cancelled`/`abandoned` readback and caller Provenance; an Observation visit refused 409 with unchanged Encounter and `Observation:1`; signed endpoint refused 409 with unchanged Encounter (1 pass). R5 mutant lane: smoke 12/12, integration 218/218, authorization 78/78, P2 passed before the deliberate A8 red. R6 restored lane: integration 218/218, authorization 78/78, repair and sync exit 0, P2 passed, A8 passed 1/1; no failures or skips. R6's disposable containers were stopped after the green test.

Controlled browser on the actual chart route, Provider-only synthetic session: confirmation showed the exact warning and zero requests before acceptance. On a finding-bearing visit, exactly one POST `/abandon` was recorded at 1,521 ms and one 409 response at 1,719 ms with `encounter-has-content`; “findings (1)” and remove-or-sign guidance rendered. [Confirmation](confirmation.png) and [409 message](content-refusal.png) screenshots are from the actual route. [Signed disabled control](signed-disabled.png) is from a synthetic browser fixture mounting the actual `EncounterHeader`; the full chart page was blocked by local Medplum 429s at `/desk/whoami` after the previous browser proof. The signed refusal itself was proven live by A8 and A12. The chart screenshots include ancillary synthetic-data and service errors (missing patient birth date, unrelated reads); they do not affect the recorded abandon response.

## Harness corrections and limits

R2 supplied valid synthetic Appointment start/end and corrected the UI Start-exam adapter/source and FHIR search keys. R3 supplied the baseline synthetic admin credentials to the A8 runner, then switched its route-auth service client after a same-query control showed seeder 403 and caller 200; no A8 product request ran in those failed setup attempts. R4 moved stale prior-project operator state aside before the fresh R4b lane. The browser readiness check now waits for the loaded Encounter header; the failed full-chart attempts occurred before an S0 request under Medplum's 429 limit. The final 409 proof used one page after reset. The R5 wrapper's postcheck expected generic assertion text, while the captured test correctly reported `AssertionError: 200 !== 403`; no second mutant request was needed.

The dependency check and transaction are not atomic against another writer. Independent evaluation accepted this stated §0.5 row 7 limit for S0 and assigned it to slice D's reopening work. The practice-wide Basic scan can fail closed on an unrelated malformed row; the kickoff prescribed `ProtocolBasicStore.list()`, and per-row recovery needs a `protocol-store.ts` change outside §4. Failures are now logged server-side. The default-IP limiter can share a bucket behind the Caddy front door; no `trust proxy` setting exists on main, and the other three limiters share this app-wide condition. This slice does not add role-specific reasons, a second audit event beyond Provenance, reopening, board entry points, raw unsigned FHIR cancellation blocking, or PR #661 claim-evidence work. A merged Provider constraint needs a separate break-glass Iris policy sync before it is live there. No Iris sync or merge was performed. PR-Agent's review job failed and posted no findings; do not count it as a review.

Open PR #647 also updates `mcp/src/index.ts` and the grant scanner's line-reference entries. Its additions are separate from S0's route lines, but the second PR to rebase must keep both additions and recompute scanner references on the combined index. Neither #647 branch nor its files were changed here.

## Cleanup

After the fixback full suites, `docker ps --format '{{.Names}}'` listed only `vf-prac1b-walk-db`, which this task did not touch. The dedicated S0 Postgres was stopped and operator files restored. The root checkout and PR #647's branch were untouched. Local R4b, R5 and R6 volumes were retained; no destructive cleanup was run.
