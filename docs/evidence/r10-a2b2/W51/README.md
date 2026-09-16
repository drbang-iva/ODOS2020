# W51 — legacy picker request boundary (kickoff rev 3.6)

DiagnosisPicker production source is byte-identical to A2b.1 `6025d836`; no linkMode prop remains. The new request tests mount the real default picker for ocular_health and cup_disc_ratio with candidates containing supportingFacts.

Mutation: replace its submitDiagnosisPick import/call with submitDiagnosisPickResult, adding a fresh commandId and the selected candidate supportingFacts. Both assertions that the request omits supportingFacts fail: **2 tests, 0 pass, 2 fail** (`red.txt`). Restore: **2 tests, 2 pass, 0 fail** (`green.txt`). Command from ui/: `node --import tsx --test --test-name-pattern=W51 tests/r10DiagnosisSurfaces.test.tsx`.

The legacy picker load-error test now preserves its original error text. The generic Suggestions unavailable requirement is proven on DiagnosisWorkspace by W49-workspace. Historical surfaces/W49-candidates logs describe the superseded picker-label implementation, not a guard claimed for the final source. All mutations restored.
