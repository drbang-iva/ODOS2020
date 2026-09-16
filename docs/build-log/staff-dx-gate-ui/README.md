# STAFF-DX-GATE UI implementation evidence

Base: `40c19a9e442015e1d32396958b661394318713d2`.
Branch: `drbang-iva/dx-gate-ui2`.
The previous `staff-dx-gate-ui` worktree was preserved. Its unfinished test changes and original baseline/red outputs were copied before implementation.

## Result

Diagnosis edits consume the server's `canWriteDiagnosis` capability and refuse false or absent capability. Quick-list pins retain `canWrite`; finding grade/laterality retain ordinary Observation write permission. Assessment refreshes capability through a fresh catalog request while keeping its existing catalog-row cache. Previously pulled diagnoses remain selectable. Clear checks its preview before asking for confirmation. Undo checks each slot and receives capability outside the persisted ledger through the encounter route, header, and entry sheet.

Problem status delegates to `PUT /clinical-graph/encounters/:encounterId/diagnoses/:conditionId/problem-status`, supplying `expectedEncounterVersion`; the server owns the write and Provenance. The existing pure patch-construction coverage remains.

## Checks and real results

Commands ran from the task worktree's `ui` directory.

- Inherited gate RED: `node --import tsx --test --test-concurrency=1 --test-name-pattern=STAFF-DX-GATE tests/diagnosisWorkspace.test.tsx tests/diagnosisCarryForward.test.tsx tests/diagnosisDemotionImpact.test.tsx` — 17 tests, 5 pass, 12 fail (`resumed-red.tap`).
- Clear/Undo RED: the same command pattern with `tests/encounterVoid.test.tsx tests/encounterUndo.test.tsx` — 22 tests, 13 pass, 9 fail (`clear-undo-red.tap`).
- Problem-status RED: `node --import tsx --test --test-name-pattern='STAFF-DX-GATE problem status' tests/diagnosisRankSafety.test.tsx` — 1 test, 0 pass, 1 fail (`problem-status-red.tap`).
- Final focused regression: `node --import tsx --test --test-concurrency=1 tests/diagnosis*.test.tsx tests/encounterVoid.test.tsx tests/encounterUndo.test.tsx tests/entranceBattery.test.tsx tests/engageSheet.test.tsx tests/customSections.test.tsx tests/planAuthoring.test.tsx tests/examOverviewBoard.test.tsx tests/referralCompose.test.tsx tests/protocolScope.test.tsx tests/protocolAuthoring.test.tsx tests/pretestVitals.test.tsx` — **459 tests, 459 pass, 0 fail** (`focused-green.tap`). Existing React multiple-renderer warnings are present; no failed assertions.
- Typecheck: `./node_modules/.bin/tsc --noEmit --skipLibCheck` — exit 0 (`typecheck.txt`).
- Restored guard run: `node --import tsx --test --test-concurrency=1 --test-name-pattern=STAFF-DX-GATE tests/diagnosisWorkspace.test.tsx tests/diagnosisCarryForward.test.tsx tests/diagnosisDemotionImpact.test.tsx tests/diagnosisRankSafety.test.tsx tests/encounterVoid.test.tsx tests/encounterUndo.test.tsx tests/examOverviewBoard.test.tsx` — **47 tests, 47 pass, 0 fail** (`mutations-restored.tap`).

## Author mutation proof

Mutations ran in the separate disposable `staff-dx-gate-ui2-mut` worktree. Every replacement was asserted present before execution. Each original source was restored in a finally block; the entire UI diff hash matched before and after (`mutations.json`). The restored guard run above used those restored sources.

| Mutation | Result |
|---|---|
| Treat Workspace diagnosis capability as always true | 3 tests, 1 pass, 2 fail |
| Bypass diagnosis permission in the finding mutation handler | 3 tests, 1 pass, 2 fail |
| Replace Assessment's fresh permission request with cached rows and allowed=true | 3 tests, 0 pass, 3 fail |
| Drop capability returned by a void result in EncounterCharting | 3 tests, 0 pass, 3 fail |

The route tests exercise the actual `EncounterCharting` component, initial ledger capability, Observation-only undo, capability refresh from the undo response, and capability refresh from a no-op void response. They use synthetic HTTP/FHIR fixtures. They do not prove live AccessPolicy enforcement or the deployed browser artifact; the parent task owns integrated synthetic live proof.

## Exact changes to existing assertions

- `problem status Provenance directly targets the Patient, Encounter, and affected Condition` was replaced by `STAFF-DX-GATE problem status delegates versioned writes and Provenance to the diagnosis endpoint`. The former assertions on a client-created Provenance target list and UPDATE code moved to the server's responsibility. The replacement asserts the returned Encounter, exactly one request, the scoped endpoint, PUT, and `{ problemStatus: "stable-chronic", expectedEncounterVersion: "7" }`. The pure patch construction test is unchanged.
- `readEncounterUndoLedger fetches the ledger, and answers the empty ledger for a non-ledger body or a failed request` now reads `response.ledger` for the same successful and three empty-ledger assertions because current capability is carried in the outer response. Ledger expectations themselves are unchanged.
- `count honesty: Dilation section preview, confirm, void result, section subtotal, and stored statuses all agree` and `count honesty: whole-visit preview, confirm, void result, section subtotals, and stored statuses all agree` now include the parsed boolean `canWriteDiagnosis` in the callback-result equality. Counts, resource enumeration, section subtotals, and stored-status assertions are unchanged.
- Other existing assertions are unchanged. Authorized-path fixtures explicitly declare `canWriteDiagnosis: true`; existing PreviousExams render fixtures pass the permission prop. New denial tests explicitly override it with false or undefined.

## Fixture-only changes by existing test/helper name

### diagnosisWorkspace.test.tsx

- diagnosis door pages encounter Conditions and renders Possible provenance plus confirmed rank drift
- excluded Encounter diagnosis references expose a disabled reorder explanation naming the condition
- server-cleaned three-minus-one state renders two rows and submits their exact reorder
- Find dx searches the eligible catalog beyond bounded Common diagnoses
- selected pending family renders warning badges and re-stages from the header control
- bilateral eyelid diagnoses render both resolved codes while legacy unspecified-eyelid codes remain visible
- eyelid laterality edit fails closed before FHIR writes when its declared catalog row is unavailable
- selected diagnosis fails closed to edited when carry integrity is uncertain
- edited diagnosis carry is named distinctly without unchanged aging
- a failed same-diagnosis verification refresh cannot retain stale carry assertions
- tray leaf and family suggestions reuse the existing scope and stage prompt and persist only after explicit scope
- same-encounter finding refresh reloads diagnosis candidates for newly charted findings
- stagedWorkspaceFetch (shared fixture helper)
- workspaceRaceFetch (shared fixture helper)
- raceFindingsPayload (shared fixture helper)
- findingsPayload (shared fixture helper)

### diagnosisCarryForward.test.tsx

- previous exams loads four encounters automatically, keeps them through paging failure, and retries the same cursor
- previous exams renders the exact plain empty state
- visible paging sentinel starts one request per cursor and ignores repeated observer delivery
- consumed observer cursors cannot replay or restore paging after a terminal next page
- encounter changes ignore stale previous-exam responses
- checked prior diagnoses select without POST while unchecked pulls are idempotent and row-specific
- a stale pull cannot release the same row lock owned by the next encounter generation
- a deferred pull settling after true unmount schedules no state update warning
- carryFindingsPayload (shared fixture helper)

### diagnosisDemotionImpact.test.tsx

- DiagnosisPicker surfaces a stranded-charge warning after its variable Possible action
- AssessmentSection surfaces a stranded-charge warning after its variable Discard action

### customSections.test.tsx

- saved ocular-health findings expose real scoped diagnosis suggestions and only explicit taps propose or retract
- fresh ocular-health history restores scoped diagnosis suggestions without a save

### entranceBattery.test.tsx

- changing a reloaded Field Defect hides the stale diagnosis until the descriptor is saved
- suppressed visual-field diagnosis stays visible and the override reveals clinician actions
- structure diagnosis rail keeps full search when the persisted finding has no seeded suggestions
- bilateral structure catalog picks stay scoped to the eye where the search selection was made
- structure proposal toggles find provisional Conditions beyond the first FHIR search page

`examOverviewBoard.test.tsx` extends `renderEncounter` to pass a configurable capability in ledger, void, and undo responses; existing tests omit it and retain Observation-only behavior. No existing expectation changes there.

## Handoff limits

This is author verification, not an independent evaluation. No UI deployment or live authorization verdict is claimed. No medical codes or artifact URLs were introduced; fixtures reuse existing terminology. No decision or Mandate 14 ledger changes were required. No MCP sources, roles, or App.tsx were edited in this UI task. Backend integration and independent Fable/Opus evaluation remain with the parent task.
