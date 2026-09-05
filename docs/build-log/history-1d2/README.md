# History Slice 1d-2 author evidence

Base: `ac4dba80046988339e67d15ef3ce9f35585331a7`. Branch: `drbang-iva/history-slice-1d2`.
First caller checkpoint: `f9510b44`; the remaining callers follow in a separate commit.
This is author verification, not an independent evaluation. Final SHA and CI belong in the PR.

## What shipped behaviour does this change?

All ten former single-page guards in `mcp/src/clinical-graph/hpi-endpoint.ts` now call the existing `searchAll`.
Success response fields and reducers are unchanged. Limits below count collected resources, before reduction.

| Site | Previous page refusal | New read and ceiling |
|---|---:|---|
| 1. Record: current encounter answers | 500 | Full pagination, 1,000 rows |
| 2. Record: aggregate History reconciliation | 200 | Full pagination, 1,000 rows |
| 3. Record: patient last-plan ServiceRequests | 500 | Full pagination, explicit 5,000 rows |
| 4. Record: patient prior answers for follow-up and carry-forward | 500 | Full pagination, explicit 5,000 rows; encounter scope excluded by search token |
| 5. Record: current encounter review attestations | 20 | Full pagination, 1,000 rows |
| 6. Review: patient answers used for no-change attestation | 500 | Full pagination, explicit 5,000 rows; same encounter-scope exclusion |
| 7. Review: existing encounter attestation lookup | 20 | Full pagination, 1,000 rows |
| 8. Capture: aggregate upsert and duplicate reconciliation | 200 | Full pagination, 1,000 rows |
| 9. Answer upsert: existing encounter answers | 500 | Full pagination, 1,000 rows |
| 10. Answer upsert: encounter reviews to retire | 20 | Full pagination, 1,000 rows |

`DEFAULT_FHIR_SEARCH_MAX_ROWS` remains 1,000. `PATIENT_HISTORY_MAX_ROWS` explicitly configures the three patient-wide calls at 5,000. The shared helper now reports observed rows and pages on row overflow and bounds even empty-page streams with its existing page-limit error (optional `maxPages`, defaulting to the row ceiling). The three handlers return HTTP 409 with either limit error's message. Other unexpected errors still reach existing route handling.

Scope classification uses the existing Observation `category` token index, with ODOS-local `history-answer-scope` codings. `category:not=<scope-system>|encounter` excludes ROS before collection while retaining historical patient/complaint rows lacking category. No custom SearchParameter, schema migration, new medical code, or cache was introduced. Mandate 14 ledger row 59 records the primary-source agreement.

At this base, no encounter-scoped subject-section declaration has shipped; ROS is future slice 1d-4. Existing patient and complaint rows need no backfill. Manually imported/out-of-band encounter-scoped JSON rows lacking the new category cannot be excluded by the index; importers must preserve the builder's scope category. The existing defensive reducer still refuses to carry encounter scope.

Review identity and derivation remain encounter-scoped because 1d-3 has not landed. That slice must explicitly use the 5,000-row option when it introduces patient-wide review searches. This does not implement per-item review acts, ROS declarations, bulk gestures, or write-unit limits.

## Verification

Raw count summaries and all mutation BREAK/RESTORE output: [checks.txt](checks.txt).

- Starting new guards: 12 tests, 0 passed, 12 failed for the expected missing pagination/index/error behavior.
- Expanded pagination/helper guards: 24 tests, 24 passed, 0 failed.
- Untouched 1a/1b/1c MCP suites: 41 tests, 41 passed, 0 failed.
- Untouched History UI suite: 20 tests, 20 passed, 0 failed.
- Full MCP run: 4,178 tests; 4,133 passed, 0 failed, 45 skipped. Credentials were absent from this broad run; `ODOS_ALLOW_UNGATED_MCP=1` acknowledges skips and does not establish live authorization.
- TypeScript build: `npm --prefix mcp run build` exited 0.
- `git diff --check` exited 0. No manual next-link handling remains in the HPI endpoint.

Commands from the task root:

```sh
npm --prefix mcp test -- tests/hpiPagination.test.ts tests/fhirSearch.test.ts
npm --prefix mcp test -- tests/hpiEndpoint.test.ts tests/historyAnswerObservation.test.ts tests/historyTemplateEngine.test.ts
(cd ui && node --import tsx --test tests/hpiSection.test.tsx)
ODOS_ALLOW_UNGATED_MCP=1 ODOS_POSTGRES_URL=<local-synthetic-postgres-url> npm --prefix mcp test
npm --prefix mcp run build
rg -n 'found more|relation === "next"' mcp/src/clinical-graph/hpi-endpoint.ts
rg -c 'await searchAll|^[[:space:]]+searchAll|[?] searchAll' mcp/src/clinical-graph/hpi-endpoint.ts
```

## Mandate 17

| Deliberate break | BREAK | RESTORE |
|---|---|---|
| Return current-answer site to a single-page search + refusal | 1 test failed | 1 passed |
| Lower explicit patient ceiling to 1,000 | 1,001-row test failed | 1 passed |
| Remove both encounter-scope query exclusions | Cross-encounter ROS test failed | 1 passed |
| Replace counted limit response with generic message | 4 tests failed | 4 passed |
| Shift shared page limit by one (additional helper guard) | 1 test failed | 1 passed |

Every mutation was checked to be present, restored from the captured source, and rerun. No mutant remains.

## Live synthetic Medplum proof

The user's existing port 18103 stack remained running. Its default write quota rejected the initial large seed batch with 429 before read proof, so the successful run used a task-owned Medplum 5.1.8 stack at `http://localhost:18403/`, Postgres 15732, Redis 16679, and separate `odos_history_1d2_*` Docker volumes. `defaultFhirQuota=2000000` was local fixture configuration only. No shared server, policy, schema, or primary account setting was changed.

The regular search bootstrap passed 12/12, then `historyPaginationMedplum.test.ts` passed 1/1 against real persisted FHIR resources. Seeding used POST-only batches of 100, never large conditional updates. Caller authentication used the normal synthetic contract identity; endpoint dependencies injected that real FHIR client. This verifies handlers and real FHIR indexing/pagination, not a full browser or HTTP authentication walkthrough.

| Persisted data | Observed result |
|---|---|
| 600 patient answers | HTTP 200, 600 carried answers |
| 25 current-encounter reviews | HTTP 200, 25 derived attestations |
| 600 encounter-scoped ROS answers plus 600 patient answers | Indexed query returns only the 600 patient rows |
| 1,001 patient answers | HTTP 200, 1,001 carried answers |
| 5,000 patient answers | HTTP 200, 5,000 carried answers |
| 5,001 patient answers | HTTP 409: `FHIR Observation query exceeded 5000 rows; no partial result was returned. Read 5001 rows across 11 pages.` |

Reproduce with local synthetic `MEDPLUM_BASE_URL`, `MEDPLUM_ADMIN_EMAIL`, `MEDPLUM_ADMIN_PASSWORD`, `MEDPLUM_CONTRACT_BOOTSTRAP=1`, and a seeding quota sufficient for 5,600+ creates:

```sh
npm --prefix mcp test -- --bootstrap-project tests/searchParamMedplumSmoke.test.ts tests/historyPaginationMedplum.test.ts
```

## Handoff boundaries

- No new product decision: implements accepted rescope section 1d-2 and the attached correction. The existing companion decision/index were read, not edited.
- Slice 1d-1 / PR #530 changes the same endpoint's write logic in its separate branch. The later merge must preserve both slices, rerun their guards, and obtain evaluation at that resulting head.
- This PR does not deploy or merge. Independent Fable/Opus evaluation is required at the final head. No evaluated label or self-authored verdict marker.
