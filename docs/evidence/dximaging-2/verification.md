# DXIMAGING-2 author evidence

Base: c14f14dab896938b72b564e4c02bfa69d494b4c4. Branch: drbang-iva/imaging-into-panel.

Ordinary diagnostic imaging moves from DiagnosisWorkspace into the shared panel. Photos retains the `images` internal ID and remains the default. Imaging uses the new `imaging` ID. Existing IDs and stored preferences need no migration. Entry remembers Imaging as its return tab and keeps it summoned on narrow screens.

The panel gate now accepts a valid projection OR the diagnosis view, while retaining the board-editor suppression. Both imaging components depend on patientReference, not the exam projection. This keeps the existing shared panel and default preference instead of introducing another fallback surface. Visit charges retains its existing temporary suppression.

## Scope and limitations

Production files: DiagnosisWorkspace.tsx, ExamRightPanel.tsx, EncounterCharting.tsx. Test files: examOverviewBoard.test.tsx, entrySheets.test.tsx, fixtures/entry-sheets.tsx. No endpoint, medical code, style, registry, or preference-helper edits. No new domain decision; companion decisions/INDEX.md and Mandate 14 ledger are unchanged (not applicable).

Screenshots show the real EncounterCharting component at base and proposed code with identical synthetic responses, 1600x1000 Chromium, and no real patient data. They are scene-level browser evidence, NOT live Medplum or RouteSwitch/authentication proof. The fixture's previous-exam transport is incomplete and displays its error state; that is not a finding against production. No deployment performed.

REPORT, DO NOT FIX:
- ui/src/scenes/PatientOverview.tsx:405 mounts LongitudinalImagingCard.
- ui/src/components/ChartSidebar.tsx:199 mounts LongitudinalImagingCard.
- ui/src/scenes/EncounterCharting.tsx:1328 maps the existing manual ImagingSection.
- ui/src/components/charting/DiagnosisImagingRegion.tsx:19,62 remains the only production consumer of imaging collapse preferences. The preference now collapses content inside the panel. It stays mounted across ordinary stage changes while the panel is available, and loads ordinary imaging on structure views too.
- ui/src/styles/charting.css:95,101 retains the existing third grid column and collapse-dependent grid rule. No center-column or rail resize was made, as explicitly requested.

## Mandate 17: verbatim red/green results

Each mutation was restored before the next demonstration. Commands use node --import tsx --test --test-name-pattern='<pattern>' ui/tests/examOverviewBoard.test.tsx.

### endpoint: `DXIMAGING both`

Changed the ordinary-imaging component URL to /clinical-graph/longitudinal-imaging.

RED, exit 1:
```text
TAP version 13
# Warning: Each child in a list should have a unique "key" prop.
# Check the render method of `DiagnosisImagingRegion`. See https://reactjs.org/link/warning-keys for more information.
#     at article
#     at DiagnosisImagingRegion (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/src/components/charting/DiagnosisImagingRegion.tsx:18:42)
#     at div
#     at section
#     at div
#     at ExamRightPanelSurface (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/src/components/charting/ExamRightPanel.tsx:172:3)
#     at div
#     at div
#     at EncounterChartingContent (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/src/scenes/EncounterCharting.tsx:126:37)
#     at ConfirmDestructiveProvider (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/src/components/charting/ConfirmDestructive.tsx:26:46)
#     at EncounterCharting
#     at RoleProvider (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/src/lib/role-context.tsx:12:32)
# Subtest: DXIMAGING both datasets are reachable in distinct tabs
not ok 1 - DXIMAGING both datasets are reachable in distinct tabs
  ---
  duration_ms: 61.506417
  type: 'test'
  location: '/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/tests/examOverviewBoard.test.tsx:1:112434'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /Synthetic diagnostic study/. Input:
    
    'Photos1ImagingEngageImaging›Preview unavailableSynthetic clinical photo'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: 'Photos1ImagingEngageImaging›Preview unavailableSynthetic clinical photo'
  operator: 'match'
  stack: |-
    TestContext.<anonymous> (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/tests/examOverviewBoard.test.tsx:3292:12)
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
# duration_ms 352.987375
```

GREEN, exit 0:
```text
TAP version 13
# Subtest: DXIMAGING both datasets are reachable in distinct tabs
ok 1 - DXIMAGING both datasets are reachable in distinct tabs
  ---
  duration_ms: 52.415167
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
# duration_ms 320.139708
```

### projection: `DXIMAGING ordinary`

Restored the plain Boolean(activeExamOverviewProjection) gate.

RED, exit 1:
```text
TAP version 13
# Subtest: DXIMAGING ordinary imaging survives a missing projection
not ok 1 - DXIMAGING ordinary imaging survives a missing projection
  ---
  duration_ms: 56.307125
  type: 'test'
  location: '/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/tests/examOverviewBoard.test.tsx:1:113343'
  failureType: 'testCodeFailure'
  error: |-
    The expression evaluated to a falsy value:
    
      assert.ok(harness.renderer.root.findAllByType(ExamRightPanelTabs).length)
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: 0
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/tests/examOverviewBoard.test.tsx:3301:12)
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
# duration_ms 351.486667
```

GREEN, exit 0:
```text
TAP version 13
# Subtest: DXIMAGING ordinary imaging survives a missing projection
ok 1 - DXIMAGING ordinary imaging survives a missing projection
  ---
  duration_ms: 55.0445
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
# duration_ms 325.792792
```

### strip: `DXIMAGING diagnosis`

Re-added DiagnosisImagingRegion import and original mount in DiagnosisWorkspace.

RED, exit 1:
```text
TAP version 13
# Subtest: DXIMAGING diagnosis owns no imaging strip
not ok 1 - DXIMAGING diagnosis owns no imaging strip
  ---
  duration_ms: 55.892458
  type: 'test'
  location: '/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/tests/examOverviewBoard.test.tsx:1:113904'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    5 !== 0
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 5
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/tests/examOverviewBoard.test.tsx:3312:12)
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
# duration_ms 353.568
```

GREEN, exit 0:
```text
TAP version 13
# Subtest: DXIMAGING diagnosis owns no imaging strip
ok 1 - DXIMAGING diagnosis owns no imaging strip
  ---
  duration_ms: 51.827291
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
# duration_ms 321.832708
```

### survival: `DXIMAGING imaging preference`

Reset the panel to INITIAL_EXAM_RIGHT_PANEL_STATE during the stage transition.

RED, exit 1:
```text
TAP version 13
# Subtest: DXIMAGING imaging preference survives stages with four tabs
not ok 1 - DXIMAGING imaging preference survives stages with four tabs
  ---
  duration_ms: 61.301958
  type: 'test'
  location: '/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/tests/examOverviewBoard.test.tsx:1:114284'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'images'
    - 'imaging'
           ^
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'imaging'
  actual: 'images'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/ericr.bang/GitHub/ODOS2020/.worktrees/imaging-into-panel/ui/tests/examOverviewBoard.test.tsx:3324:12)
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
# duration_ms 354.927458
```

GREEN, exit 0:
```text
TAP version 13
# Subtest: DXIMAGING imaging preference survives stages with four tabs
ok 1 - DXIMAGING imaging preference survives stages with four tabs
  ---
  duration_ms: 61.951958
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
# duration_ms 333.618084
```

## C1 and DXIMAGING final guard run

Exit 0. All six C1 named tests pass, including nested cases.
```text
TAP version 13
# Subtest: DXIMAGING both datasets are reachable in distinct tabs
ok 1 - DXIMAGING both datasets are reachable in distinct tabs
  ---
  duration_ms: 61.087708
  type: 'test'
  ...
# Subtest: DXIMAGING ordinary imaging survives a missing projection
ok 2 - DXIMAGING ordinary imaging survives a missing projection
  ---
  duration_ms: 20.17775
  type: 'test'
  ...
# Subtest: DXIMAGING diagnosis owns no imaging strip
ok 3 - DXIMAGING diagnosis owns no imaging strip
  ---
  duration_ms: 12.264958
  type: 'test'
  ...
# Subtest: DXIMAGING imaging preference survives stages with four tabs
ok 4 - DXIMAGING imaging preference survives stages with four tabs
  ---
  duration_ms: 20.084458
  type: 'test'
  ...
# Subtest: C1 tab survives a stage change
ok 5 - C1 tab survives a stage change
  ---
  duration_ms: 14.357542
  type: 'test'
  ...
# Subtest: C1 panel is available off the structure stage
ok 6 - C1 panel is available off the structure stage
  ---
  duration_ms: 10.492125
  type: 'test'
  ...
# Subtest: C1 modal editor still suppresses the panel
ok 7 - C1 modal editor still suppresses the panel
  ---
  duration_ms: 65.615042
  type: 'test'
  ...
# Subtest: C1 dirty-sheet stage transition prompts and retains edits until accepted
ok 8 - C1 dirty-sheet stage transition prompts and retains edits until accepted
  ---
  duration_ms: 22.141917
  type: 'test'
  ...
# Subtest: C1 context survives entering and leaving a full-page board editor
ok 9 - C1 context survives entering and leaving a full-page board editor
  ---
  duration_ms: 65.546834
  type: 'test'
  ...
# Subtest: C1 closing entry for a stage uses its return tab but preserves a selected context tab
    # Subtest: entry
    ok 1 - entry
      ---
      duration_ms: 13.16975
      type: 'test'
      ...
    # Subtest: images
    ok 2 - images
      ---
      duration_ms: 14.383667
      type: 'test'
      ...
    # Subtest: engage
    ok 3 - engage
      ---
      duration_ms: 13.682083
      type: 'test'
      ...
    1..3
ok 10 - C1 closing entry for a stage uses its return tab but preserves a selected context tab
  ---
  duration_ms: 41.578125
  type: 'test'
  ...
1..10
# tests 13
# suites 0
# pass 13
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 681.162
```

## Broader checks

- UI, MCP and scripts TypeScript checks: exit 0 each.
- npm run preflight: exit 0; 0 warnings, 0 hard blocks.
- Initial UI: 1309 passed, 4 failed (old Images selectors), 0 skipped; selectors and fixture corrected.
- Initial MCP: 4322 passed, 6 failed, 57 skipped; PostgreSQL connection refused at port 5433.
- MCP rerun with an isolated temporary PostgreSQL at port 15437: 4339 passed, 0 failed, 45 skipped; wrapper exit 1 because live Medplum tests are unconfigured. No skip opt-out was applied.

Final UI command: `npm --prefix ui test`, exit 0.
```text
1..1305
# tests 1313
# suites 0
# pass 1313
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 191301.849583
```

MCP command: `ODOS_POSTGRES_URL=postgresql://127.0.0.1:15437/postgres npm --prefix mcp test`, wrapper exit 1.
```text
1..3849
# tests 4384
# suites 0
# pass 4339
# fail 0
# cancelled 0
# skipped 45
# todo 0
# duration_ms 94560.700167
⚠️  LIVE STACK NOT CONFIGURED — 41 tests skipped, including live authorization enforcement (audit-header, billingIdentityConfigParity, body-structure-idempotency, clinicalWriteAuthzLive, diagnosisCarryForward, encounter-lifecycle, encounter, encounterUndoLedgerAuthzLive, historyPaginationMedplum, patient-update, profile-validation, provenance-defaults, searchParamMedplumSmoke, transaction-atomicity, v035-terminology-install, v035-write-tools, v04-observation-focus-conformance, v04-write-tools, v04b-write-tools, v04c-write-tools, v05a-authz, v05b-audit-ib-backup). This run does NOT gate authz. Set MEDPLUM_ADMIN_EMAIL/PASSWORD to run them.
```

Additional browser-label mutation: changed Photos back to Images, exit 1, 5 passed / 4 failed; restored exit 0, 9 passed / 0 failed. The browser fixture now models the fourth surface and keyboard traversal through Imaging.

Status: author checks complete with the documented live-stack gap; independent evaluation required before merge. No evaluator marker posted.
