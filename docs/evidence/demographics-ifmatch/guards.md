# Demographics concurrency guard evidence

Base: `04ad0506a9706547d330fd8ca90f3317f5e13565`. Author-side checks only; independent evaluation is pending.

## A1

From `ui/`: `node --import tsx --test --test-name-pattern=A1: tests/demographicsConcurrency.test.tsx`. Mutation confirmed with `rg -n -F` before execution.

```text
MUTATION CONFIRMED
185:      return api.update(buildPatientResource(draft, patient), "patient-demographics-update");
TAP version 13
# Subtest: A1: a stale demographics PUT shows the concurrent-edit alert without retrying
not ok 1 - A1: a stale demographics PUT shows the concurrent-edit alert without retrying
  ---
  duration_ms: 16.866
  type: 'test'
  location: '$WORKTREE/ui/tests/demographicsConcurrency.test.tsx:1:1069'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'FHIR 412 : conflict'
    - 'This record was changed by someone else since you opened it. Reload and reapply your change.'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'This record was changed by someone else since you opened it. Reload and reapply your change.'
  actual: 'FHIR 412 : conflict'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/ui/tests/demographicsConcurrency.test.tsx:38:12)
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
# duration_ms 823.304959

```

Restored: `node --import tsx --test tests/demographicsConcurrency.test.tsx`.

```text
TAP version 13
# Subtest: A1: a stale demographics PUT shows the concurrent-edit alert without retrying
ok 1 - A1: a stale demographics PUT shows the concurrent-edit alert without retrying
  ---
  duration_ms: 16.633375
  type: 'test'
  ...
# Subtest: A2: missing Patient version refuses before any network call
ok 2 - A2: missing Patient version refuses before any network call
  ---
  duration_ms: 0.3275
  type: 'test'
  ...
# Subtest: A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version
ok 3 - A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version
  ---
  duration_ms: 11.74025
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 816.996042

```

## A2

From `ui/`: `node --import tsx --test --test-name-pattern=A2: tests/demographicsConcurrency.test.tsx`. Mutation confirmed with `rg -n -F` before execution.

```text
MUTATION CONFIRMED
184:      if (false) throw new Error("Patient version is unavailable. Reload before saving demographics.");
TAP version 13
# Subtest: A2: missing Patient version refuses before any network call
not ok 1 - A2: missing Patient version refuses before any network call
  ---
  duration_ms: 8.433875
  type: 'test'
  location: '$WORKTREE/ui/tests/demographicsConcurrency.test.tsx:1:1843'
  failureType: 'testCodeFailure'
  error: 'Missing expected rejection.'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  operator: 'rejects'
  stack: |-
    async TestContext.<anonymous> ($WORKTREE/ui/tests/demographicsConcurrency.test.tsx:53:5)
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
# duration_ms 806.7325

```

Restored: `node --import tsx --test tests/demographicsConcurrency.test.tsx`.

```text
TAP version 13
# Subtest: A1: a stale demographics PUT shows the concurrent-edit alert without retrying
ok 1 - A1: a stale demographics PUT shows the concurrent-edit alert without retrying
  ---
  duration_ms: 16.878042
  type: 'test'
  ...
# Subtest: A2: missing Patient version refuses before any network call
ok 2 - A2: missing Patient version refuses before any network call
  ---
  duration_ms: 0.293459
  type: 'test'
  ...
# Subtest: A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version
ok 3 - A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version
  ---
  duration_ms: 12.361958
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 815.504292

```

## A3

From `ui/`: `node --import tsx --test --test-name-pattern=A3: tests/demographicsConcurrency.test.tsx`. Mutation confirmed with `rg -n -F` before execution.

```text
MUTATION CONFIRMED
331:              onPatientSaved(patient);
TAP version 13
# Subtest: A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version
not ok 1 - A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version
  ---
  duration_ms: 23.25675
  type: 'test'
  location: '$WORKTREE/ui/tests/demographicsConcurrency.test.tsx:1:2300'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    '5' !== '6'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: '6'
  actual: '5'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> ($WORKTREE/ui/tests/demographicsConcurrency.test.tsx:82:12)
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
# duration_ms 821.959041

```

Restored: `node --import tsx --test tests/demographicsConcurrency.test.tsx`.

```text
TAP version 13
# Subtest: A1: a stale demographics PUT shows the concurrent-edit alert without retrying
ok 1 - A1: a stale demographics PUT shows the concurrent-edit alert without retrying
  ---
  duration_ms: 16.340417
  type: 'test'
  ...
# Subtest: A2: missing Patient version refuses before any network call
ok 2 - A2: missing Patient version refuses before any network call
  ---
  duration_ms: 0.321708
  type: 'test'
  ...
# Subtest: A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version
ok 3 - A3: the actual PatientRoute keeps the returned Patient and the next save uses its new version
  ---
  duration_ms: 11.635917
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 812.165833

```

## Required callback type contract

CodeRabbit identified that an optional onPatientSaved prop would permit a new consumer to omit state propagation. The callback is now required; read-only view fixtures explicitly supply a no-op. A temporary compile probe assigned a Patient-only object to ComponentProps<typeof PatientOverview> with an expected-error annotation. Before the fix, `./ui/node_modules/.bin/tsc --project ui/tsconfig.json --noEmit` failed with `TS2578: Unused @ts-expect-error directive`; after requiring the callback the same probe compiled successfully (exit 0), proving omission is a type error. The temporary probe was removed. A1-A3 mutations above were rerun after this fix.

## Live browser proof

The real PatientRoute and demographics editor were loaded from this worktree through Vite on verified localhost port 15172. Browser FHIR traffic was forwarded to disposable Medplum 5.1.8 at localhost:18103 using a synthetic operator identity. No real practice data or services were used. Other overview APIs were unavailable; SMS preferences were intentionally denied in this Part A route proof. This is a persistence/concurrency proof, not a staff AccessPolicy verdict.

A Patient was read, the editor opened, and `updateInboundSuppression` wrote a STOP through the real Medplum client. Save sent exactly one PUT with If-Match; Medplum returned 412, the existing alert appeared, and a fresh read retained the STOP extension. The screenshots show two steps of that same after-change workflow, not two source revisions.
