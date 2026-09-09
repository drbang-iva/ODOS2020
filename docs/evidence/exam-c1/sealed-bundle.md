# EXAM-C1 author evidence

Status: needs independent evaluation; no evaluation marker. Base: af7a89e5b29e2bb505d10aaabca1b467cf33da50. Branch: drbang-iva/exam-c1.

The context panel is available with a matching overview projection and no full-page board editor, in either chart view. Three surface transitions preserve Images/Engage; closing the Entry tab uses the established return-tab transition. The dirty-sheet guard and encounter-change reset remain intact.

## Files and per-site decisions

- `ui/src/scenes/EncounterCharting.tsx`: three reset replacements and removal of the structure-only availability term.
- `ui/src/components/charting/ExamRightPanel.tsx`: `closeExamRightPanelEntry`, shared by those three callers. It preserves an existing context tab, and delegates to `finishExamRightPanelEntry` only when Entry disappears. Existing Done behavior is unchanged.
- `ui/tests/examOverviewBoard.test.tsx`: six C1 tests (nine including nested cases), using the existing harness that mounts real EncounterCharting. No test-only reimplementation of its transitions. External reads are stubbed; this does not exercise server policy enforcement.
- This evidence bundle and two synthetic browser screenshots.

1. `selectChartView` (line 192): preserve the context selection because changing stage closes the entry surface, not the user's context preference. If Entry was selected, restore its return tab. The two surface-close setters and dirty-sheet guard are unchanged.
2. `openBoardEditor` non-sheet branch (line 271): preserve context while the full-page editor suppresses the panel. If transitioning from Entry, retire that unavailable tab through the same transition. Hiding context does not choose new context.
3. `returnToExamOverview` (line 286): expose the user's prior context again after the full-page editor closes. It must not undo the preference retained at entry to that editor.

The helper was introduced with the stage caller, checked, then the modal caller was converted and checked, then the return caller. It does not mutate clinical data. A naive unconditional finish transition is insufficient: it could replace a context tab the user selected while Entry was parked with an older return tab.

## Checks

Each command ran directly with stdout/stderr redirected to its own file, without a pipeline; each exit status was captured separately.

| Command | Actual result | Exit |
|---|---|---|
| `npm --prefix ui test` | 1303 tests, 1303 pass, 0 fail, 0 skipped | 0 |
| `npm --prefix mcp test` | 4372 tests, 4309 pass, 6 fail, 57 skipped; all six failures were PostgreSQL connection-refused hooks in claimReadModelStore.test.ts | 1 |
| `ODOS_POSTGRES_URL=postgresql://medplum@127.0.0.1:15933/medplum npm --prefix mcp test` | 4371 tests, 4326 pass, 0 fail, 45 skipped; isolated disposable PostgreSQL | 1 |
| `./node_modules/.bin/tsc --noEmit --skipLibCheck -p ui/tsconfig.json` | no diagnostics | 0 |
| `./node_modules/.bin/tsc --noEmit -p mcp/tsconfig.json` | no diagnostics | 0 |
| `npm run typecheck:scripts` | no diagnostics | 0 |
| `npm run preflight` | CPT guard clean; 46 resource types; 843 operations; 0 warnings, 0 hard blocks | 0 |
| `git diff --check` | no diagnostics | 0 |

The MCP runner deliberately returns 1 when the live authorization stack is absent, even with zero executed-test failures. No ungated override was used. Of the 45 skips in the rerun, the runner records 41 live-stack skips. This is not a fully green MCP gate or live authorization proof. Existing renderer warnings appeared in the UI suite.

Verbatim final summary output:

### ui

```text
1..1295
# tests 1303
# suites 0
# pass 1303
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 202975.002291
```

### mcp-postgres

```text
1..3836
# tests 4371
# suites 0
# pass 4326
# fail 0
# cancelled 0
# skipped 45
# todo 0
# duration_ms 100867.526208
⚠️  LIVE STACK NOT CONFIGURED — 41 tests skipped, including live authorization enforcement (audit-header, billingIdentityConfigParity, body-structure-idempotency, clinicalWriteAuthzLive, diagnosisCarryForward, encounter-lifecycle, encounter, encounterUndoLedgerAuthzLive, historyPaginationMedplum, patient-update, profile-validation, provenance-defaults, searchParamMedplumSmoke, transaction-atomicity, v035-terminology-install, v035-write-tools, v04-observation-focus-conformance, v04-write-tools, v04b-write-tools, v04c-write-tools, v05a-authz, v05b-audit-ib-backup). This run does NOT gate authz. Set MEDPLUM_ADMIN_EMAIL/PASSWORD to run them.
```

## Four Mandate 17 demonstrations

Each mutation was applied separately to the production scene, the named test was run, and the original source was restored in a finally block before the GREEN run. RED exit 1 and GREEN exit 0 were required by the mutation runner.

1. Restore the blanket reset in selectChartView.
2. Reintroduce the structure-only availability term.
3. Remove the modal-editor suppression term.
4. Remove the stage-transition dirty-sheet guard (replace its condition with false).

Verbatim test output follows (including test counts and captured exit statuses).

### 1-tab RED

```text
TAP version 13
# Subtest: C1 tab survives a stage change
not ok 1 - C1 tab survives a stage change
  ---
  duration_ms: 57.649417
  type: 'test'
  location: '/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:1:112723'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    'images' !== 'engage'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'engage'
  actual: 'images'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:3294:12)
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
# duration_ms 376.825875

EXIT STATUS: 1
```

### 1-tab GREEN

```text
TAP version 13
# Subtest: C1 tab survives a stage change
ok 1 - C1 tab survives a stage change
  ---
  duration_ms: 55.407209
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
# duration_ms 340.599292

EXIT STATUS: 0
```

### 2-stage RED

```text
TAP version 13
# Subtest: C1 panel is available off the structure stage
not ok 1 - C1 panel is available off the structure stage
  ---
  duration_ms: 52.981875
  type: 'test'
  location: '/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:1:113276'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    0 !== 1
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 1
  actual: 0
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:3305:12)
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
# duration_ms 365.602292

EXIT STATUS: 1
```

### 2-stage GREEN

```text
TAP version 13
# Subtest: C1 panel is available off the structure stage
ok 1 - C1 panel is available off the structure stage
  ---
  duration_ms: 50.987708
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
# duration_ms 348.28625

EXIT STATUS: 0
```

### 3-modal RED

```text
TAP version 13
# Subtest: C1 modal editor still suppresses the panel
not ok 1 - C1 modal editor still suppresses the panel
  ---
  duration_ms: 118.197084
  type: 'test'
  location: '/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:1:113775'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    1 !== 0
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:3317:12)
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
# duration_ms 436.889542

EXIT STATUS: 1
```

### 3-modal GREEN

```text
TAP version 13
# Subtest: C1 modal editor still suppresses the panel
ok 1 - C1 modal editor still suppresses the panel
  ---
  duration_ms: 112.464958
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
# duration_ms 411.801542

EXIT STATUS: 0
```

### 4-dirty RED

```text
TAP version 13
# Subtest: C1 dirty-sheet stage transition prompts and retains edits until accepted
not ok 1 - C1 dirty-sheet stage transition prompts and retains edits until accepted
  ---
  duration_ms: 55.374041
  type: 'test'
  location: '/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:1:114366'
  failureType: 'testCodeFailure'
  error: 'No instances found with props: {"role":"alertdialog"}'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    expectOne (/Users/ericr.bang/GitHub/ODOS2020/ui/node_modules/react-test-renderer/cjs/react-test-renderer.development.js:18499:9)
    ReactTestInstance.findByProps (/Users/ericr.bang/GitHub/ODOS2020/ui/node_modules/react-test-renderer/cjs/react-test-renderer.development.js:18395:12)
    answerDiscardInDialog (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:2538:40)
    async TestContext.<anonymous> (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/exam-c1/ui/tests/examOverviewBoard.test.tsx:3329:20)
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
# duration_ms 373.391875

EXIT STATUS: 1
```

### 4-dirty GREEN

```text
TAP version 13
# Subtest: C1 dirty-sheet stage transition prompts and retains edits until accepted
ok 1 - C1 dirty-sheet stage transition prompts and retains edits until accepted
  ---
  duration_ms: 63.540125
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
# duration_ms 354.2775

EXIT STATUS: 0
```

## Browser evidence and limits

Chrome/Playwright, 1440 x 1000, task-owned Vite process on 127.0.0.1:5197. A temporary harness mounted the real EncounterCharting, RoleProvider, and production CSS with synthetic in-memory API responses. The before version was copied from af7a89e5; the after version imported the changed scene. All requests were intercepted; no real patient data, credentials, or writes were used. This is component-in-browser proof, not authenticated app-route or server proof.

Actual click sequence: load By structure with Images selected, click By diagnosis, wait for network idle, capture. Before: no visible selected panel tabs. After: Images remains visible. Screenshots: desktop-before.png and desktop-after.png.

## Report only; not changed

- `ui/src/components/charting/DiagnosisWorkspace.tsx:682` always mounts DiagnosisImagingRegion in the diagnosis branch. `ui/src/components/charting/DiagnosisImagingRegion.tsx:19` uses a separate diagnosis imaging preference. The browser shows this stage-owned imaging strip alongside the shared context panel, reducing centre space. Reconciliation of those context surfaces is outside C1's requested changes.
- `ui/src/components/charting/ExamEntrySheet.tsx:172-173` classifies Engage as modal; `ui/src/components/commercial/panel-shared.ts:100-109` makes siblings inert. A normal Playwright click on By diagnosis while Engage is open is intercepted by the inert chart surface. Consequently non-default-tab survival is proven at the real component-handler level, not as an end-to-end mouse gesture. The screenshots intentionally demonstrate availability using Images. No forced click or DOM mutation was used to claim user reachability.

## Follow-ups and boundary accounting

Independent Fable/Opus evaluation is required before merge; author verification is not an independent verdict. MCP live-stack authorization remains unproven. No deployment or merge was performed.

No clinical terminology, FHIR artifact URL, regulatory citation, or medical code was introduced: Mandate 14 ledger rows not applicable. This implements accepted C1, with no new strategy decision; performance-od decisions/INDEX.md unchanged. Cross-repo follow-up: the design owner should reconcile the separate diagnosis imaging region and Engage navigation limitation. All protected slice 1a/1b, registry, seed, and board implementation files remain untouched.
