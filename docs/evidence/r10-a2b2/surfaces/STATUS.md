# Overlay, count, picker evidence

Owned implementation: `EncounterFindingOverlay.tsx`, `EncounterCharting.tsx` (count load only), `DiagnosisPicker.tsx`.

- Overlay explicitly renders `Findings unavailable` for typed unavailable and rejected loads; uses server row identity/kind.
- Count maps typed unavailable to undefined, which the existing chart bar renders as `Unassigned unavailable`.
- Candidate failures render `Suggestions unavailable`.
- Picker has `linkMode` default legacy; its existing submitDiagnosisPick call and applied-result/error handling remain unchanged under rev 3.5.

`cd ui && node --import tsx --test tests/r10DiagnosisSurfaces.test.tsx`: 9 tests, 5 pass, 4 TODO, 0 fail. The count test mounts the full EncounterCharting scene against a synthetic unavailable findings response. Picker tests exercise real transport calls for ocular_health and cup_disc_ratio scopes; neither sends supportingFacts or commandId.

`cd ui && node --import tsx --test tests/diagnosisDemotionImpact.test.tsx`: 10 tests, 10 pass, 0 fail. Existing assertions unchanged.

## Mandate 17

- W49 overlay: suppress unavailable rendering. Targeted suite exits 1; restored suite exits 0.
- W49 count: turn typed unavailable into zero. Full scene assertion exits 1; restored suite exits 0.
- W49 candidates: suppress load error. Targeted suite exits 1; restored suite exits 0.
- W51: real legacy transport tests pass. Required default-to-facts mutant is pending operator adjudication because rev 3.5 freezes the legacy submit call, so facts/default changes cannot affect its request body.

Exact outputs: `W49-overlay-red.tap`, `W49-count-red.tap`, `W49-candidates-red.tap`, `green.tap`.

## A3

T15, T16, T17 UI and T18 are named `{ todo: "R10 A3" }` tests in the manifest's `.ts` file. The `.tsx` surfaces suite imports that file so npm's `.test.tsx` glob actually executes these slots. Current slot assertions are migration-readiness source checks, not completed A3 behavioral coverage. The independent A3 gate directly executes `.ts` through its tsx loader and reports all four as TODO rather than absent. T4/T5/T6/T21/T22 UI remain absent (outside this subtask's authorized slots). See `a3-gate.txt`.

No existing assertions changed; no V/W assertion migration rows needed for this subtask. New tests map to W49/W51 and named A3 slots. No commits, pushes, Docker processes or account operations by this subtask. NOT EVALUATED.
