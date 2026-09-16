# Overlay, count and legacy picker evidence (rev 3.6)

Production changes: EncounterFindingOverlay and EncounterCharting count load only. DiagnosisPicker is byte-identical to A2b.1; it has no linkMode prop and still uses the original throwing submitDiagnosisPick.

Overlay renders Findings unavailable for typed unavailable and rejected loads, using server row identity. Count maps unavailable to undefined, which the existing chart bar renders as Unassigned unavailable. Workspace candidate failure renders Suggestions unavailable; legacy Picker retains its original error text.

From ui/: `node --import tsx --test tests/r10DiagnosisSurfaces.test.tsx`: **9 tests, 5 pass, 4 A3 TODO, 0 fail**. The count test mounts the full EncounterCharting scene with synthetic transport. Picker tests exercise real requests for ocular_health and cup_disc_ratio; neither sends supportingFacts or commandId. The demotion suite now has **11/11**, including W54's added failed-pick test.

## Guards

W49 overlay and count mutations each produced 2 pass/1 fail in the then-targeted three-test suite; restored final suite is 5 pass/4 TODO. Workspace W49 separately proves candidate unavailability. Historical W49-candidates-red.tap describes the superseded generic-picker-error implementation and is not claimed for final production. W51's approved API/supports mutation is recorded in ../W51: 0/2 pass red, 2/2 green.

## A3

T15, T16, T17 UI and T18 are real component tests marked `{ todo: "R10 A3" }` in r10A3ReleaseScenarios.test.ts. They mount the legacy section/picker/Assessment components and fail their future-contract assertions today. The surfaces .tsx suite imports them so the package glob executes them. The gate reports these four as TODO rather than absent. Other A3 UI slots remain outside this slice. Historical a3-gate.txt is superseded by ../checks/a3-rev36.txt.

Existing grouping assertions are mapped in ../existing-assertions.md. New surface guards map to W49/W51; W54 is recorded separately. NOT EVALUATED.
