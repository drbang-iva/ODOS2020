# S3b-2 picker — BLOCKED author bundle

Base: `15a0c0e951844aa0fe4e6aeee125742516a8baf6`, freshly fetched from origin.
Branch: `drbang-iva/followup-s3b2-picker`.
Coder: Codex. Evaluator: Claude Opus 5, high effort. NOT EVALUATED.

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

## Stop required by kickoff rule 3

Four full UI-suite failures need valid previous-exams fixture responses in **`ui/tests/findingSectionGroups.test.tsx`**, which is outside the allowlist. That file was read only and remains unchanged. No assertions were removed or weakened. The picker correctly treats the fixture's generic FHIR Bundle as an invalid PreviousExamsPage and renders an additional alert. These existing tests count all alerts in the mounted chart:

- `EncounterCharting fails open when the section-group catalog returns 500` — line 399, expected one alert, found two.
- `S1 G7 409 race refetches pins and preserves specific message` — line 578, expected one alert, found two.
- `S1 catalog freshness ignores older success after a newer save refresh` — line 615, expected zero alerts, found one.
- `S1 catalog freshness ignores older failure after a newer save refresh` — line 615, expected zero alerts, found one.

Needed expansion: permit only valid `/previous-exams` read responses in that file's chart fixtures, retaining every assertion. Suppressing a real picker error to satisfy those global alert assertions would hide the malformed reader response.

Implementation stopped when the excluded-file dependency was identified. No commit, push, PR, merge, or deployment. PR URL: none. HEAD remains `15a0c0e951844aa0fe4e6aeee125742516a8baf6`; candidate is uncommitted.

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

| Check | Base | Candidate |
|---|---|---|
| `npm --prefix ui test` | 1,816 tests; 1,816 pass; 0 fail; 0 skip | 1,820 tests; 1,816 pass; 4 fail; 0 skip |
| Full MCP command below | 6,175 tests; 6,120 pass; 0 fail; 55 skip | 6,188 tests; 6,133 pass; 0 fail; 55 skip |
| `npx tsc --noEmit` at root, ui and mcp | all exit 0 | all exit 0 |
| `npm run preflight` | 0 warnings; 0 hard blocks | 0 warnings; 0 hard blocks |
| Production MCP/UI builds | exit 0 | exit 0 |
| `git diff --check` | clean | clean |

Totals: UI **1,816 + 4 = 1,820**; MCP **6,175 + 13 = 6,188**.

```sh
ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:28836/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test
```

The complete default MCP suite ran against task-owned Postgres. The explicit opt-out preserves the existing credential-gated live skips; this does **not** claim a live authorization verdict. Of the 55 skips, the wrapper identifies 47 as unconfigured live-stack tests.

The initial pre-stack MCP run failed with database connections refused: 6,176 tests, 6,066 pass, 43 fail, 67 skipped (one extra suite-level failure). It was superseded by the configured baseline above, without source changes. Candidate preflight initially rejected six hardcoded styles in the new picker; replacing them with existing appearance tokens cleared the block within the allowed file.

Focused server command:
`node --import tsx --test mcp/tests/examOverviewEndpoint.test.ts mcp/tests/examShapeRecord.test.ts mcp/tests/examScopeStore.test.ts mcp/tests/historyRos.test.ts`

Result: **70 tests, 70 pass, 0 fail**. New store tests first failed 5/5; new endpoint tests first failed 8/8. UI integration plus S2a checks: 12 tests, 12 pass, 0 fail after the chart fixture isolated requests made by the pick from the unrelated chart-open void preview.

## G1–G8 mutation proof

Each mutant was applied alone, executed, restored in a finally block, and executed again. Reproduction: `python3 docs/build-log/followup-s3b2-picker/proof/mutations.py`. Exact per-command summaries are in `mutations.json` and quoted below. G1 directly exercises the store boundary as well as a separate endpoint survival test; the overview's existing-row optimization is not mistaken for the store guard. G6 proves the prohibited scheduling read is absent by source inspection; it is not a live scheduling integration claim.

### G1

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern='S3b2 G1' mcp/tests/examShapeRecord.test.ts`.

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

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern='S3b2 G2' mcp/tests/examShapeRecord.test.ts`.

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

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern='S3b2 G3' mcp/tests/examShapeRecord.test.ts`.

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

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern='S3b2 G4' mcp/tests/examShapeRecord.test.ts`.

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

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern='S3b2 G1 G2 G5' mcp/tests/examOverviewEndpoint.test.ts`.

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

Working directory: `ui`. Command: `node --import tsx --test --test-name-pattern='S3b2 G6' tests/followingPicker.test.tsx`.

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

Working directory: `.`. Command: `node --import tsx --test --test-name-pattern='S3b1 G8' mcp/tests/examOverviewEndpoint.test.ts`.

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

Working directory: `ui`. Command: `node --import tsx --test --test-name-pattern='clinical-graph requests share' tests/clinicalGraphRouting.test.tsx`.

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

## Real-stack proof 1–5 and stored records

Base app was built and served from the pinned base before the candidate was rebuilt. Synthetic bootstrap, two diagnosed prior visits and two current visits were created. Base browser captures passed at both widths:

- `screenshots/1440-before.png`
- `screenshots/390-before.png`
- `browser-before.json` contains the scope GET results before the picker existed.

**Proofs 1–4 remain NOT COMPLETED against the candidate real stack.** The excluded-file stop occurred before candidate browser execution. No after screenshots or real-stack before/after stored Basic comparison is claimed. The candidate browser script is prepared but has not run. The candidate build completed; it was not served for acceptance proof.

Proof 5: full suites completed with the four UI failures above; types and preflight pass. Existing assertion sets were retained.

G4 demonstrates that a stored S3b-1 *shape* lacking source parses to the same profilesApplied, sectionsOpen, shapedAt, scope and version, plus `source: "derived"`; it performs no rewrite. Unshaped legacy scope rows retain their old shape-free representation and are not retro-shaped. No final stored explicit JSON was captured from the real stack before the stop; unit tests cover the write and chooser/time fields.

## Cleanup, risk and continuation

Task project: `odos-s3b2-proof`. All its containers stopped; volumes retained. The unrelated container was left running. Final command: `docker ps --format '{{.Names}}\t{{.Status}}'`:

```text
vf-prac1b-walk-db    Up 46 hours
```

No outside-allowlist file was edited. `git diff -- ui/tests/findingSectionGroups.test.tsx` returned no output.

Remaining work after the named scope expansion: repair only fixture responses, rerun full UI and final checks, finish candidate real-stack proof at both widths with stored records, inspect screenshots, seal the implementation and evidence, open the PR, and collect exact-head bot review. Independent evaluation belongs to Claude Opus 5, high effort; author proof is not an evaluation. No decisions/INDEX or Mandate 14 ledger update was needed. No cross-repo files changed.

NOT EVALUATED — Codex authored the changes; Claude must independently evaluate before merge.

blocked
