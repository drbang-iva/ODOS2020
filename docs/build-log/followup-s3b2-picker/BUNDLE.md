# S3b-2 picker — Rev 2 sealed author bundle

Previous diagnoses can now explicitly shape a visit together with its chosen template.
Explicit provenance records the chooser and time; automatic shaping never replaces it.
Optional history-read failures stay visibly inside the picker as a non-assertive status.
Template selection and Nothing to follow remain usable during those failures.
`findingSectionGroups.test.tsx` is untouched; all four previously failing tests now pass.
The original G1–G8 mutation evidence and base screenshots are retained.
Proofs 1–4 and G9 passed on the local synthetic stack at 1440 and 390 pixels.
NOT EVALUATED — independent evaluation belongs to Claude Opus 5, high effort.

Base: `15a0c0e951844aa0fe4e6aeee125742516a8baf6`, refreshed from origin before sealing.
Branch: `drbang-iva/followup-s3b2-picker`. PR URL and final head are supplied in the PR and handoff (the bundle cannot embed its own commit hash).
Coder: Codex, `gpt-6-astra`. High effort was requested; session metadata reports actual runtime effort **low**. No claim is made that the runtime was switched.

The superseded stop is preserved in [BLOCKED-REV1.md](BLOCKED-REV1.md). Rev 2 resolves the missing failure behavior without expanding scope or changing excluded fixtures.

## Premises at origin/main

- P1 confirmed: exam-scope-store shapeSchema has profilesApplied, sectionsOpen, shapedAt; no source.
- P2 confirmed: shapeIfAbsent returns parsed existing scope before calling its resolver; writes use If-None-Exist, If-Match and writeToken confirmation.
- P3 confirmed: overview catches shaping failures, retries the scope read on 409/412, otherwise serves the unshaped projection; S3b1 G8 covers an unconfirmed create.
- P4 confirmed: handlePreviousExamsReadRequest requires chart.read and returns prior visits sorted -date, four per page; loadPreviousExamsPage and PreviousExams already exist.
- P5 confirmed: materializeProtocolFollowUp writes ServiceRequest with encounter:protocol:item identity; action reader filters encounterId. No nextVisit.requests implementation in mcp/src or ui/src.
- P6 confirmed: EncounterHeader's ExamScopePicker writes examScope plus expectedVersion; PUT requires chart.read and chart.write. Projection reads explicit examScope, not scheduling category.
- P7 confirmed: clinicalGraphRouting asserts exactly 57 callers and checks each caller's helper import.
- P8 confirmed: stored shapes return before profile resolution; S3b1 store test exercises edit and retirement and scope-only preservation.

## Scope exclusions

Not done: Following strip (S5); open follow-up orders section (S4); Since last visit and pull-forward sheet (S5); test queue and Follow-up tab (S3c); view-state migration (S3b-3); changes to Apply writes (S5).

No new medical codes, billing codes or clinical intervals. No new decisions or Mandate 14 ledger rows required.

## Files touched

- `mcp/src/clinical-graph/exam-scope-store.ts`
- `mcp/src/clinical-graph/exam-overview-endpoint.ts`
- `mcp/tests/examShapeRecord.test.ts`
- `mcp/tests/examOverviewEndpoint.test.ts`
- `ui/src/components/charting/EncounterHeader.tsx`
- `ui/src/components/charting/FollowingPicker.tsx` (new)
- `ui/tests/examOverviewBoard.test.tsx`
- `ui/tests/followingPicker.test.tsx` (new)
- `docs/build-log/followup-s3b2-picker/` (this bundle, concise mutation evidence, proof harness and base screenshots)

The projection needs no change: source comes from the existing exam-scope GET in the header; the existing refresh callback reloads the board after the atomic template/shape choice. The previous-exams client is reused unchanged. No added API-base caller: `clinicalGraphRouting.test.tsx` remains at 57, unchanged after its temporary count mutation.

## Checks and counts

| Check | Base | Rev 2 candidate |
|---|---|---|
| `npm --prefix ui test` | 1,816 tests; 1,816 pass; 0 fail; 0 skip | 1,824 tests; 1,824 pass; 0 fail; 0 skip |
| Full MCP command below | 6,175 tests; 6,120 pass; 0 fail; 55 skip | 6,190 tests; 6,135 pass; 0 fail; 55 skip |
| `npx tsc --noEmit` at root, ui and mcp | all exit 0 | all exit 0 |
| `npm run preflight` | 0 warnings; 0 hard blocks | 0 warnings; 0 hard blocks |
| Production MCP/UI builds | exit 0 | exit 0 |
| `git diff --check` | clean | clean |

UI **1,816 + 8 = 1,824**; MCP **6,175 + 15 = 6,190**. Concise suite output: [suite-summaries.json](suite-summaries.json).

```sh
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:28836/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test
```

This uses disposable synthetic Postgres credentials. The MCP wrapper identifies 47 of the 55 skips as unconfigured live tests; this suite is **not a live authorization verdict**. The picker proof separately uses the real local Medplum stack.

Rev 2's first MCP attempt lost its task-owned database when a readiness-login rate limit stopped the stack: 6,189 tests, 6,128 pass, 6 fail, 55 skip (one suite-hook failure). The harness now retries HTTP 429 with a bounded wait. Restarting only the task stack and rerunning produced the final green counts above, with no application change. Earlier Rev 1 failures remain in the archived bundle; none were omitted or relabeled as green.

Focused server command: `node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examShapeRecord.test.ts mcp/tests/examScopeStore.test.ts mcp/tests/historyRos.test.ts` — **70 pass, 0 fail**.

Unchanged section-group fixture plus picker: `cd ui && node --import tsx --test tests/findingSectionGroups.test.tsx tests/followingPicker.test.tsx` — **18 pass, 0 fail** (13 existing section-group tests plus 5 picker tests).
New G9 tests first failed **4/4**, then passed **4/4**. All original S1 through S3b-1 assertions remain.

## G1–G8 mutation proof

Each mutant was applied alone, executed, restored in a finally block, and executed again. Reproduction: `python3 docs/build-log/followup-s3b2-picker/proof/mutations.py`. Exact per-command summaries are in `mutations.json` and quoted below. G1 directly exercises the store boundary as well as a separate endpoint survival test; the overview's existing-row optimization is not mistaken for the store guard. G6 proves the prohibited scheduling read is absent by source inspection; it is not a live scheduling integration claim.

### G1

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern=S3b2 G1 mcp/tests/examShapeRecord.test.ts`.

Broken, exit 1:

```text
not ok 1 - S3b2 G1 explicit shape survives automatic shaping at the store boundary
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b2 G1 explicit shape survives automatic shaping at the store boundary
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G2

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern=S3b2 G2 mcp/tests/examShapeRecord.test.ts`.

Broken, exit 1:

```text
not ok 1 - S3b2 G2 explicit replaces derived and explicit, with independent chooser and time
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b2 G2 explicit replaces derived and explicit, with independent chooser and time
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G3

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern=S3b2 G3 mcp/tests/examShapeRecord.test.ts`.

Broken, exit 1:

```text
not ok 1 - S3b2 G3 profile edits do not reshape either source
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b2 G3 profile edits do not reshape either source
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G4

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern=S3b2 G4 mcp/tests/examShapeRecord.test.ts`.

Broken, exit 1:

```text
not ok 1 - S3b2 G4 stored S3b1 shape without source reads derived without rewriting
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b2 G4 stored S3b1 shape without source reads derived without rewriting
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G5

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern=S3b2 G1 G2 G5 mcp/tests/examOverviewEndpoint.test.ts`.

Broken, exit 1:

```text
not ok 1 - S3b2 G1 G2 G5 explicit pick replaces derived, survives overview, writes only the scope
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b2 G1 G2 G5 explicit pick replaces derived, survives overview, writes only the scope
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G6

Working directory: `ui`. Command: `node --import tsx --test --test-name-pattern=S3b2 G6 tests/followingPicker.test.tsx`.

Broken, exit 1:

```text
not ok 1 - S3b2 G6 picker and projection never infer scope from scheduling
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b2 G6 picker and projection never infer scope from scheduling
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G7

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern=S3b1 G8 mcp/tests/examOverviewEndpoint.test.ts`.

Broken, exit 1:

```text
not ok 1 - S3b1 G8 an unconfirmed shape create serves the unshaped overview and retries next open
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b1 G8 an unconfirmed shape create serves the unshaped overview and retries next open
# tests 1
# pass 1
# fail 0
# skipped 0
```

### G8

Working directory: `ui`. Command: `node --import tsx --test --test-name-pattern=clinical-graph requests share tests/clinicalGraphRouting.test.tsx`.

Broken, exit 1:

```text
not ok 1 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:

```text
ok 1 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G9 mutation proof

G9a changes the picker failure status to `role="alert"`. G9b silently maps the failed initial read to an empty list. Both include HTTP failure and an unrecognized response shape. Each mutant was restored before the next run. Reproduction: `python3 docs/build-log/followup-s3b2-picker/proof/mutations-g9.py`.

### G9a

Working directory: `ui`. Command: `node --import tsx --test --test-name-pattern=S3b2 G9a tests/examOverviewBoard.test.tsx`.

Broken, exit 1:

```text
not ok 1 - S3b2 G9a failed previous-exams read preserves the chart alert count
not ok 2 - S3b2 G9a unrecognized previous-exams read preserves the chart alert count
# tests 2
# pass 0
# fail 2
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b2 G9a failed previous-exams read preserves the chart alert count
ok 2 - S3b2 G9a unrecognized previous-exams read preserves the chart alert count
# tests 2
# pass 2
# fail 0
# skipped 0
```

### G9b

Working directory: `ui`. Command: `node --import tsx --test --test-name-pattern=S3b2 G9b tests/followingPicker.test.tsx`.

Broken, exit 1:

```text
not ok 1 - S3b2 G9b failed history visibly fails inside picker while template and Nothing to follow work
not ok 2 - S3b2 G9b unrecognized history visibly fails inside picker while template and Nothing to follow work
# tests 2
# pass 0
# fail 2
# skipped 0
```

Restored, exit 0:

```text
ok 1 - S3b2 G9b failed history visibly fails inside picker while template and Nothing to follow work
ok 2 - S3b2 G9b unrecognized history visibly fails inside picker while template and Nothing to follow work
# tests 2
# pass 2
# fail 0
# skipped 0
```

## Real-stack proofs 1–5

Task project `odos-s3b2-proof`; local synthetic patient only. [browser-after.json](browser-after.json) records actual scope responses and mutation requests at both widths. [browser-g9.json](browser-g9.json) records all four fault-injection cases.

1. Both prior diagnosed visits are offered, most recent first. Follow this writes the office template and an explicit frozen glaucoma profile; the board opens its lines. Screenshots: `screenshots/1440-picker.png`, `screenshots/390-picker.png`, `screenshots/1440-picked-board.png`, `screenshots/390-picked-board.png`.
2. Browser reload and another overview request leave the full explicit record unchanged (`reloadUnchanged` and `subsequentOverviewUnchanged` are true at both widths).
3. Nothing to follow stores explicit office-visit with empty profilesApplied and sectionsOpen. Screenshots: `screenshots/1440-nothing-board.png`, `screenshots/390-nothing-board.png`.
4. The actual S3b-1-created records have no stored source, parse as derived, and are replaced by the deliberate explicit picks. See the exact historical records below.
5. Full suites, types, preflight and production builds passed as counted above.

G9 live proof uses browser interception for just the optional previous-exams response (HTTP 503 or a generic Bundle), while the chart and writes use real services. At each width and for each failure, chart alerts stay **0 → 0**, the status is visible, empty-history wording is absent, Comprehensive can be selected, and Nothing to follow successfully writes through the endpoint. Screenshots: `screenshots/1440-read-failed.png`, `screenshots/1440-read-unrecognized.png`, `screenshots/390-read-failed.png`, `screenshots/390-read-unrecognized.png`.

Base screenshots remain `screenshots/1440-before.png` and `screenshots/390-before.png`, with [browser-before.json](browser-before.json). Base and candidate were built and served sequentially from this task's isolated worktree and verified task-owned port; no running revision was switched and no other agent's server was used. The candidate was built while HEAD was the base with uncommitted source. [source-hashes.json](source-hashes.json) binds the four production files to the committed contents; [served-identity.json](served-identity.json) records the served asset hashes and image digest. This is author proof of those bytes, not an independent exact-head evaluation.

## Stored JSON before and after

[stored-records.json](stored-records.json) contains the actual persisted Basic JSON for **six versioned records**: before, after Follow this, and after Nothing to follow at both widths. Those were read by their recorded FHIR history version, so later fault-injection clicks do not replace the evidence. Each includes the parsed current-store result.

The before records' shapes have profilesApplied `[]`, sectionsOpen `[]`, shapedAt, and **no source**. Parsing returns all existing fields unchanged plus `source: "derived"`; the read does not rewrite the record. After Follow this, the shape is `source: "explicit"`, chosenBy is the synthetic Practitioner, chosenAt equals the pick timestamp, and the frozen profile is glaucoma version 1. After Nothing, source remains explicit, scope is office-visit, and both profile/section arrays are empty. Exact chooser references, timestamps, version IDs and write tokens are in the JSON file.

The recorded picker mutation is solely `PUT /clinical-graph/encounters/{id}/exam-scope`; server mutation spies independently reject any Condition, finding, plan or charge write. Source-free **unshaped** legacy rows remain unshaped, as the retained S3b-1 guards require.

## CodeRabbit fixback after the first published head

CodeRabbit reviewed `3c87b422d34e145d21b15cd9f99f1d0fd6acba35` and found one minor issue: a deleted prior Encounter/Condition fell through to the generic "Encounter was not found" response. Source reads now map only 404/410 to the existing stale-selection 409; authorization and other failures propagate to their existing responses. The catch is scoped to those two reads, so a missing current encounter still returns 404. Only the allowed endpoint/test files changed.

The final full MCP rerun passed **6,135 / 6,190 total, 0 fail, 55 skip** (two tests added by this fixback).

Two regression tests cover both source types, both missing statuses, 403, 503 and the current encounter. [review-fixback.json](review-fixback.json) quotes the red/green outputs. The missing-source test failed before the fix (1 fail, 1 pass), then both tests passed. Broadening the catch to swallow every error failed the authorization/outage test (1 fail), and restoring it passed (1 pass). Focused server tests increased **70 → 72 pass**, with 0 failures; MCP typecheck and preflight passed again.

The real-stack screenshots and historical records above bind to the first published head `3c87b422`, whose four production hashes remain in source-hashes.json. The sole subsequent production delta is this missing-source error classification; its source hashes are in [fixback-source-hashes.json](fixback-source-hashes.json). No new real-stack screenshot is claimed for that delta. The UI and success paths are unchanged; the regression tests exercise the changed failure path.

## Cleanup, limits and follow-ups

Task containers and app processes stopped, volumes retained. Final `docker ps --format '{{.Names}}\t{{.Status}}'` output (all remaining containers belong to other tasks):

```text
vf-prac1b-walk-db	Up 46 hours
```

No outside-allowlist file was edited or is needed. `git diff -- ui/tests/findingSectionGroups.test.tsx ui/tests/clinicalGraphRouting.test.tsx` is empty. No decisions/INDEX update, Mandate 14 ledger row, or cross-repo change was needed. Existing narrow-screen header clipping is visible in the base; the new picker and status fit at 390 pixels.

Automatic CodeRabbit/PR-Agent results are collected on the PR after publication; they do not replace independent evaluation. No merge or production deployment is authorized here. The evaluator must assess the actual diff and the limits of the skipped live suite.

⚠️ NOT EVALUATED — hand to Claude Opus 5, high effort, for independent evaluation before merge. Codex wrote it and cannot supply its own PASS.

needs-review
