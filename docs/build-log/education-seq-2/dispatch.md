# ODOS-SEQ-2 dispatch boundary — author evidence

Branch: `drbang-iva/seq2-dispatch`; base: `969526f7` (precondition already committed).

This is author-side verification, not an independent evaluation. No PR, push, merge, runtime enablement, or external send was performed. Tests use synthetic recipients and fake adapters.

## Changes

- Actor-based `dispatchEducationAs` retains the route `withStaff` wrapper unchanged. Runtime rejects a system actor carrying the staff quiet-hours exemption. Only the staff transactional SMS path retains its existing exemption.
- `prepareEducationSequenceDispatch` resolves catalog, recipient, channel, consent and suppression without invoking a provider or creating a reservation. Suppression preflight and final sends share `checkMessageSuppression` with the configured timezone/number/stop scope through the suppressed adapter.
- Reservation creation atomically stores frozen context in the second Communication payload. Recovery reads the snapshot and recorded result without catalog, recipient, or current provider configuration reads. Original enrolling sender and executing worker Provenance performer survive recovery from a failed Provenance write.
- `readEducationDispatchEvidence` returns provider acceptance time from Communication.sent. Only a persisted quiet-hours reschedule proves no provider invocation. Provider-side opt-out responses are explicitly unknown because Twilio/GHL can return suppression after an adapter call.
- Staff `/resume` refuses a pending sequence-bound attempt before `claimImmediateSend`. Existing staff generic dispatch rejects the sequence key namespace; actor dispatch also refuses a new staff send under that namespace. In-flight sequence reconciliation never falls back to mutable catalog preparation.

## Exported integration contract

From `mcp/src/comms/comms-api.ts`:

```ts
prepareEducationSequenceDispatch(deps, fhir, patient, body)
// {kind: "ready", prepared} | {kind: "held", reason} | {kind: "deferred", notBefore}

dispatchEducationAs(actor, deps, patientOrUndefined, body,
  {reconcileOnly?, senderReference?, prepared?})
// EducationEnrollmentSendOutcome

readEducationDispatchEvidence(fhir, body, senderReference)
// {outcome, acceptedAt?, providerInvoked: boolean | "unknown", frozen} | undefined
```

System actor: `{kind: "system", reference: "Device/education-sequence-worker", onBehalfOf: enrolledBy, fhir}`.
Body uses existing `recipientOverride: {reference}`. Prepared request comparison ignores only `idempotencyKey`, allowing admission to bind a newly minted attempt key after preflight. Reconciliation compares the complete logical request and attempt key, independent of object property order. Undefined evidence means unresolved; it never authorizes a new provider call.

## Guard 1 — reachable, broken, restored

The malicious system-actor dispatch uses a complete valid request and working fake adapter, so removing the refusal permits a real test-adapter send. The second guard calls the real suppression wrapper: preflight occurs during allowed hours, clock advances before execution, and a poisoned prepared suppression field must not bypass final quiet hours.

Mutation: remove the system actor runtime refusal and restore `item.consentClass === "transactional"` as the only SMS exemption condition. This duplicates the original failure mechanism. Both relevant tests turn red.

Command for baseline, mutation and restore:

```sh
npm --prefix mcp test -- tests/educationDispatchActor.test.ts
```

Mutation exit 1, 9 tests: 7 pass, 2 fail. Restored exit 0: 9 pass, 0 fail.

### Broken output

```text

> odos-mcp@0.1.0 test
> node scripts/run-tests.mjs tests/educationDispatchActor.test.ts

TAP version 13
# Subtest: system actor carrying the staff quiet-hours exemption is refused before any dependency access
not ok 1 - system actor carrying the staff quiet-hours exemption is refused before any dependency access
  ---
  duration_ms: 3.030875
  type: 'test'
  location: '/private/tmp/odos-seq2-dispatch/mcp/tests/educationDispatchActor.test.ts:1:340'
  failureType: 'testCodeFailure'
  error: 'Missing expected rejection.'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  operator: 'rejects'
  stack: |-
    async TestContext.<anonymous> (/private/tmp/odos-seq2-dispatch/mcp/tests/educationDispatchActor.test.ts:11:3)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: system send keeps enrolling sender, records executor, and reconciles frozen receipt without mutable reads
ok 2 - system send keeps enrolling sender, records executor, and reconciles frozen receipt without mutable reads
  ---
  duration_ms: 0.458583
  type: 'test'
  ...
# Subtest: preflight resolves predictable holds and quiet hours without provider calls or reservations
ok 3 - preflight resolves predictable holds and quiet hours without provider calls or reservations
  ---
  duration_ms: 0.218917
  type: 'test'
  ...
# Subtest: scheduled SMS rechecks real quiet-hours gate after preflight and frozen deferral proves zero adapter calls
not ok 4 - scheduled SMS rechecks real quiet-hours gate after preflight and frozen deferral proves zero adapter calls
  ---
  duration_ms: 10.24175
  type: 'test'
  location: '/private/tmp/odos-seq2-dispatch/mcp/tests/educationDispatchActor.test.ts:1:4604'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'sent'
    - 'rescheduled'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'rescheduled'
  actual: 'sent'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/private/tmp/odos-seq2-dispatch/mcp/tests/educationDispatchActor.test.ts:93:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: unknown reservation never invokes a provider during reconciliation
ok 5 - unknown reservation never invokes a provider during reconciliation
  ---
  duration_ms: 0.1795
  type: 'test'
  ...
# Subtest: preflight holds missing recipient, unsupported channel, absent consent, and print without admission writes
ok 6 - preflight holds missing recipient, unsupported channel, absent consent, and print without admission writes
  ---
  duration_ms: 0.172875
  type: 'test'
  ...
# Subtest: provider-side opt-out cannot prove the adapter was never invoked
ok 7 - provider-side opt-out cannot prove the adapter was never invoked
  ---
  duration_ms: 0.28925
  type: 'test'
  ...
# Subtest: frozen recovery refuses changed enrollment sender or different logical request
ok 8 - frozen recovery refuses changed enrollment sender or different logical request
  ---
  duration_ms: 0.323083
  type: 'test'
  ...
# Subtest: staff actor reconciles frozen system receipt with original executor and cannot start sequence keys
ok 9 - staff actor reconciles frozen system receipt with original executor and cannot start sequence keys
  ---
  duration_ms: 0.770625
  type: 'test'
  ...
1..9
# tests 9
# suites 0
# pass 7
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 347.413875
```

### Restored output

```text

> odos-mcp@0.1.0 test
> node scripts/run-tests.mjs tests/educationDispatchActor.test.ts

TAP version 13
# Subtest: system actor carrying the staff quiet-hours exemption is refused before any dependency access
ok 1 - system actor carrying the staff quiet-hours exemption is refused before any dependency access
  ---
  duration_ms: 0.784083
  type: 'test'
  ...
# Subtest: system send keeps enrolling sender, records executor, and reconciles frozen receipt without mutable reads
ok 2 - system send keeps enrolling sender, records executor, and reconciles frozen receipt without mutable reads
  ---
  duration_ms: 1.406583
  type: 'test'
  ...
# Subtest: preflight resolves predictable holds and quiet hours without provider calls or reservations
ok 3 - preflight resolves predictable holds and quiet hours without provider calls or reservations
  ---
  duration_ms: 0.190625
  type: 'test'
  ...
# Subtest: scheduled SMS rechecks real quiet-hours gate after preflight and frozen deferral proves zero adapter calls
ok 4 - scheduled SMS rechecks real quiet-hours gate after preflight and frozen deferral proves zero adapter calls
  ---
  duration_ms: 11.6785
  type: 'test'
  ...
# Subtest: unknown reservation never invokes a provider during reconciliation
ok 5 - unknown reservation never invokes a provider during reconciliation
  ---
  duration_ms: 0.138875
  type: 'test'
  ...
# Subtest: preflight holds missing recipient, unsupported channel, absent consent, and print without admission writes
ok 6 - preflight holds missing recipient, unsupported channel, absent consent, and print without admission writes
  ---
  duration_ms: 0.253791
  type: 'test'
  ...
# Subtest: provider-side opt-out cannot prove the adapter was never invoked
ok 7 - provider-side opt-out cannot prove the adapter was never invoked
  ---
  duration_ms: 0.308917
  type: 'test'
  ...
# Subtest: frozen recovery refuses changed enrollment sender or different logical request
ok 8 - frozen recovery refuses changed enrollment sender or different logical request
  ---
  duration_ms: 0.313292
  type: 'test'
  ...
# Subtest: staff actor reconciles frozen system receipt with original executor and cannot start sequence keys
ok 9 - staff actor reconciles frozen system receipt with original executor and cannot start sequence keys
  ---
  duration_ms: 0.773167
  type: 'test'
  ...
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 313.902709
```

## Additional test-first evidence

Initial exports absent: 3 tests, 0 pass, 3 fail; implementation: 3 pass.
A recovered request with reordered object keys: 5 tests, 4 pass, 1 fail; normalized identity comparison: 5 pass.
Provider-side opt-out proof: 8 tests, 7 pass, 1 fail (`false !== "unknown"`); tri-state evidence restored green.
Staff resume race entry: 43 route tests, 42 pass, 1 fail (`200 !== 409`); pending sequence guard: focused combined 51 pass.

## Final checks

```sh
npm --prefix mcp run build
npm --prefix mcp test -- tests/commsApi.test.ts tests/commsSuppression.test.ts tests/commsConfig.test.ts tests/commsPersistence.test.ts tests/educationEnrollmentApi.test.ts tests/educationDispatchActor.test.ts
```

TypeScript build exit 0. Regression exit 0:

```text
  ...
1..169
# tests 169
# suites 0
# pass 169
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2144.261875
```

`git diff --check`: exit 0, no output.

Existing staff route and suppression tests remain green. New fake Communication versions use opaque UUIDs and verify If-Match headers. These author tests do not prove real AccessPolicy enforcement or real FHIR concurrency. Parent worker admission/claim/live-FHIR evidence and independent Opus evaluation remain separate gates. No new medical codes, FHIR URLs, clinical decisions, or Mandate 14 ledger entries were introduced.
