# Staff-recorded opt-out guard evidence

Base: `04ad0506a9706547d330fd8ca90f3317f5e13565`. Author-side checks only; independent evaluation pending.

Replay from repo root: `python3 scripts/verification/staff-recorded-optout-mutations.py`. Every mutation is confirmed with `rg -n -F` before the test executes; the replay restores source in a finally block. Logs now use private, uniquely created temporary files. These B1-B6 results were rerun after the review corrections.

## B1

Red and restore command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B1 " mcp/tests/commsApi.test.ts`.

Red (source confirmed before red):

```text
Mutation B1: mcp/src/comms/comms-api.ts
1844:  const reason = String(body.reason ?? "");
TAP version 13
# Subtest: B1 record rejects missing reason or identity without a Patient write
not ok 1 - B1 record rejects missing reason or identity without a Patient write
  ---
  duration_ms: 23.125375
  type: 'test'
  location: '$WORKTREE/mcp/tests/commsApi.test.ts:1:25053'
  failureType: 'testCodeFailure'
  error: |-
    {}

    200 !== 400

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 400
  actual: 200
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/mcp/tests/commsApi.test.ts:804:14)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 332.624042

```

Green (source confirmed before red):

```text
TAP version 13
# Subtest: B1 record rejects missing reason or identity without a Patient write
ok 1 - B1 record rejects missing reason or identity without a Patient write
  ---
  duration_ms: 26.930791
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 356.075875

```

## B2

Red and restore command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B2 " mcp/tests/commsApi.test.ts`.

Red (source confirmed before red):

```text
Mutation B2: mcp/src/comms/suppression-gate.ts
107:      { url: "channel", valueCode: "sms-staff" },
TAP version 13
# Subtest: B2 recorded global suppression blocks every SMS lane like STOP until clear
not ok 1 - B2 recorded global suppression blocks every SMS lane like STOP until clear
  ---
  duration_ms: 31.658125
  type: 'test'
  location: '$WORKTREE/mcp/tests/commsApi.test.ts:1:25805'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected

    + undefined
    - {
    -   outcome: 'suppressed',
    -   reason: 'patient-opt-out'
    - }

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
    outcome: 'suppressed'
    reason: 'patient-opt-out'
  operator: 'deepStrictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/mcp/tests/commsApi.test.ts:824:14)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 343.461083

```

Green (source confirmed before red):

```text
TAP version 13
# Subtest: B2 recorded global suppression blocks every SMS lane like STOP until clear
ok 1 - B2 recorded global suppression blocks every SMS lane like STOP until clear
  ---
  duration_ms: 31.327583
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 351.198291

```

## B3

Red and restore command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B3 " mcp/tests/commsApi.test.ts`.

Red (source confirmed before red):

```text
Mutation B3: mcp/src/comms/suppression-gate.ts
104:  const nextExtensions = duplicate ? existing : [{
TAP version 13
# Subtest: B3 global record widens and preserves every existing extension
not ok 1 - B3 global record widens and preserves every existing extension
  ---
  duration_ms: 23.8955
  type: 'test'
  location: '$WORKTREE/mcp/tests/commsApi.test.ts:1:27863'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected

      {
        global: true,
    +   numbers: []
    -   numbers: [
    -     '+18645550100'
    -   ]
      }

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
    global: true
    numbers:
      0: '+18645550100'
  actual:
    global: true
    numbers:
  operator: 'deepStrictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/mcp/tests/commsApi.test.ts:856:12)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 332.961292

```

Green (source confirmed before red):

```text
TAP version 13
# Subtest: B3 global record widens and preserves every existing extension
ok 1 - B3 global record widens and preserves every existing extension
  ---
  duration_ms: 20.636916
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 327.062917

```

## B4

Red and restore command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B4 " mcp/tests/commsApi.test.ts`.

Red (source confirmed before red):

```text
Mutation B4: mcp/src/comms/suppression-gate.ts
103:  const duplicate = false;
TAP version 13
# Subtest: B4 exact-scope repeats preserve bytes and write no second Provenance
not ok 1 - B4 exact-scope repeats preserve bytes and write no second Provenance
  ---
  duration_ms: 26.727167
  type: 'test'
  location: '$WORKTREE/mcp/tests/commsApi.test.ts:1:28619'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + '{"resourceType":"Patient","id":"synthetic-1","meta":{"versionId":"3"},"telecom":[{"system":"phone","value":"+18645550199"},{"system":"email","value":"patient@example.test"}],"extension":[{"url":"https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out","extension":[{"url":"channel","valueCode":"sms"}]},{"url":"https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out","extension":[{"url":"channel","valueCode":"sms"}]}]}'
    - '{"resourceType":"Patient","id":"synthetic-1","meta":{"versionId":"2"},"telecom":[{"system":"phone","value":"+18645550199"},{"system":"email","value":"patient@example.test"}],"extension":[{"url":"https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out","extension":[{"url":"channel","valueCode":"sms"}]}]}'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: '{"resourceType":"Patient","id":"synthetic-1","meta":{"versionId":"2"},"telecom":[{"system":"phone","value":"+18645550199"},{"system":"email","value":"patient@example.test"}],"extension":[{"url":"https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out","extension":[{"url":"channel","valueCode":"sms"}]}]}'
  actual: '{"resourceType":"Patient","id":"synthetic-1","meta":{"versionId":"3"},"telecom":[{"system":"phone","value":"+18645550199"},{"system":"email","value":"patient@example.test"}],"extension":[{"url":"https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out","extension":[{"url":"channel","valueCode":"sms"}]},{"url":"https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out","extension":[{"url":"channel","valueCode":"sms"}]}]}'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/mcp/tests/commsApi.test.ts:871:14)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 357.666417

```

Green (source confirmed before red):

```text
TAP version 13
# Subtest: B4 exact-scope repeats preserve bytes and write no second Provenance
ok 1 - B4 exact-scope repeats preserve bytes and write no second Provenance
  ---
  duration_ms: 26.475375
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 351.525667

```

## B5

Red and restore command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B5 " mcp/tests/commsApi.test.ts`.

Red (source confirmed before red):

```text
Mutation B5: mcp/src/authz/roles.ts
991:      // B5 mutation: staff opt-out action removed
TAP version 13
# Subtest: B5 only action-holding staff can record an opt-out
not ok 1 - B5 only action-holding staff can record an opt-out
  ---
  duration_ms: 24.308208
  type: 'test'
  location: '$WORKTREE/mcp/tests/commsApi.test.ts:1:29311'
  failureType: 'testCodeFailure'
  error: |-
    staff

    403 !== 200

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 200
  actual: 403
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/mcp/tests/commsApi.test.ts:883:14)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 354.2415

```

Green (source confirmed before red):

```text
TAP version 13
# Subtest: B5 only action-holding staff can record an opt-out
ok 1 - B5 only action-holding staff can record an opt-out
  ---
  duration_ms: 23.85975
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 359.639542

```

## B6

Red and restore command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B6 " mcp/tests/commsApi.test.ts`.

Red (source confirmed before red):

```text
Mutation B6: mcp/src/comms/comms-api.ts
1822:    ...(scope === "per-number" ? { number: body.number as string } : {}),
TAP version 13
# odos-mcp: patient communications route failed.
# Subtest: B6 record per-number requires E.164 and rejects ambiguous or unexpected fields
not ok 1 - B6 record per-number requires E.164 and rejects ambiguous or unexpected fields
  ---
  duration_ms: 22.786209
  type: 'test'
  location: '$WORKTREE/mcp/tests/commsApi.test.ts:1:29729'
  failureType: 'testCodeFailure'
  error: |-
    {"scope":"per-number"}

    502 !== 400

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 400
  actual: 502
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/mcp/tests/commsApi.test.ts:899:14)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 338.55125

```

Green (source confirmed before red):

```text
TAP version 13
# Subtest: B6 record per-number requires E.164 and rejects ambiguous or unexpected fields
ok 1 - B6 record per-number requires E.164 and rejects ambiguous or unexpected fields
  ---
  duration_ms: 27.664375
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 353.208125

```

## Review regression guards

UI command, from `ui/`: `node --import tsx --test --test-name-pattern="stale opt-out" tests/smsOptOutControl.test.tsx`. Python command from root: `python3 scripts/verification/test_staff_recorded_optout_mutations.py`. Each mutation below was confirmed with `rg -n -F`, failed, restored, and passed.

### stale-success

Red and green: `node --import tsx --test --test-name-pattern="stale opt-out success" tests/smsOptOutControl.test.tsx` (from `ui/`).

Red:

```text
119:        setState(nextState);
TAP version 13
# Subtest: stale opt-out success cannot update a new patient or finish its pending submission
not ok 1 - stale opt-out success cannot update a new patient or finish its pending submission
  ---
  duration_ms: 17.831584
  type: 'test'
  location: '$WORKTREE/ui/tests/smsOptOutControl.test.tsx:1:14316'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected

    + [
    +   'Patient/first'
    + ]
    - []

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual:
    0: 'Patient/first'
  operator: 'deepStrictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/ui/tests/smsOptOutControl.test.tsx:465:14)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 385.909291

```

Green:

```text
TAP version 13
# Subtest: stale opt-out success cannot update a new patient or finish its pending submission
ok 1 - stale opt-out success cannot update a new patient or finish its pending submission
  ---
  duration_ms: 16.391333
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 366.124208

```

### stale-failure

Red and green: `node --import tsx --test --test-name-pattern="stale opt-out failure" tests/smsOptOutControl.test.tsx` (from `ui/`).

Red:

```text
83:      setError(cause instanceof Error ? cause.message : "SMS preferences unavailable.");
160:      setError(cause instanceof Error ? cause.message : "SMS preferences unavailable.");
TAP version 13
# Subtest: stale opt-out failure cannot update a new patient or finish its pending submission
not ok 1 - stale opt-out failure cannot update a new patient or finish its pending submission
  ---
  duration_ms: 17.346042
  type: 'test'
  location: '$WORKTREE/ui/tests/smsOptOutControl.test.tsx:1:14316'
  failureType: 'testCodeFailure'
  error: 'No instances found with props: {"type":"submit"}'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    expectOne ($WORKTREE/ui/node_modules/react-test-renderer/cjs/react-test-renderer.development.js:18499:9)
    ReactTestInstance.findByProps ($WORKTREE/ui/node_modules/react-test-renderer/cjs/react-test-renderer.development.js:18395:12)
    TestContext.<anonymous> ($WORKTREE/ui/tests/smsOptOutControl.test.tsx:467:36)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 382.144167

```

Green:

```text
TAP version 13
# Subtest: stale opt-out failure cannot update a new patient or finish its pending submission
ok 1 - stale opt-out failure cannot update a new patient or finish its pending submission
  ---
  duration_ms: 19.195792
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 380.857959

```

### stale-finally

Red and green: `node --import tsx --test --test-name-pattern="stale opt-out" tests/smsOptOutControl.test.tsx` (from `ui/`).

Red:

```text
57:    setClearing(false);
163:      setClearing(false);
TAP version 13
# Subtest: stale opt-out success cannot update a new patient or finish its pending submission
not ok 1 - stale opt-out success cannot update a new patient or finish its pending submission
  ---
  duration_ms: 17.061166
  type: 'test'
  location: '$WORKTREE/ui/tests/smsOptOutControl.test.tsx:1:14316'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    false !== true

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/ui/tests/smsOptOutControl.test.tsx:468:14)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: stale opt-out failure cannot update a new patient or finish its pending submission
not ok 2 - stale opt-out failure cannot update a new patient or finish its pending submission
  ---
  duration_ms: 2.905708
  type: 'test'
  location: '$WORKTREE/ui/tests/smsOptOutControl.test.tsx:1:14316'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    false !== true

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/ui/tests/smsOptOutControl.test.tsx:468:14)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
1..2
# tests 2
# suites 0
# pass 0
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 376.838375

```

Green:

```text
TAP version 13
# Subtest: stale opt-out success cannot update a new patient or finish its pending submission
ok 1 - stale opt-out success cannot update a new patient or finish its pending submission
  ---
  duration_ms: 16.703417
  type: 'test'
  ...
# Subtest: stale opt-out failure cannot update a new patient or finish its pending submission
ok 2 - stale opt-out failure cannot update a new patient or finish its pending submission
  ---
  duration_ms: 2.106417
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 375.097959

```

### symlink

Red:

```text
37:    log = open(f"/tmp/consent-{tag}-{phase}.log", "w")
B1 red log: $TEMP_LOG
F
======================================================================
FAIL: test_logs_are_exclusive_private_and_preserve_existing_symlink_targets (__main__.MutationLogTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "$WORKTREE/scripts/verification/test_staff_recorded_optout_mutations.py", line 35, in test_logs_are_exclusive_private_and_preserve_existing_symlink_targets
    self.assertEqual(target.read_text(), "original")
AssertionError: 'evidence' != 'original'
- evidence
+ original


----------------------------------------------------------------------
Ran 1 test in 0.001s

FAILED (failures=1)

```

Green:

```text
B1 red log: $TEMP_LOG
B1 red log: $TEMP_LOG
B1 green log: $TEMP_LOG
B1 green log: $TEMP_LOG
.
----------------------------------------------------------------------
Ran 1 test in 0.002s

OK

```

## Live browser and policy proof

Vite served this worktree on verified localhost:15173. Chromium mounted the unchanged PatientDemographicsEditor, including its real SmsOptOutControl in the smsPreferences slot. Requests went through the real registered communications routes to isolated Medplum 5.1.8 at localhost:18103. A disposable client used the synced staff AccessPolicy bound to the synthetic Patient compartment; a second client used the provider policy. The harness supplied their already-known identities at the authenticate dependency and used the existing test audit recorder: this is not proof of the production login/identity-resolution handshake or AuditEvent persistence. The role gate, request validator, Patient/Provenance transaction and Medplum AccessPolicy were real. No production runtime was changed.

Observed: empty reason 400; provider role 403; staff UI record succeeds; global STOP blocks the other configured lane via checkMessageSuppression; exact replay leaves Patient version and extensions unchanged with one CREATE Provenance; existing reason-and-identity clear succeeds and restores the recording link. The screenshots show the form and recorded state on the same proposed revision, not a before/after source comparison.

Full core MCP: 4514 tests / 4468 pass / 0 fail / 46 conditional skips. Full UI after review corrections: 1334 tests / 1334 pass / 0 fail / 0 skips. Separate credentialed live-authz lane: 48 tests / 48 pass / 0 fail / 0 skips.

## Full-suite intermittent failure retained

The first core rerun after review corrections reported 4514 tests / 4467 pass / 1 fail / 46 skipped. `educationEnrollmentApi.test.ts` and the education enrollment/lifecycle implementation are unchanged from the base. The failed lifecycle race assertion returned 200 instead of 409. Ten unchanged targeted reruns each passed both lifecycle race tests; the cause remains unresolved. No education code was changed for this observation.

Targeted command, from `mcp/`: `node --import tsx --test --test-name-pattern="sequence HTTP lifecycle lost" tests/educationEnrollmentApi.test.ts`.

```text
not ok 1443 - sequence HTTP lifecycle lost 409 race returns typed 409 without retry
  ---
  duration_ms: 9.546334
  type: 'test'
  location: '$WORKTREE/mcp/tests/educationEnrollmentApi.test.ts:1:44340'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    200 !== 409

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 409
  actual: 200
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/mcp/tests/educationEnrollmentApi.test.ts:1369:14)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
```

The unchanged full core confirmation run completed: 4514 tests / 4468 pass / 0 fail / 46 skipped (98379.598042 ms). This does not erase the intermittent failure above.
