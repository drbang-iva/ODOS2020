# DEFER-1 author evidence

Base: `9a3be2d11425bdb88dc48876a52daf1e290ff7a5` (freshly fetched `origin/main`). Branch: `drbang-iva/defer-dilation`.

## Change

The seed permits deferral only for `entrance:dilation`. `stateDefinition()` omits the flag; there is no opt-in parameter because none of its callers should opt in. EOM and palpebral conjunctiva lose their grants. EntranceStateSection gates only the Deferred button, retaining the existing Normal/Abnormal markup and styling. The runtime normal-template mutation refuses a true grant on any non-dilation definition. Dilation is narrowly exempted from the existing ocular-health-only template-type check so the required dilation acceptance case actually succeeds. The catalog projection remains unchanged.

Production files: `mcp/src/clinical-graph/entrance-definition.ts`, `ocular-health-definition.ts`, `finding-definition-endpoint.ts`, and `ui/src/components/charting/EntranceStateSection.tsx`.
Tests: `mcp/tests/findingDefinitionStore.test.ts`, `customSectionEndpoint.test.ts`, `ui/tests/entranceBattery.test.tsx`, `examOverviewBoard.test.tsx`. Old tests expecting successful non-dilation deferral were adjusted to the ruling; historical deferred-display coverage elsewhere remains.

## Persisted-data census

Read-only SQL against local Docker container `odos-history-1d5-postgres-1`, database `medplum`. No writes, migrations, backfills, or reclassification. Exact query: [census.sql](census.sql); output: [census.log](census.log).

```text
active_observations|6144
observations_with_EXAM_STATE|0
deferred_observations_all_definitions|0
impossible_state_negative_control|0
synthetic_deferred_positive_control|1
synthetic_impossible_negative_control|0
```

SQL exited 0. Zero deferred records across every definition also means zero on the six definitions losing permission (the kickoff says five in one paragraph but lists six). This database has no persisted EXAM_STATE positive control; the positive control is an in-query synthetic row and never writes to storage. This is not a reproduction of the operator's separate deployed 72-row census. A separate read-only query found zero stored finding-definition JSON Basic resources in this database.

## Mandate 17

Each mutation changed production code, ran its focused regression, restored the original bytes in a finally block, and reran the same regression. Each RED has one failed test; each GREEN has one passed test. Full verbatim TAP output is attached for every run.

| Guard | Mutation | RED | GREEN |
|---|---|---|---|
| 1: dilation permits deferral | Remove dilation flag | [exit 1](guard-1-red.log) | [exit 0](guard-1-green.log) |
| 2: exactly dilation across complete seed | Inject a new `future:defer-probe` definition granting deferral | [exit 1](guard-2-red.log) | [exit 0](guard-2-green.log) |
| 3: factory default | Restore `allowDeferred: true` inside stateDefinition | [exit 1](guard-3-red.log) | [exit 0](guard-3-green.log) |
| 4: server refusal | Disable the custom-section deferred-permission check | [exit 1](guard-4-red.log) | [exit 0](guard-4-green.log) |
| 5: button permission | Restore the unconditional three-state button array | [exit 1](guard-5-red.log) | [exit 0](guard-5-green.log) |
| 6: runtime refusal | Disable the new non-dilation grant refusal | [exit 1](guard-6-red.log) | [exit 0](guard-6-green.log) |

Guard 2 DERIVES its set by calling `buildFindingDefinitionSeeds()`, filtering every returned definition on `normalSemantics.allowDeferred === true`, and mapping stable keys. Only the expected result is enumerated: `["entrance:dilation"]`. The mutation inserts a brand-new definition into the actual seed builder, not into the test. Guard 3 exercises actual stateDefinition calls through the seed builder and checks every returned entrance-state-section; it does not export a private factory solely for tests.

Verbatim mutation runner output:

```text
Guard 1: RED exit 1; GREEN exit 0
Guard 2: RED exit 1; GREEN exit 0
Guard 3: RED exit 1; GREEN exit 0
Guard 4: RED exit 1; GREEN exit 0
Guard 5: RED exit 1; GREEN exit 0
Guard 6: RED exit 1; GREEN exit 0
```

## Browser evidence and limits

[Before](before.png) and [after](after.png): Chromium, 1440x900, separate base/proposed worktrees, verified loopback listeners on ports 15271/15272. Existing `/tests/fixtures/entry-sheets.html?audit=sheet&section=pupils` fixture, mocked history, same data and viewport. Before: 2 Deferred buttons. After: 0. Normal/Abnormal buttons and per-eye Note boxes remain. This proves the component in the existing entry-sheet composition, not the authenticated application route or a live backend save. No application-route live proof or AccessPolicy enforcement claim is made.

## Report-only findings

- `mcp/src/clinical-graph/ocular-health-definition.ts:594` is an additional flag consumer: the structure builder maps `structure.allowDeferred === true` into normal semantics. Left intact; guard 2 covers its seed output.
- `ui/src/components/charting/OcularHealthSection.tsx:565` passes the catalog flag into the already authorized EyePanel gate at line 691; unchanged.
- Remaining matches in `ChartFieldsSettings.tsx:29`, `CustomFindingSection.tsx:68`, `ocular-health-definition.ts:30`, and the mutation schema are declarations/validation, not additional grants.
- `FhirFindingDefinitionStore.list()` prefers stored definitions to compiled seeds. Existing stored overrides in another deployment would require separate inspection; no data migration is authorized or included.

## Governance and handoff

The accepted ruling and amended kickoff already exist in PerformanceOD and are linked from its decisions/INDEX.md. No new product decision or companion-repo edit was made. Mandate 14 ledger additions: none; no new medical codes, FHIR URLs, regulatory claims, or clinical terminology were introduced. No changes to NEGATIVE_* logic, C1 components, dispositions, option ranks, or finding lists.

Author checks only. NOT EVALUATED. Independent Fable/Opus evaluation at the PR's exact head is required before merge. No evaluator marker or operator override label was added. Deployment and authenticated app-route proof remain separate follow-ups.

## Checks

Every command's exit status was captured directly (no test command was piped into a formatter).

- `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15473/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test`: exit 0, 4,376 tests, 4,331 passed, 0 failed, 45 skipped. PostgreSQL was created for this task only. The opt-out acknowledges 41 missing live-stack tests; this is NOT an authorization gate.
- `mcp/node_modules/.bin/tsc -p mcp/tsconfig.json --noEmit`: exit 0, no diagnostics.
- `ui/node_modules/.bin/tsc -p ui/tsconfig.json --noEmit --skipLibCheck`: exit 0, no diagnostics.
- `npm run typecheck:scripts`: exit 0, no diagnostics.
- `npm run preflight`: exit 0. FHIR read grant check PASS (46 literal/marked resourceTypes); operation coverage PASS (843 operations); 0 warnings, 0 hard blocks. Its reported static-analysis limitations still apply.
- Focused MCP regressions including updated ocular-health expectations: 7 passed, 0 failed, exit 0. Focused UI gate and updated writer test: 2 passed, 0 failed, exit 0.
- First unconfigured MCP run: exit 1; 4,377 tests, 4,313 passed, 7 failed, 57 skipped. Six failures were database-connection hooks at unavailable localhost:5433. One was the unchanged Bulk Data random-ID substring assertion. The unchanged base test passed 4/4; a targeted rerun with the disposable database passed 9/9; the full configured rerun above had no failures. No unrelated code was changed.
- First UI suite: exit 1; 1,304 tests, 1,303 passed, 1 failed, 0 skipped. Its failure was the obsolete Stereopsis successful-deferral expectation, removed in this slice.

Verbatim final MCP summary:

```text
# tests 4376
# suites 0
# pass 4331
# fail 0
# cancelled 0
# skipped 45
# todo 0
# duration_ms 103388.650667
```

Raw full-suite/typecheck/preflight logs are retained locally under `/tmp/defer-1-evidence/`; committed mutation logs contain the complete focused outputs.

Final UI suite (`cd ui && npm test`): exit 0, 1,304 passed, 0 failed, 0 skipped. Verbatim summary:

```text
# tests 1304
# suites 0
# pass 1304
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 201196.410666
```
