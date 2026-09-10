# Staff-recorded opt-out guard evidence

Base: `04ad0506a9706547d330fd8ca90f3317f5e13565`. Author-side checks only; independent evaluation pending.

Replay from repo root: `python3 scripts/verification/staff-recorded-optout-mutations.py`. Every mutation is confirmed with `rg -n -F` before the test executes; the replay restores source in a finally block.

## B1

Red and restore command from repo root: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B1 " mcp/tests/commsApi.test.ts`.

```text
Mutation B1: mcp/src/comms/comms-api.ts
1844:  const reason = String(body.reason ?? "");
TAP version 13
# Subtest: B1 record rejects missing reason or identity without a Patient write
not ok 1 - B1 record rejects missing reason or identity without a Patient write
  ---
  duration_ms: 24.726167
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
# duration_ms 349.653333

```

Restored:

```text
TAP version 13
# Subtest: B1 record rejects missing reason or identity without a Patient write
ok 1 - B1 record rejects missing reason or identity without a Patient write
  ---
  duration_ms: 27.636167
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
# duration_ms 384.953875

```

## B2

Red and restore command from repo root: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B2 " mcp/tests/commsApi.test.ts`.

```text
Mutation B2: mcp/src/comms/suppression-gate.ts
107:      { url: "channel", valueCode: "sms-staff" },
TAP version 13
# Subtest: B2 recorded global suppression blocks every SMS lane like STOP until clear
not ok 1 - B2 recorded global suppression blocks every SMS lane like STOP until clear
  ---
  duration_ms: 33.605959
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
# duration_ms 358.759333

```

Restored:

```text
TAP version 13
# Subtest: B2 recorded global suppression blocks every SMS lane like STOP until clear
ok 1 - B2 recorded global suppression blocks every SMS lane like STOP until clear
  ---
  duration_ms: 36.6685
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
# duration_ms 387.83175

```

## B3

Red and restore command from repo root: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B3 " mcp/tests/commsApi.test.ts`.

```text
Mutation B3: mcp/src/comms/suppression-gate.ts
104:  const nextExtensions = duplicate ? existing : [{
TAP version 13
# Subtest: B3 global record widens and preserves every existing extension
not ok 1 - B3 global record widens and preserves every existing extension
  ---
  duration_ms: 24.635208
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
# duration_ms 343.768875

```

Restored:

```text
TAP version 13
# Subtest: B3 global record widens and preserves every existing extension
ok 1 - B3 global record widens and preserves every existing extension
  ---
  duration_ms: 22.678459
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
# duration_ms 355.320166

```

## B4

Red and restore command from repo root: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B4 " mcp/tests/commsApi.test.ts`.

```text
Mutation B4: mcp/src/comms/suppression-gate.ts
103:  const duplicate = false;
TAP version 13
# Subtest: B4 exact-scope repeats preserve bytes and write no second Provenance
not ok 1 - B4 exact-scope repeats preserve bytes and write no second Provenance
  ---
  duration_ms: 25.885833
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
# duration_ms 379.769834

```

Restored:

```text
TAP version 13
# Subtest: B4 exact-scope repeats preserve bytes and write no second Provenance
ok 1 - B4 exact-scope repeats preserve bytes and write no second Provenance
  ---
  duration_ms: 29.440209
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
# duration_ms 376.397667

```

## B5

Red and restore command from repo root: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B5 " mcp/tests/commsApi.test.ts`.

```text
Mutation B5: mcp/src/authz/roles.ts
991:      // B5 mutation: staff opt-out action removed
TAP version 13
# Subtest: B5 only action-holding staff can record an opt-out
not ok 1 - B5 only action-holding staff can record an opt-out
  ---
  duration_ms: 26.09825
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
# duration_ms 406.556792

```

Restored:

```text
TAP version 13
# Subtest: B5 only action-holding staff can record an opt-out
ok 1 - B5 only action-holding staff can record an opt-out
  ---
  duration_ms: 25.865959
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
# duration_ms 381.112083

```

## B6

Red and restore command from repo root: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test --test-name-pattern="B6 " mcp/tests/commsApi.test.ts`.

```text
Mutation B6: mcp/src/comms/comms-api.ts
1822:    ...(scope === "per-number" ? { number: body.number as string } : {}),
TAP version 13
# odos-mcp: patient communications route failed.
# Subtest: B6 record per-number requires E.164 and rejects ambiguous or unexpected fields
not ok 1 - B6 record per-number requires E.164 and rejects ambiguous or unexpected fields
  ---
  duration_ms: 23.720417
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
# duration_ms 354.265833

```

Restored:

```text
TAP version 13
# Subtest: B6 record per-number requires E.164 and rejects ambiguous or unexpected fields
ok 1 - B6 record per-number requires E.164 and rejects ambiguous or unexpected fields
  ---
  duration_ms: 29.396708
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
# duration_ms 372.522542

```

## Live browser and policy proof

Vite served this worktree on verified localhost:15173. Chromium mounted the unchanged PatientDemographicsEditor, including its real SmsOptOutControl in the smsPreferences slot. Requests went through the real registered communications routes to isolated Medplum 5.1.8 at localhost:18103. A disposable client used the synced staff AccessPolicy bound to the synthetic Patient compartment; a second client used the provider policy. The harness supplied their already-known identities at the authenticate dependency and used the existing test audit recorder: this is not proof of the production login/identity-resolution handshake or AuditEvent persistence. The role gate, request validator, Patient/Provenance transaction and Medplum AccessPolicy were real. No production runtime was changed.

Observed: empty reason 400; provider role 403; staff UI record succeeds; global STOP blocks the other configured lane via checkMessageSuppression; exact replay leaves Patient version and extensions unchanged with one CREATE Provenance; existing reason-and-identity clear succeeds and restores the recording link. The screenshots show the form and recorded state on the same proposed revision, not a before/after source comparison.

Full core MCP: 4514 tests / 4468 pass / 0 fail / 46 conditional skips. Full UI: 1332 tests / 1332 pass / 0 fail / 0 skips. Separate credentialed live-authz lane: 48 tests / 48 pass / 0 fail / 0 skips.
