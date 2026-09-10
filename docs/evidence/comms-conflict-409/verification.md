# Comms conflict mapping — author verification

Base: `0f3fdb606549986355413b12695100ce27d8c797` (fresh `origin/main`). Branch: `drbang-iva/comms-conflict-409`.

## Behavior and scope

Staff record/clear version conflicts now return HTTP 409 with “This patient's record changed while you were working. Reload and try again.” The shared `withStaff` branch follows all five existing typed branches. Failed transaction entries carry a numeric status. Both forms close, re-read the SMS state, publish the refreshed state/suppression to their host, and display the route message. Existing post-await patient-generation guards remain in place.

Production files: `mcp/src/comms/comms-api.ts`, `mcp/src/comms/suppression-gate.ts`, `ui/src/components/patient/SmsOptOutControl.tsx`. Tests: `mcp/tests/commsApi.test.ts`, `ui/tests/smsOptOutControl.test.tsx`. This directory contains author evidence only.

No terminology, FHIR URL, registry, ledger, decision, authorization policy, enrollment handling, or dependency changes. No Mandate 14 rows or decisions/INDEX.md update is applicable to this scoped repair.

## Tests and command exit statuses

Every command ran directly with stdout/stderr redirected to its own log, never piped. Exit statuses were captured from the command process, independently of output parsing.

| Command | Result | Own exit |
| --- | --- | --- |
| Baseline `npm --prefix mcp test -- tests/commsApi.test.ts` | 55 passed, 0 failed | 0 |
| Baseline `cd ui && node --import tsx --test tests/smsOptOutControl.test.tsx` | 13 passed, 0 failed | 0 |
| Test-first MCP, same focused command | 58 passed, 5 failed (all conflict routes returned 502) | 1 |
| Test-first UI, same focused command | 13 passed, 2 failed (missing second GET) | 1 |
| Restored focused MCP | 63 passed, 0 failed | 0 |
| Restored focused UI | 15 passed, 0 failed | 0 |
| `npm --prefix mcp test` | 4,459 passed, 6 failed, 58 skipped (4,523 total); missing PostgreSQL at 127.0.0.1:5433 caused claim read-model setup failures | 1 |
| `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15543/medplum npm --prefix mcp test` | 4,476 passed, 0 failed, 46 skipped (4,522 total); task-owned disposable PostgreSQL; harness still refuses missing live Medplum checks | **1** |
| `npm --prefix ui test` | 1,339 passed, 0 failed, 0 skipped | 0 |
| `npm --prefix mcp run build` | TypeScript build completed | 0 |
| `npm --prefix ui run build` | TypeScript + Vite completed; existing large-chunk warning | 0 |
| `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs` | 24 route families / 27 proxy entries; every family covered (advisory) | 0 |
| `git diff --check` | No whitespace errors | 0 |

The PostgreSQL URL above is a disposable synthetic container configuration, not a practice credential. The first run has one extra counted failure from its failed file-level teardown. The second run also enables 12 PostgreSQL-dependent checks that were skipped in the first run.

**The full local MCP gate is not green.** Its harness reports 41 live-stack skips among the 46 total skips and exits 1. `ODOS_ALLOW_UNGATED_MCP` was not used. No live Medplum authorization/atomicity result is claimed; CI and independent evaluation remain separate gates.

## Fixture provenance and route outcomes

The HTTP-error fixture invokes `createOperatorScriptFhirClient` against an ephemeral local HTTP server. Real `executeTransaction` and `update` invoke the private `toError` in `mcp/src/fhir-client.ts:317–319`. It asserts exact messages and numeric `.status`, including the resource-type suffix:

- `FHIR POST /fhir/R4 [Bundle] 412 Precondition Failed: Synthetic write failure`
- `FHIR POST /fhir/R4 [Bundle] 500 Internal Server Error: Synthetic write failure`
- `FHIR PUT /fhir/R4/Patient/:id [Patient] 412 Precondition Failed: Synthetic write failure`

It additionally asserts that `/FHIR (409|412)\b/` does not match these messages. This is the real writer's error, not a hand-built status-only stub.

Record and clear each exercise both a thrown 412 and a transaction-response with a failed 412 entry through the real HTTP routes and service validator. All four assert 409, the exact message, unchanged Patients, no Provenance, and one attempted attributed transaction. The injected failed transaction returns before any fake persistence. The real 500, non-transaction response, and incomplete transaction response remain 502. Service test 78 is unchanged.

The education-recipient path is exercised, not deferred: `alsoUpdateChart` reaches the existing recipient update, the fixture asserts `If-Match`, and the real writer's 412 becomes 409. Patient and recipient updates remain unchanged. **The send has already occurred** (`smsRequests.length === 1`); this repair does not make dispatch and chart updates atomic or change retry/idempotency semantics.

## Mandate 17 mutations

Each mutation was applied to exactly one asserted match, confirmed with `rg -n`, tested, restored in a `finally` block, and re-tested. MCP guard runs use `npm --prefix mcp test -- tests/commsApi.test.ts`; UI uses `cd ui && node --import tsx --test tests/smsOptOutControl.test.tsx`.

### C1

Deleted withStaff conflict branch. Four opt-out cases and education return 502 instead of 409.

Mutation confirmation:

```text
1476:    // C1 mutation: conflict branch removed.
```

RED (exit 1):

```text
not ok 56 - conflict mapping: record toError returns 409 without Patient or Provenance writes
not ok 57 - conflict mapping: record transaction-entry returns 409 without Patient or Provenance writes
not ok 58 - conflict mapping: clear toError returns 409 without Patient or Provenance writes
not ok 59 - conflict mapping: clear transaction-entry returns 409 without Patient or Provenance writes
not ok 63 - conflict mapping: education recipient If-Match returns 409
# tests 63
# pass 58
# fail 5
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 63
# pass 63
# fail 0
# skipped 0
```

### C2

Removed numeric status attachment. Only transaction-entry cases fail; both toError-shaped cases stay green.

Mutation confirmation:

```text
505:    throw new Error(`SMS opt-out failed with status ${failed.response?.status ?? "unknown"}.`);
```

RED (exit 1):

```text
not ok 57 - conflict mapping: record transaction-entry returns 409 without Patient or Provenance writes
not ok 59 - conflict mapping: clear transaction-entry returns 409 without Patient or Provenance writes
# tests 63
# pass 61
# fail 2
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 63
# pass 63
# fail 0
# skipped 0
```

### C3

Widened branch to if (true). The 500 negative and both malformed-response cases fail with 409 instead of 502, along with four existing failure-path checks.

Mutation confirmation:

```text
1476:    if (true) {
```

RED (exit 1):

```text
not ok 19 - a failed education send leaves recipient telecom unchanged
not ok 33 - opt-out clear uses the caller-bound FHIR client for the Patient write
not ok 34 - opt-out state uses the caller-bound FHIR client for the Patient read
not ok 51 - a post-send FHIR failure leaves a durable unknown outcome and blocks duplicate dispatch
not ok 60 - conflict mapping: toError 500 remains 502
not ok 61 - conflict mapping: malformed batch-response remains 502
not ok 62 - conflict mapping: malformed transaction-response remains 502
# tests 63
# pass 56
# fail 7
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 63
# pass 63
# fail 0
# skipped 0
```

### C4

Replaced the conflict re-read with stale state. Both record and clear fail because GET /communications/opt-out is missing after POST.

Mutation confirmation:

```text
165:          const nextState = state; // C4 mutation: re-read removed.
```

RED (exit 1):

```text
not ok 14 - conflict mapping: record 409 closes the form and re-reads SMS state
not ok 15 - conflict mapping: clear 409 closes the form and re-reads SMS state
# tests 15
# pass 13
# fail 2
# skipped 0
```

Restored GREEN (exit 0):

```text
# tests 15
# pass 15
# fail 0
# skipped 0
```

## Browser evidence

`before.png` and `after.png` are 1000×550 Chromium captures of the real SmsOptOutControl. Before uses a separate detached base worktree; after uses this branch. Vite listeners were verified on separate task-owned ports 15361 and 15362. Both use the same synthetic fixture, viewport, and click path: record opt-out → enter reason/identity method → confirm. Network responses are intercepted synthetic responses, not a live Medplum race.

- Before: GET → POST 502; the current base UI renders “SMS preferences unavailable.”
- After: GET → POST 409 → GET; the re-read returns a global opt-out, the form is closed, and both the new suppression state and conflict message appear.

This is component/browser proof, not a full authenticated application-route or disposable-Medplum-stack walkthrough. Route tests separately prove the HTTP mapping. Temporary preview fixture files are not part of the patch. No real patient, phone, credential, or practice data was captured.

## Existing conflict-check inventory — unchanged

The kickoff lists five; inspection at the pinned base found those five plus an additional existing copy:

| File (base line) | Function | Signal |
| --- | --- | --- |
| `mcp/src/clinical-graph/fhir-conflict.ts:1` | `isFhirConflict` (shared, imported here) | Numeric status or message regex |
| `mcp/src/comms/education-enrollment.ts:899` | `isFhirConflict` | Status only |
| `mcp/src/clinical-graph/complaint-endpoint.ts:476` | `isConcurrentEdit` | Status coerced with Number |
| `mcp/src/authz/role-grants.ts:665` | `isMembershipVersionConflict` | Strict numeric status |
| `mcp/src/claims/claimmd-handlers.ts:2536` | `isFhirVersionConflict` | Numeric status or message regex |
| `mcp/src/comms/comms-persistence.ts:759` | `isFhirConflict` | Numeric status or message regex |

No new conflict predicate was added; none of these six implementations was changed.

## Boundaries and next authority

- No consolidation of the conflict helpers.
- Twilio inbound STOP race/retry remains outside this patch. The kickoff's AWS retry/carrier suppression backstops are background context, not newly verified external-provider evidence. Local STOP persistence can still lose a race; webhook/redelivery behavior remains unverified here.
- Education enrollment handling and #575 Findings 2 and 3 remain unchanged.
- Live Medplum checks were not run locally. Parent callback freshness is covered on successful re-read; existing patient-generation guards remain after awaits. There is no new retry loop.
- No cross-repo edits, new decisions, ledger changes, merge, labels, or self-evaluation marker.
- Author verification only. Independent evaluation must be Claude Opus 5 (extra) at the final PR head.
